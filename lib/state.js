// Shared state management for agent-comms pairing.
// All files live in $AGENT_COMMS_HOME (default ~/.agent-comms/).
//
// Files:
//   identity.json       — instance_id (uuid), display_name, created_at
//   pairing-code.txt    — current 6-word pairing code (regenerable)
//   peers.json          — paired peers { id: { ...record } }
//   pending.json        — inbound pair requests awaiting accept
//   blocklist.json      — blocked instance_ids with expiry timestamps
//
// All files are JSON except pairing-code.txt (plain text, one line).
// All writes are atomic (write tmp, rename) so a partial write can't
// corrupt state.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const STATE_DIR = process.env.AGENT_COMMS_HOME
  || path.join(os.homedir(), '.agent-comms');

function ensureDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function fpath(name) {
  return path.join(STATE_DIR, name);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(fpath(file), 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  ensureDir();
  const full = fpath(file);
  const tmp = `${full}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, full);
  try { fs.chmodSync(full, 0o600); } catch {}
}

function readText(file) {
  try { return fs.readFileSync(fpath(file), 'utf-8').trim(); }
  catch { return ''; }
}

function writeText(file, content) {
  ensureDir();
  const full = fpath(file);
  const tmp = `${full}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, full);
  try { fs.chmodSync(full, 0o600); } catch {}
}

// ── identity ───────────────────────────────────────────────────────
function readIdentity() {
  return readJson('identity.json', null);
}

function writeIdentity(identity) {
  writeJson('identity.json', identity);
}

function ensureIdentity(displayName) {
  let id = readIdentity();
  if (id) return id;
  id = {
    instance_id: crypto.randomUUID(),
    display_name: displayName || os.hostname() || 'unnamed',
    created_at: new Date().toISOString(),
  };
  writeIdentity(id);
  return id;
}

// ── pairing code ───────────────────────────────────────────────────
function readPairingCode() {
  return readText('pairing-code.txt');
}

function writePairingCode(code) {
  writeText('pairing-code.txt', code + '\n');
}

// ── peers ──────────────────────────────────────────────────────────
function readPeers() {
  return readJson('peers.json', {});
}

function writePeers(peers) {
  writeJson('peers.json', peers);
}

function addPeer(id, record) {
  const peers = readPeers();
  peers[id] = record;
  writePeers(peers);
}

function removePeer(id) {
  const peers = readPeers();
  if (peers[id]) {
    delete peers[id];
    writePeers(peers);
    return true;
  }
  return false;
}

function findPeerByInstance(instance_id) {
  const peers = readPeers();
  for (const [id, rec] of Object.entries(peers)) {
    if (rec.instance_id === instance_id) return { id, ...rec };
  }
  return null;
}

// ── pending pair requests ──────────────────────────────────────────
function readPending() {
  return readJson('pending.json', []);
}

function writePending(list) {
  writeJson('pending.json', list);
}

function addPending(req) {
  const list = readPending();
  list.push(req);
  writePending(list);
  return req;
}

function removePending(pendingId) {
  const list = readPending();
  const idx = list.findIndex(r => r.pending_id === pendingId);
  if (idx < 0) return null;
  const [removed] = list.splice(idx, 1);
  writePending(list);
  return removed;
}

function findPending(pendingId) {
  return readPending().find(r => r.pending_id === pendingId) || null;
}

// ── blocklist ──────────────────────────────────────────────────────
function readBlocklist() {
  const list = readJson('blocklist.json', []);
  const now = Date.now();
  const fresh = list.filter(b => b.expires_at_ms > now);
  if (fresh.length !== list.length) writeJson('blocklist.json', fresh);
  return fresh;
}

function isBlocked(instance_id) {
  return readBlocklist().some(b => b.instance_id === instance_id);
}

function addBlock(instance_id, ttlMs = 24 * 60 * 60 * 1000) {
  const list = readBlocklist();
  list.push({ instance_id, expires_at_ms: Date.now() + ttlMs });
  writeJson('blocklist.json', list);
}

// ── pair-response cache (one-shot, TTL'd) ─────────────────────────
// When the receiver accepts (or blocks) a pending request, the result
// is cached here keyed by pending_id. The initiator polls
// GET /a2a/pair-status/:id, takes the entry, and the entry is deleted.
// Anything older than 15 minutes is purged on read.

const RESPONSE_TTL_MS = 15 * 60 * 1000;

function readResponses() {
  return readJson('responses.json', {});
}

function writeResponses(obj) {
  writeJson('responses.json', obj);
}

function setResponse(pendingId, payload, ip) {
  const r = readResponses();
  r[pendingId] = { ...payload, _ts: Date.now(), _ip: ip || null };
  writeResponses(r);
}

function takeResponse(pendingId, callerIp) {
  purgeOldResponses();
  const r = readResponses();
  const entry = r[pendingId];
  if (!entry) return null;
  // Lock to originating IP to prevent token theft if someone grabs the
  // pending_id off the wire. Set during pair-request from the same IP.
  if (entry._ip && callerIp && entry._ip !== callerIp) return null;
  delete r[pendingId];
  writeResponses(r);
  const { _ts, _ip, ...payload } = entry;
  return payload;
}

function purgeOldResponses() {
  const r = readResponses();
  const now = Date.now();
  let changed = false;
  for (const [k, v] of Object.entries(r)) {
    if (now - (v._ts || 0) > RESPONSE_TTL_MS) { delete r[k]; changed = true; }
  }
  if (changed) writeResponses(r);
}

module.exports = {
  STATE_DIR,
  ensureDir,
  readIdentity, writeIdentity, ensureIdentity,
  readPairingCode, writePairingCode,
  readPeers, writePeers, addPeer, removePeer, findPeerByInstance,
  readPending, writePending, addPending, removePending, findPending,
  readBlocklist, isBlocked, addBlock,
  setResponse, takeResponse, purgeOldResponses,
};
