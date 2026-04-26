#!/usr/bin/env node
/**
 * agent-comms — A2A communication server.
 *
 * Receives context pushes from other coding agents (Claude Code, Codex, Cursor,
 * peer instances) over the local network or Tailscale.
 *
 * Three auth modes (set via AGENT_COMMS_MODE):
 *   localhost  — only 127.0.0.1 may push (no token required)
 *   lan        — anywhere on the LAN with the bearer token
 *   tailnet    — anywhere on your tailnet with the bearer token
 *
 * Endpoints:
 *   POST /context/push       receive a context push
 *   GET  /a2a-connect        human-friendly connect page (browser)
 *   GET  /a2a-connect.json   machine-readable connect metadata
 *   GET  /a2a/recent         last N pushes (powers the activity feed)
 *   GET  /health             liveness check
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const state = require('./lib/state');
const pairing = require('./lib/pairing');
const discovery = require('./lib/discovery');

// ── env loading (idempotent: skip vars already in process.env) ──
const envPath = path.join(os.homedir(), '.claude', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^"(.*)"$/, '$1');
    }
  }
}
// Also accept a project-local .env so users can run without touching ~/.claude/.env
const localEnv = path.join(__dirname, '.env');
if (fs.existsSync(localEnv)) {
  for (const line of fs.readFileSync(localEnv, 'utf-8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^"(.*)"$/, '$1');
    }
  }
}

const PORT = parseInt(process.env.AGENT_COMMS_PORT || '8090', 10);
const MODE = (process.env.AGENT_COMMS_MODE || 'localhost').toLowerCase();
const TOKEN = process.env.AGENT_COMMS_TOKEN || '';
const INBOUND_DIR = process.env.AGENT_COMMS_INBOUND_DIR
  || path.join(os.homedir(), '.agent-comms', 'inbound');
const NOTIFY_TELEGRAM = (process.env.AGENT_COMMS_NOTIFY || 'off').toLowerCase();
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
// Pull support — when enabled, GET /context/pull returns matching items.
// Default off so push-only deployments don't accidentally expose stored content.
const PULL_ENABLED = String(process.env.AGENT_COMMS_PULL_ENABLED || 'false').toLowerCase() === 'true';

if (!['localhost', 'lan', 'tailnet'].includes(MODE)) {
  console.error(`[FATAL] AGENT_COMMS_MODE must be one of: localhost, lan, tailnet (got "${MODE}")`);
  process.exit(1);
}
if (MODE !== 'localhost' && !TOKEN) {
  console.error(`[FATAL] AGENT_COMMS_MODE=${MODE} requires AGENT_COMMS_TOKEN to be set`);
  console.error(`        Generate one with: openssl rand -hex 32`);
  process.exit(1);
}

fs.mkdirSync(INBOUND_DIR, { recursive: true });

// Pairing state — identity + pairing code are auto-created on first boot.
state.ensureDir();
const IDENTITY = state.ensureIdentity(os.hostname());
if (!state.readPairingCode()) {
  state.writePairingCode(pairing.generateCode());
}

console.log(`[boot] agent-comms starting`);
console.log(`[boot] mode=${MODE} port=${PORT} inbound=${INBOUND_DIR}`);
console.log(`[boot] auth=${MODE === 'localhost' ? 'none (localhost-only)' : 'bearer token required'}`);
console.log(`[boot] pull=${PULL_ENABLED ? 'enabled (GET /context/pull)' : 'disabled (push-only)'}`);
console.log(`[boot] identity=${IDENTITY.display_name} (${IDENTITY.instance_id.slice(0, 8)}…)`);
console.log(`[boot] pairing-code on file: ${state.readPairingCode()}`);

// ── auth middleware ──
function requireAuth(req, res, next) {
  if (MODE === 'localhost') {
    if (req.headers['x-forwarded-for']) {
      console.log(`[auth] Rejected proxied request in localhost mode`);
      return res.status(403).json({ error: 'localhost mode rejects proxied requests' });
    }
    const peer = (req.connection && req.connection.remoteAddress) || '';
    const ip = peer.replace(/^::ffff:/, '');
    if (ip !== '127.0.0.1' && ip !== '::1') {
      console.log(`[auth] Rejected non-local request from ${ip}`);
      return res.status(403).json({ error: 'localhost mode — only 127.0.0.1 may push' });
    }
    return next();
  }
  // lan / tailnet: require bearer
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== TOKEN) {
    console.log(`[auth] Rejected push — invalid bearer token`);
    return res.status(401).json({ error: 'Invalid or missing bearer token' });
  }
  next();
}

function clientIp(req) {
  const peer = (req.connection && req.connection.remoteAddress) || '';
  return peer.replace(/^::ffff:/, '');
}

function isLocalRequest(req) {
  if (req.headers['x-forwarded-for']) return false;
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1';
}

// Localhost-only — for pairing management endpoints (pending/accept/block/code).
// These touch sensitive state (handing out the bearer token) and have no
// business being callable from the LAN.
function requireLocal(req, res, next) {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ error: 'this endpoint is localhost-only' });
  }
  next();
}

// ── helpers ──
function slugify(s, maxLen = 60) {
  return String(s || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen) || 'untitled';
}

let _pushCount = 0;

async function notifyTelegram(text) {
  if (NOTIFY_TELEGRAM === 'off') return;
  if (NOTIFY_TELEGRAM === 'first50' && _pushCount > 50) return;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error(`[notify] Telegram failed: ${e.message}`);
  }
}

// ── express app ──
const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'agent-comms',
    mode: MODE,
    timestamp: new Date().toISOString(),
  });
});

app.post('/context/push', requireAuth, async (req, res) => {
  const {
    from = 'unknown-agent',
    topic = 'general',
    content = '',
    tags = [],
    scope = 'archive',
    expires = null,
    id = null,
    to = null,         // optional recipient agent name; absent = broadcast
  } = req.body || {};

  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content (string) is required' });
  }
  if (!['archive', 'active', 'memory'].includes(scope)) {
    return res.status(400).json({ error: 'scope must be archive | active | memory' });
  }

  const fromSlug = slugify(from);
  const topicSlug = slugify(topic);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const idSuffix = id ? `-${slugify(id, 24)}` : `-${now.getTime().toString(36)}`;
  const filename = `${dateStr}-${topicSlug}${idSuffix}.md`;

  const dir = path.join(INBOUND_DIR, fromSlug);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);

  const frontmatter = [
    '---',
    `name: "${topic} (from ${from})"`,
    `source: agent-comms-inbound`,
    `from: ${from}`,
    to ? `to: ${to}` : null,
    `topic: ${topic}`,
    `scope: ${scope}`,
    `tags: [${(Array.isArray(tags) ? tags : []).map(t => JSON.stringify(String(t))).join(', ')}]`,
    `received_at: ${now.toISOString()}`,
    expires ? `expires: ${expires}` : null,
    id ? `id: ${id}` : null,
    '---',
    '',
  ].filter(Boolean).join('\n');

  fs.writeFileSync(filePath, frontmatter + content.trim() + '\n');

  _pushCount++;
  const preview = content.length > 240 ? content.slice(0, 240) + '…' : content;
  notifyTelegram(
    `📥 Context received from \`${from}\`\n*Topic:* ${topic}\n*Scope:* ${scope}${
      tags.length ? `\n*Tags:* ${tags.join(', ')}` : ''
    }\n\n${preview}`
  );

  console.log(`[push] from=${from} topic=${topic} scope=${scope} → ${filePath}`);
  res.status(201).json({
    received: true,
    filed_at: path.relative(INBOUND_DIR, filePath),
    scope,
    indexed_within_seconds: 0,
  });
});

app.get('/a2a/recent', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 200);
  if (!fs.existsSync(INBOUND_DIR)) return res.json({ pushes: [] });
  const out = [];
  try {
    for (const fromDir of fs.readdirSync(INBOUND_DIR)) {
      const sub = path.join(INBOUND_DIR, fromDir);
      if (!fs.statSync(sub).isDirectory()) continue;
      for (const fname of fs.readdirSync(sub)) {
        if (!fname.endsWith('.md')) continue;
        const fp = path.join(sub, fname);
        const stat = fs.statSync(fp);
        out.push({ from: fromDir, file: fname, mtime: stat.mtimeMs });
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    res.json({ pushes: out.slice(0, limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Parse an inbound markdown file's frontmatter into a JS object ─────
// Tolerant: bad/missing frontmatter returns {} and the body is treated as content.
function parseFrontmatter(text) {
  const meta = {};
  let body = text;
  const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!fmMatch) return { meta, body };
  body = fmMatch[2];
  for (const raw of fmMatch[1].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // Strip surrounding quotes
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    // Parse simple [..] arrays (tags)
    if (/^\[.*\]$/.test(val)) {
      try { val = JSON.parse(val.replace(/'/g, '"')); }
      catch { val = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean); }
    }
    meta[key] = val;
  }
  return { meta, body: body.trim() };
}

// GET /context/pull — bidirectional fetch. Auth-required (same as push).
//
// Query params:
//   to       (string)  — only return items addressed to this agent (or broadcast)
//   from     (string)  — only return items from this sender
//   since    (ISO date) — only return items received_at >= since
//   topic    (string)  — exact match
//   limit    (int, default 50, max 200)
//   include  ("meta"|"content"; default "content") — content includes the body
//
// Trust model: bearer token is the trust line. The `to` filter is a
// CONVENIENCE for routing, NOT a security boundary — anyone with the token
// can change the query. Per-agent token scoping is a future enhancement.
app.get('/context/pull', requireAuth, (req, res) => {
  if (!PULL_ENABLED) {
    return res.status(404).json({
      error: 'Pull is not enabled on this server',
      hint: 'Set AGENT_COMMS_PULL_ENABLED=true and restart to enable bidirectional mode',
    });
  }

  const filterTo = req.query.to ? String(req.query.to) : null;
  const filterFrom = req.query.from ? String(req.query.from) : null;
  const filterTopic = req.query.topic ? String(req.query.topic) : null;
  const sinceRaw = req.query.since ? String(req.query.since) : null;
  const sinceMs = sinceRaw ? Date.parse(sinceRaw) : 0;
  if (sinceRaw && Number.isNaN(sinceMs)) {
    return res.status(400).json({ error: 'invalid since parameter (must be ISO date)' });
  }
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const includeContent = (req.query.include || 'content') !== 'meta';

  if (!fs.existsSync(INBOUND_DIR)) return res.json({ items: [], count: 0 });

  const matched = [];
  try {
    for (const fromDir of fs.readdirSync(INBOUND_DIR)) {
      const sub = path.join(INBOUND_DIR, fromDir);
      if (!fs.statSync(sub).isDirectory()) continue;
      if (filterFrom && filterFrom !== fromDir) continue;
      for (const fname of fs.readdirSync(sub)) {
        if (!fname.endsWith('.md')) continue;
        const fp = path.join(sub, fname);
        const stat = fs.statSync(fp);
        const text = fs.readFileSync(fp, 'utf-8');
        const { meta, body } = parseFrontmatter(text);

        // to filter: include items addressed to filterTo OR broadcast (no `to`)
        if (filterTo) {
          if (meta.to && meta.to !== filterTo) continue;
        }
        if (filterTopic && meta.topic !== filterTopic) continue;
        if (sinceMs) {
          const recvMs = meta.received_at ? Date.parse(meta.received_at) : stat.mtimeMs;
          if (recvMs < sinceMs) continue;
        }

        const item = {
          from: meta.from || fromDir,
          to: meta.to || null,
          topic: meta.topic || null,
          tags: meta.tags || [],
          scope: meta.scope || 'archive',
          received_at: meta.received_at || new Date(stat.mtimeMs).toISOString(),
          expires: meta.expires || null,
          id: meta.id || null,
          file: `${fromDir}/${fname}`,
        };
        if (includeContent) item.content = body;
        matched.push({ ...item, _mtime: stat.mtimeMs });
      }
    }
    matched.sort((a, b) => b._mtime - a._mtime);
    const items = matched.slice(0, limit).map(({ _mtime, ...rest }) => rest);
    res.json({ items, count: items.length });
  } catch (e) {
    console.error('[pull] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── pairing ────────────────────────────────────────────────────────
//
// Bluetooth-style PIN pairing: each agent-comms instance has a 6-word
// BIP-39 pairing code visible on its connect dashboard. To pair, an
// initiator runs `agent-comms discover` (UDP probe), reads the receiver's
// code (over Telegram, voice, paper — your trusted channel), and sends
// a pair-request with the code attached. If the code matches, the
// receiver queues a pending request that the local operator must
// explicitly accept.
//
// Endpoints:
//   GET  /a2a/code              localhost-only — show this machine's code
//   POST /a2a/code/rotate       localhost-only — regenerate the code
//   POST /a2a/pair-request      public — initiator sends code + identity
//   GET  /a2a/pair-status/:id   public — initiator polls for accept/block
//                               (locked to originating IP)
//   GET  /a2a/pending           localhost-only — list pending inbound
//   POST /a2a/accept/:id        localhost-only — accept a pending request
//   POST /a2a/block/:id         localhost-only — block + 24h cooldown
//   GET  /a2a/peers             localhost-only — list paired peers
//   POST /a2a/peers/:id/remove  localhost-only — unpair

app.get('/a2a/code', requireLocal, (req, res) => {
  res.json({
    code: state.readPairingCode(),
    instance_id: IDENTITY.instance_id,
    display_name: IDENTITY.display_name,
  });
});

app.post('/a2a/code/rotate', requireLocal, (req, res) => {
  const code = pairing.generateCode();
  state.writePairingCode(code);
  console.log(`[pairing] code rotated`);
  res.json({ code });
});

app.post('/a2a/pair-request', (req, res) => {
  const {
    from_id,
    from_name,
    from_endpoint,
    code,
    requested_rel,
    requested_expiry,
    requested_expires_at,
  } = req.body || {};

  if (!from_id || !from_name) {
    return res.status(400).json({ error: 'from_id and from_name are required' });
  }
  if (!pairing.isValidCode(code)) {
    return res.status(400).json({ error: 'code must be exactly 6 BIP-39 words' });
  }
  if (state.isBlocked(from_id)) {
    console.log(`[pair-request] rejected — instance ${from_id.slice(0, 8)} is blocked`);
    return res.status(403).json({ error: 'this instance is currently blocked' });
  }
  const ourCode = state.readPairingCode();
  if (!ourCode || !pairing.compareCodes(code, ourCode)) {
    console.log(`[pair-request] code mismatch from ${from_name}`);
    return res.status(401).json({ error: 'pairing code mismatch' });
  }
  const existing = state.findPeerByInstance(from_id);
  if (existing) {
    return res.status(409).json({
      error: 'already paired with this instance',
      hint: `remove peer "${existing.id}" first to re-pair`,
    });
  }

  const pendingId = crypto.randomUUID();
  const fromIp = clientIp(req);

  state.addPending({
    pending_id: pendingId,
    from_id,
    from_name,
    from_endpoint: from_endpoint || null,
    from_ip: fromIp,
    requested_rel: requested_rel || null,
    requested_expiry: requested_expiry || null,
    requested_expires_at: requested_expires_at || null,
    received_at: new Date().toISOString(),
  });

  console.log(`[pair-request] ${from_name} (${from_id.slice(0, 8)}) from ${fromIp} → pending ${pendingId.slice(0, 8)}`);
  notifyTelegram(
    `🤝 *Pair request*\nFrom: \`${from_name}\` (${fromIp})\nReview: \`agent-comms pending\``
  );

  res.status(202).json({
    received: true,
    pending_id: pendingId,
    receiver: {
      instance_id: IDENTITY.instance_id,
      display_name: IDENTITY.display_name,
    },
    next: 'poll GET /a2a/pair-status/' + pendingId + ' until status changes',
  });
});

// Initiator polls this. Locked to originating IP.
app.get('/a2a/pair-status/:id', (req, res) => {
  const pendingId = req.params.id;
  const ip = clientIp(req);
  const taken = state.takeResponse(pendingId, ip);
  if (taken) return res.json(taken);
  const stillPending = state.findPending(pendingId);
  if (stillPending) return res.json({ status: 'pending' });
  return res.status(404).json({ status: 'unknown', error: 'no such pair request (may have expired)' });
});

app.get('/a2a/pending', requireLocal, (req, res) => {
  res.json({ pending: state.readPending() });
});

app.post('/a2a/accept/:id', requireLocal, (req, res) => {
  const { rel, expiry, expires_at } = req.body || {};
  const pendingId = req.params.id;
  const item = state.findPending(pendingId);
  if (!item) return res.status(404).json({ error: 'pending request not found' });
  if (state.isBlocked(item.from_id)) {
    state.removePending(pendingId);
    return res.status(403).json({ error: 'instance is blocked' });
  }

  // Local id under which we'll store this peer (slugified display_name,
  // or fallback to 'peer-<instance prefix>'). Used by the operator in
  // future commands like `agent-comms peer remove <id>`.
  const slug = (item.from_name || 'peer')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const peerLocalId = slug || `peer-${item.from_id.slice(0, 8)}`;

  const tokenForPeer = TOKEN || '';
  const ourEndpoint = `${req.protocol}://${req.headers.host || `localhost:${PORT}`}`;

  const peerRecord = {
    instance_id: item.from_id,
    display_name: item.from_name,
    endpoint: item.from_endpoint || null,
    ip: item.from_ip,
    rel: rel || item.requested_rel || 'friend',
    paired_at: new Date().toISOString(),
    paired_via: 'lan-pairing-code',
    expiry_policy: expiry || item.requested_expiry || 'indefinite',
    expires_at: expires_at || item.requested_expires_at || null,
    single_shot_used: false,
  };
  state.addPeer(peerLocalId, peerRecord);
  state.removePending(pendingId);

  // Cache the response for the initiator's poll. Locked to its source IP.
  state.setResponse(pendingId, {
    status: 'accepted',
    bearer_token: tokenForPeer,
    receiver: {
      instance_id: IDENTITY.instance_id,
      display_name: IDENTITY.display_name,
      endpoint: ourEndpoint,
    },
    peer_record: peerRecord,
    peer_local_id: peerLocalId,
  }, item.from_ip);

  console.log(`[accept] ${item.from_name} → peer "${peerLocalId}" rel=${peerRecord.rel} expiry=${peerRecord.expiry_policy}`);
  res.json({ accepted: true, peer_local_id: peerLocalId, peer_record: peerRecord });
});

app.post('/a2a/block/:id', requireLocal, (req, res) => {
  const item = state.findPending(req.params.id);
  if (!item) return res.status(404).json({ error: 'pending request not found' });
  state.addBlock(item.from_id);
  state.removePending(req.params.id);
  state.setResponse(req.params.id, { status: 'blocked' }, item.from_ip);
  console.log(`[block] ${item.from_name} (${item.from_id.slice(0, 8)}) → 24h block`);
  res.json({ blocked: true });
});

app.get('/a2a/peers', requireLocal, (req, res) => {
  res.json({ peers: state.readPeers() });
});

app.post('/a2a/peers/:id/remove', requireLocal, (req, res) => {
  const removed = state.removePeer(req.params.id);
  if (!removed) return res.status(404).json({ error: 'peer not found' });
  console.log(`[peers] removed "${req.params.id}"`);
  res.json({ removed: true });
});

app.get('/a2a-connect.json', (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.protocol;
  const baseUrl = `${proto}://${host}`;
  const tokenRequired = MODE !== 'localhost';
  const capabilities = ['push'];
  const endpoints = { push: `${baseUrl}/context/push` };
  if (PULL_ENABLED) {
    capabilities.push('pull');
    endpoints.pull = `${baseUrl}/context/pull`;
  }
  // Advertise pairing capability (only meaningful for LAN-reachable modes).
  const pairingAvailable = MODE !== 'localhost';
  if (pairingAvailable) {
    capabilities.push('pair');
    endpoints.pair_request = `${baseUrl}/a2a/pair-request`;
    endpoints.pair_status = `${baseUrl}/a2a/pair-status/<pending_id>`;
  }

  res.json({
    protocol: 'agent-comms-v1',
    capabilities,
    endpoint: endpoints.push,        // back-compat: kept for v1 push-only clients
    endpoints,                        // forward-compat: explicit per-capability map
    auth: tokenRequired ? 'bearer' : 'localhost-only',
    mode: MODE,
    instance: {
      instance_id: IDENTITY.instance_id,
      display_name: IDENTITY.display_name,
    },
    pairing: pairingAvailable ? {
      protocol: 'agent-comms-pair-v1',
      pin_words: 6,
      pin_wordlist: 'BIP-39 English (2048 words)',
      discovery: { transport: 'udp-multicast', group: '239.42.42.42', port: 18742 },
    } : null,
    scopes: ['archive', 'active', 'memory'],
    fields: {
      from: 'string (your agent name, e.g. "claude-code-mbp")',
      to: 'string (optional, recipient agent name; absent = broadcast)',
      topic: 'string (short bucket name)',
      content: 'string (markdown supported, the payload)',
      tags: 'string[] (optional, searchable)',
      scope: '"archive" | "active" | "memory"',
      expires: 'ISO date (optional, for scope=active auto-archive)',
      id: 'string (optional, idempotency key)',
    },
    pull_filters: PULL_ENABLED ? {
      to: 'string — only return items addressed to this agent (or broadcast)',
      from: 'string — only return items from this sender',
      topic: 'string — exact match',
      since: 'ISO date — items received_at >= since',
      limit: 'int (default 50, max 200)',
      include: '"content" (default) | "meta"',
    } : undefined,
    examples: [
      {
        title: 'Push a code review summary',
        curl: `curl -X POST ${baseUrl}/context/push \\\n  -H "Content-Type: application/json" \\\n${
          tokenRequired ? '  -H "Authorization: Bearer $AGENT_COMMS_TOKEN" \\\n' : ''
        }  -d '{"from":"claude-code-mbp","topic":"pr-review","content":"PR #42: ...","scope":"archive","tags":["pr-42"]}'`,
      },
      ...(PULL_ENABLED ? [{
        title: 'Pull items addressed to me since yesterday',
        curl: `curl -s "${baseUrl}/context/pull?to=claude-code-mbp&since=$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)" \\\n${
          tokenRequired ? '  -H "Authorization: Bearer $AGENT_COMMS_TOKEN"' : ''
        }`,
      }] : []),
    ],
    skill_path: 'skill/agent-context-push/SKILL.md',
  });
});

app.get('/a2a-connect', (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.protocol;
  const baseUrl = `${proto}://${host}`;
  const tokenRequired = MODE !== 'localhost';
  const pairingAvailable = MODE !== 'localhost';
  const pairingCode = state.readPairingCode();
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><title>agent-comms · Connect</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 760px; margin: 0 auto; padding: 32px; color: #1c1917; background: #fafaf9; line-height: 1.6; }
h1 { font-size: 28px; margin: 0 0 8px; letter-spacing: -0.02em; }
.lede { color: #57534e; margin: 0 0 24px; }
.card { background: white; border: 1px solid #e7e5e4; border-radius: 8px; padding: 20px; margin: 16px 0; }
.badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
.badge.lan, .badge.tailnet { background: #fef3c7; color: #92400e; }
.badge.localhost { background: #d1fae5; color: #065f46; }
pre { background: #1c1917; color: #fafaf9; padding: 14px; border-radius: 6px; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.5; }
code { background: #f5f5f4; padding: 2px 6px; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
pre code { background: transparent; padding: 0; }
button { background: #0a7ea4; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
button:hover { background: #075a76; }
.copy-row { display: flex; gap: 8px; align-items: stretch; }
.copy-row pre { flex: 1; margin: 0; }
.feed-row { padding: 10px 12px; border-bottom: 1px solid #e7e5e4; display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
.feed-row:last-child { border-bottom: none; }
.feed-row .from { font-weight: 600; }
.feed-row .when { color: #78716c; font-size: 12px; }
.empty { color: #78716c; font-style: italic; padding: 16px; text-align: center; }
.token { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all; }
details summary { cursor: pointer; font-weight: 600; padding: 6px 0; }
</style>
</head><body>
<h1>Connect another agent · agent-comms</h1>
<p class="lede">Mode: <span class="badge ${MODE}">${MODE}</span> · Endpoint: <code>${baseUrl}/context/push</code> · Identity: <code>${IDENTITY.display_name}</code></p>

${pairingAvailable ? `
<div class="card" style="border:2px solid #0a7ea4">
  <h3 style="margin-top:0">🤝 Pair another machine — six-word PIN</h3>
  <p>Read these six words to the operator on the other machine. They type them into <code>agent-comms pair</code> on their end. You confirm the request locally.</p>
  <pre style="font-size:22px;font-weight:600;text-align:center;letter-spacing:0.04em;line-height:1.6">${pairingCode}</pre>
  <p style="font-size:13px;color:#78716c;margin-top:8px">Don't read this aloud over a channel you don't trust. The code is the whole story — anyone with these six words can pair to your machine. Rotate after a successful pair, or any time you want a fresh code.</p>
  <div class="copy-row" style="margin-top:8px">
    <pre id="pair-cmd" style="font-size:12px;flex:1">agent-comms pair ${baseUrl} --code "${pairingCode}"</pre>
    <button onclick="copy('pair-cmd', this)">Copy</button>
    <button onclick="rotateCode()" title="Generate a new code" style="background:#78716c">Rotate</button>
  </div>
</div>
` : `
<div class="card">
  <h3 style="margin-top:0">🤝 Pairing — needs LAN/tailnet mode</h3>
  <p>You're in <strong>localhost</strong> mode, so other machines can't reach this server. Switch to <code>lan</code> or <code>tailnet</code> via <code>bash scripts/configure.sh</code> to enable LAN pairing.</p>
</div>
`}

<div class="card">
  <h3 style="margin-top:0">📋 Quick setup — paste into the OTHER agent's terminal</h3>
  <div class="copy-row">
    <pre id="prompt-snippet">Read ${baseUrl}/a2a-connect.json and follow the agent-context-push protocol to push context to my agent-comms server. The bearer token (if needed) is in my .env as AGENT_COMMS_TOKEN.</pre>
    <button onclick="copy('prompt-snippet', this)">Copy</button>
  </div>
</div>

${tokenRequired ? `
<div class="card">
  <h3 style="margin-top:0">🔑 Bearer token</h3>
  <p>The other agent needs this in its <code>~/.claude/.env</code> as <code>AGENT_COMMS_TOKEN</code>.</p>
  <div class="copy-row">
    <pre id="token-snippet" class="token">${TOKEN}</pre>
    <button onclick="copy('token-snippet', this)">Copy</button>
  </div>
  <p style="font-size:13px;color:#78716c;margin-top:12px">⚠ Treat this like a password. Rotate by changing <code>AGENT_COMMS_TOKEN</code> and restarting agent-comms.</p>
</div>
` : `
<div class="card">
  <h3 style="margin-top:0">🔒 No token needed</h3>
  <p>You're in <strong>localhost</strong> mode — only processes on this machine can push. To enable cross-machine pushes, set <code>AGENT_COMMS_MODE=lan</code> (or <code>tailnet</code>) and <code>AGENT_COMMS_TOKEN</code> in your env, then restart.</p>
</div>
`}

<details>
  <summary>Manual curl</summary>
  <pre>curl -X POST ${baseUrl}/context/push \\
  -H "Content-Type: application/json" \\
${tokenRequired ? `  -H "Authorization: Bearer $AGENT_COMMS_TOKEN" \\\n` : ''}  -d '{
    "from": "claude-code-mbp",
    "topic": "pr-review",
    "content": "Reviewed PR #42. Findings: ...",
    "scope": "archive",
    "tags": ["pr-42"]
  }'</pre>
</details>

<details>
  <summary>Available scopes</summary>
  <ul>
    <li><code>archive</code> — files into <code>~/.agent-comms/inbound/&lt;from&gt;/</code>. Default.</li>
    <li><code>active</code> — same as archive (this server is storage-only; downstream tooling decides what's "active").</li>
    <li><code>memory</code> — same as archive (same reasoning).</li>
  </ul>
  <p style="font-size:13px;color:#78716c">Scope is recorded in the file's frontmatter so downstream consumers (memory indexers, dashboards) can route appropriately.</p>
</details>

<div class="card">
  <h3 style="margin-top:0">📡 Recent pushes <button onclick="loadFeed()" style="float:right;font-size:12px;padding:4px 10px">Refresh</button></h3>
  <div id="feed"><div class="empty">Loading...</div></div>
</div>

<script>
function copy(id, btn) {
  const el = document.getElementById(id);
  navigator.clipboard.writeText(el.textContent).then(() => {
    const o = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => btn.textContent = o, 1500);
  });
}
async function rotateCode() {
  if (!confirm('Rotate the pairing code? Anyone mid-pair with the old code will need the new one.')) return;
  try {
    const r = await fetch('/a2a/code/rotate', { method: 'POST' });
    if (!r.ok) throw new Error('rotate failed: ' + r.status);
    location.reload();
  } catch (e) { alert(e.message); }
}
async function loadFeed() {
  try {
    const r = await fetch('/a2a/recent?limit=15');
    const d = await r.json();
    const f = document.getElementById('feed');
    if (!d.pushes || !d.pushes.length) {
      f.innerHTML = '<div class="empty">No pushes yet. Connect an agent and send a test push.</div>';
      return;
    }
    f.innerHTML = d.pushes.map(p => {
      const w = new Date(p.mtime).toLocaleString();
      return '<div class="feed-row"><div><span class="from">' + p.from + '</span> &middot; <span style="color:#57534e">' + p.file + '</span></div><span class="when">' + w + '</span></div>';
    }).join('');
  } catch (e) {
    document.getElementById('feed').innerHTML = '<div class="empty">Failed: ' + e.message + '</div>';
  }
}
loadFeed();
setInterval(loadFeed, 15000);
</script>
</body></html>`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Bind: localhost mode → 127.0.0.1, others → 0.0.0.0 so LAN/tailnet can reach
const bindAddr = MODE === 'localhost' ? '127.0.0.1' : '0.0.0.0';
app.listen(PORT, bindAddr, () => {
  console.log(`[boot] agent-comms listening on ${bindAddr}:${PORT}`);
  console.log(`[boot] connect page: http://localhost:${PORT}/a2a-connect`);
});

// LAN discovery responder — only when MODE != localhost. There's no point
// being discoverable if HTTP isn't reachable from the network anyway.
let stopResponder = null;
if (MODE !== 'localhost') {
  try {
    stopResponder = discovery.startResponder({
      getOffer: () => ({
        instance_id: IDENTITY.instance_id,
        display_name: IDENTITY.display_name,
        endpoint: `http://${getReachableHost()}:${PORT}`,
        mode: MODE,
        auth: 'bearer',
        capabilities: ['push', ...(PULL_ENABLED ? ['pull'] : []), 'pair'],
      }),
      log: msg => console.log(msg),
    });
  } catch (e) {
    console.error(`[boot] discovery responder failed: ${e.message}`);
  }
} else {
  console.log(`[boot] discovery responder disabled (localhost mode)`);
}

// Best-effort: a hostname / IP that another machine on the LAN can reach.
// This is advisory — the real reachable host depends on the network. Order:
// 1. AGENT_COMMS_ADVERTISE_HOST env override
// 2. tailscale hostname/IP if tailnet mode and tailscale is up
// 3. first non-loopback IPv4 from os.networkInterfaces()
// 4. fallback: hostname()
function getReachableHost() {
  if (process.env.AGENT_COMMS_ADVERTISE_HOST) return process.env.AGENT_COMMS_ADVERTISE_HOST;
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return os.hostname();
}

// Graceful shutdown
function shutdown() {
  console.log(`[shutdown] stopping`);
  if (stopResponder) try { stopResponder(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
