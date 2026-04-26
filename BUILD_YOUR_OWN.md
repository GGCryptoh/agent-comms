# Build your own agent-comms (without trusting this repo)

If you'd rather not run code from a stranger's repo, you don't have to. The
`agent-comms-v1` protocol is small enough that a competent coding agent can
implement the whole thing from a single prompt. This file IS that prompt.

**How to use:**

1. Read this file in your browser or on GitHub. Don't clone the repo, don't
   download anything.
2. Open Claude Code, Codex, Cursor, or whichever coding agent you trust.
3. Copy the entire `## The build prompt` section below into the agent.
4. Review every file the agent produces before running it.
5. The result is a fully working `agent-comms` server, written by your agent,
   in code you've reviewed, on your machine.

The protocol your agent builds will be wire-compatible with anyone else
running an agent-comms server, because the spec is fixed.

---

## Why this exists

Self-hostable infrastructure is only as trustworthy as the code you actually
ran. Two paths to getting an agent-comms server working:

- **Trust this repo** — clone, install, run. Fast. Requires you to either
  audit the source yourself or trust the maintainer.
- **Build your own** — paste the prompt below into a coding agent, review
  what it writes, run it. Slower. The only code on your machine is code
  you (and your trusted agent) generated and reviewed.

Both produce wire-compatible servers. Pick the path that matches your
threat model.

---

## The build prompt

Everything below the `═══` line is the prompt. Copy it verbatim into your
coding agent.

═══════════════════════════════════════════════════════════════════════════

Build me a small HTTP server called **agent-comms** that lets coding agents
push context to each other over the local network or Tailscale. Build it
from scratch in a new directory — don't fetch anyone else's source.

## Specification

### Protocol name

`agent-comms-v1`. The server identifies itself as this in
`/a2a-connect.json`.

### Endpoints

The server exposes exactly six HTTP endpoints:

1. **`POST /context/push`** — receives a context push.
   Auth: see "Auth modes" below.
   Body (JSON):
   - `from` (string, required) — agent identifier, used in filenames
   - `to` (string, optional) — recipient agent name. Absent = broadcast.
     Recorded in frontmatter; used by `/context/pull`'s `to` filter.
   - `topic` (string, required) — short bucket name, used in filenames
   - `content` (string, required) — markdown payload
   - `tags` (string[], optional) — for downstream search
   - `scope` (string, optional, default `"archive"`) — one of `archive`,
     `active`, `memory`. Recorded in the file's frontmatter.
   - `expires` (ISO date, optional) — informational
   - `id` (string, optional) — idempotency key
   Response 201 on success:
   ```json
   {
     "received": true,
     "filed_at": "<from-slug>/<date>-<topic>-<idsuffix>.md",
     "scope": "archive",
     "indexed_within_seconds": 0
   }
   ```
   Response 400 if `content` missing/empty or `scope` invalid.
   Response 401/403 on auth failure (see below).

2. **`GET /context/pull`** — fetch matching items. Same auth as push.
   Only available when `AGENT_COMMS_PULL_ENABLED=true`. When disabled,
   return 404 with `{"error":"Pull is not enabled on this server"}`.
   Query params (all optional):
   - `to` (string) — return only items where frontmatter `to` matches OR
     where no `to` is set (broadcast)
   - `from` (string) — return only items from this sender
   - `topic` (string) — exact match
   - `since` (ISO date) — items where `received_at >= since`. 400 on
     invalid date.
   - `limit` (int, default 50, max 200)
   - `include` (`"content"` default | `"meta"`) — whether the body is
     included
   Response:
   ```json
   { "items": [ {from, to, topic, tags, scope, received_at, expires, id, file, content?}, ... ],
     "count": <int> }
   ```
   Sorted newest first. The `to` filter is a CONVENIENCE for routing,
   not a security boundary — the bearer token is the trust line.

3. **`GET /a2a-connect.json`** — machine-readable connection metadata.
   No auth. Returns:
   ```json
   {
     "protocol": "agent-comms-v1",
     "capabilities": ["push"]            // or ["push", "pull"] when enabled
     "endpoint": "<absolute URL of /context/push>",  // back-compat
     "endpoints": { "push": "...", "pull": "..." }, // explicit per-capability
     "auth": "bearer" | "localhost-only",
     "mode": "localhost" | "lan" | "tailnet",
     "scopes": ["archive", "active", "memory"],
     "fields": { ...field descriptions... },
     "pull_filters": { ... }              // present only when pull enabled
     "examples": [ { "title": "...", "curl": "..." } ]
   }
   ```

4. **`GET /a2a-connect`** — human-friendly HTML connect page. No auth.
   Shows the mode, the endpoint URL, the bearer token (if applicable,
   with copy-to-clipboard), a paste-into-other-agent prompt, a manual
   curl example, and a live activity feed that fetches `/a2a/recent`
   every 15s.

5. **`GET /a2a/recent`** — last N pushes for the activity feed. No auth.
   Query: `limit` (default 20, max 200). Returns:
   ```json
   { "pushes": [ { "from": "...", "file": "...", "mtime": <epoch ms> }, ... ] }
   ```
   Sorted newest first. Source: walk the inbound directory.

6. **`GET /health`** — liveness check. No auth.
   Returns `{ "status": "ok", "service": "agent-comms", "mode": "...", "timestamp": "..." }`.

### Pairing layer (agent-comms-pair-v1) — extension

The pairing layer adds a 6-word PIN handshake on top of the v1 push protocol.
Skip this if you only want push/pull. Implement it to enable
`agent-comms discover` / `agent-comms pair` / `agent-comms accept` flow.

#### State files

Add `STATE_DIR = process.env.AGENT_COMMS_HOME || ~/.agent-comms`. All
files under STATE_DIR are JSON (atomic write: write to `.tmp`, rename),
chmod 600 after write.

| File | Shape |
|---|---|
| `identity.json` | `{ instance_id: <uuid>, display_name: <string>, created_at: <ISO> }` — created on first boot |
| `pairing-code.txt` | `<six space-separated BIP-39 words>\n` — created on first boot if missing |
| `peers.json` | `{ <local_peer_id>: <peer_record>, ... }` |
| `pending.json` | `[ <pending_record>, ... ]` |
| `blocklist.json` | `[ { instance_id, expires_at_ms }, ... ]` (24h TTL, purge stale on read) |
| `responses.json` | `{ <pending_id>: { status, ..., _ts, _ip }, ... }` (15-min TTL, one-shot read) |

`peer_record` shape:
```json
{
  "instance_id": "<uuid of the other side>",
  "display_name": "<their name>",
  "endpoint": "http://<host>:<port>",
  "ip": "<remote IP>",
  "rel": "friend|business|full_authority|vendor|guest",
  "paired_at": "<ISO>",
  "paired_via": "lan-pairing-code",
  "expiry_policy": "indefinite|time-bounded|single-shot",
  "expires_at": "<ISO or null>",
  "single_shot_used": false
}
```

`pending_record` shape:
```json
{
  "pending_id": "<uuid>",
  "from_id": "<uuid>",
  "from_name": "<string>",
  "from_endpoint": "<URL or null>",
  "from_ip": "<string>",
  "requested_rel": "<string or null>",
  "requested_expiry": "<string or null>",
  "requested_expires_at": "<ISO or null>",
  "received_at": "<ISO>"
}
```

#### Pairing code

A 6-word string from the BIP-39 English wordlist (2048 words, public
domain — fetch the canonical list from `bitcoin/bips/blob/master/bip-0039/english.txt`).
Use `crypto.randomInt(0, 2048)` for uniformity. Compare codes after
normalizing: lowercase, strip non-letters, collapse whitespace, split
on space, must be exactly 6 words, each must be in the wordlist.
Compare normalized strings with `crypto.timingSafeEqual` (constant-time).

#### LAN discovery

UDP multicast group `239.42.42.42`, port `18742`, link-local TTL 1.

**Probe (sender → multicast):**
```json
{ "type": "agent-comms.probe.v1", "nonce": "<base64-16>", "ts": <ms> }
```

**Offer (responder → unicast back):**
```json
{
  "type": "agent-comms.offer.v1",
  "echo_nonce": "<must equal the probe nonce>",
  "ts": <ms>,
  "instance_id": "<our uuid>",
  "display_name": "<our name>",
  "endpoint": "http://<lan-ip>:<port>",
  "mode": "lan|tailnet",
  "auth": "bearer",
  "capabilities": ["push", "pull?", "pair"]
}
```

The responder is started by the server **only** when `AGENT_COMMS_MODE` is
`lan` or `tailnet` (no point being discoverable in localhost mode). Use
`socket.addMembership(MCAST_GROUP)` after `bind(MCAST_PORT)`.

#### Pairing endpoints

7. **`GET /a2a/code`** — localhost-only. Returns `{ code, instance_id, display_name }`.

8. **`POST /a2a/code/rotate`** — localhost-only. Generates a fresh 6-word
   code, writes `pairing-code.txt`, returns `{ code }`.

9. **`POST /a2a/pair-request`** — public, code-verified. Body:
   `{ from_id, from_name, from_endpoint?, code, requested_rel?, requested_expiry?, requested_expires_at? }`.
   - 400 if `from_id` or `from_name` missing.
   - 400 if `code` is not exactly 6 BIP-39 words.
   - 403 if `from_id` is in the blocklist.
   - 401 if `code` doesn't match (constant-time compare).
   - 409 if `from_id` is already in `peers.json`.
   - On success: write a `pending_record`, return 202 with
     `{ received: true, pending_id, receiver: { instance_id, display_name }, next: "<hint>" }`.

10. **`GET /a2a/pair-status/:id`** — public but **IP-locked**. Initiator
    polls. Read+take from `responses.json`; if the entry's stored `_ip`
    doesn't match the requesting client IP, treat it as not-found.
    Otherwise delete the entry and return its payload (one-shot).
    If still pending, return `{ status: "pending" }`. If unknown, 404.

11. **`GET /a2a/pending`** — localhost-only. Returns `{ pending: [...] }`.

12. **`POST /a2a/accept/:id`** — localhost-only. Body
    `{ rel?, expiry?, expires_at? }`.
    - Look up pending record; 404 if missing.
    - 403 if `from_id` is now blocked (clean up pending).
    - Build the peer record; pick a `peer_local_id` by slugifying
      `from_name` (fallback to `peer-<8 chars of instance_id>`).
    - Write to `peers.json`, remove from `pending.json`.
    - Write to `responses.json` keyed by `pending_id`:
      ```json
      {
        "status": "accepted",
        "bearer_token": "<AGENT_COMMS_TOKEN>",
        "receiver": { instance_id, display_name, endpoint },
        "peer_record": <the peer record>,
        "peer_local_id": "<slug>",
        "_ts": <Date.now()>,
        "_ip": "<from_ip from the pending record>"
      }
      ```
    - Return `{ accepted: true, peer_local_id, peer_record }`.

13. **`POST /a2a/block/:id`** — localhost-only. Adds `from_id` to
    `blocklist.json` (24h TTL), removes pending, writes
    `responses.json[pending_id] = { status: "blocked" }` (IP-locked).

14. **`GET /a2a/peers`** — localhost-only. Returns `{ peers: <peers.json> }`.

15. **`POST /a2a/peers/:id/remove`** — localhost-only. Deletes that local
    peer entry. 404 if not found.

#### Update /a2a-connect.json to advertise pairing

When `AGENT_COMMS_MODE !== "localhost"`:
- Add `"pair"` to `capabilities`.
- Add `endpoints.pair_request` and `endpoints.pair_status` (with
  `<pending_id>` as a placeholder).
- Include an `instance: { instance_id, display_name }` block.
- Include a `pairing: { protocol: "agent-comms-pair-v1", pin_words: 6,
  pin_wordlist: "BIP-39 English (2048 words)",
  discovery: { transport: "udp-multicast", group: "239.42.42.42", port: 18742 } }` block.

#### Acceptance tests for the pairing layer

```bash
# Setup: lan mode, separate state dirs for receiver and initiator
mkdir -p /tmp/ac-rcv /tmp/ac-init
AGENT_COMMS_HOME=/tmp/ac-rcv AGENT_COMMS_MODE=lan AGENT_COMMS_TOKEN=t \
  AGENT_COMMS_PORT=18890 node server.js &
sleep 1

# 1. Code shows 6 BIP-39 words
CODE=$(curl -s http://127.0.0.1:18890/a2a/code | jq -r .code)
[[ $(echo "$CODE" | wc -w) -eq 6 ]] && echo PASS

# 2. Wrong code → 401
curl -s -X POST http://127.0.0.1:18890/a2a/pair-request \
  -H "Content-Type: application/json" \
  -d '{"from_id":"x","from_name":"x","code":"abandon ability able about above absent"}' \
  | grep -q '"pairing code mismatch"' && echo PASS

# 3. Right code → 202 + pending_id
PID=$(curl -s -X POST http://127.0.0.1:18890/a2a/pair-request \
  -H "Content-Type: application/json" \
  -d "{\"from_id\":\"abc-123\",\"from_name\":\"tester\",\"code\":\"$CODE\"}" \
  | jq -r .pending_id)
[[ -n "$PID" ]] && echo PASS

# 4. Pending list shows the request
curl -s http://127.0.0.1:18890/a2a/pending | grep -q "$PID" && echo PASS

# 5. Accept returns peer_local_id, status response is one-shot
curl -s -X POST "http://127.0.0.1:18890/a2a/accept/$PID" \
  -H "Content-Type: application/json" \
  -d '{"rel":"friend","expiry":"indefinite"}' \
  | grep -q '"accepted":true' && echo PASS

# 6. pair-status returns accepted (and is locked to the original IP)
curl -s "http://127.0.0.1:18890/a2a/pair-status/$PID" \
  | grep -q '"status":"accepted"' && echo PASS

# 7. Second poll on same id returns 404 (one-shot)
curl -s -o /dev/null -w "%{http_code}" \
  "http://127.0.0.1:18890/a2a/pair-status/$PID" | grep -q "404" && echo PASS

# 8. Localhost-only endpoint rejects from non-loopback (simulate via X-Forwarded-For)
curl -s -X POST http://127.0.0.1:18890/a2a/code/rotate \
  -H "X-Forwarded-For: 1.2.3.4" \
  | grep -q "localhost-only" && echo PASS
```

Eight PASSes, plus the original six = 14 acceptance tests total.

### Auth modes

Driven by env var `AGENT_COMMS_MODE`, one of:

- **`localhost`** (default) — server binds `127.0.0.1` only. `/context/push`
  rejects any request with an `X-Forwarded-For` header (403, "localhost mode
  rejects proxied requests"). Rejects any request whose peer address isn't
  `127.0.0.1` or `::1` (403). No bearer token used.
- **`lan`** — server binds `0.0.0.0`. `/context/push` requires
  `Authorization: Bearer <token>` matching `AGENT_COMMS_TOKEN`. 401 on
  mismatch. 503 if mode is lan/tailnet but token isn't configured.
- **`tailnet`** — same as `lan` from the server's perspective. The
  difference is documentation: users limit reach via Tailscale, not via
  application-level checks. Server doesn't enforce tailnet IP ranges
  itself (firewall responsibility).

The server **fails loud at boot** if:
- `AGENT_COMMS_MODE` is not one of the three values
- Mode is `lan` or `tailnet` but `AGENT_COMMS_TOKEN` is empty

### File format

Pushes are written to disk as markdown files. Layout:

```
$AGENT_COMMS_INBOUND_DIR/
  <from-slug>/
    <YYYY-MM-DD>-<topic-slug>-<idsuffix>.md
```

Default `AGENT_COMMS_INBOUND_DIR` is `~/.agent-comms/inbound`.

Slug rule: lowercase, replace any non-alphanumeric run with `-`, strip
leading/trailing `-`, max 60 chars. Empty slug becomes `untitled`.

`idsuffix`: if `id` was provided in the payload, slugify it (max 24 chars)
and prefix with `-`. Otherwise use `-<base36 of Date.now()>`.

File contents: YAML frontmatter, then the request's `content` (trimmed),
then a trailing newline. Frontmatter fields:

```yaml
---
name: "<topic> (from <from>)"
source: agent-comms-inbound
from: <from>
topic: <topic>
scope: <scope>
tags: [<json-quoted strings>]
received_at: <ISO timestamp>
expires: <if provided>
id: <if provided>
---
```

`expires` and `id` lines are omitted when absent (don't write empty values).

### Configuration

Read env in this order, later overrides earlier: process env, `~/.claude/.env`,
`./.env` (next to `server.js`).

Variables:

| Variable | Default | Notes |
|---|---|---|
| `AGENT_COMMS_PORT` | `8090` | TCP port |
| `AGENT_COMMS_MODE` | `localhost` | Auth mode (see above) |
| `AGENT_COMMS_TOKEN` | (empty) | Required for lan/tailnet |
| `AGENT_COMMS_INBOUND_DIR` | `~/.agent-comms/inbound` | Where pushes land |
| `AGENT_COMMS_HOME` | `~/.agent-comms` | Pairing state dir (identity, peers, pending, etc.) |
| `AGENT_COMMS_ADVERTISE_HOST` | (auto-detected) | Override for the host advertised in UDP offers |
| `AGENT_COMMS_NOTIFY` | `off` | `off` / `first50` / `all` |
| `TELEGRAM_BOT_TOKEN` | (empty) | For Telegram notifications |
| `TELEGRAM_CHAT_ID` | (empty) | For Telegram notifications |

Custom `.env` parser: handle `KEY=VALUE` lines, allow values with `=` in
them (everything after first `=` is value), strip surrounding double
quotes, ignore lines starting with `#`, ignore blank lines. Don't
override variables already in `process.env`.

### Telegram notifications

After every push:
- If `AGENT_COMMS_NOTIFY === "off"` (default): do nothing.
- If `"first50"`: increment a counter; if over 50, do nothing.
- If `"all"`: always notify.
- If notifying: POST to
  `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage` with
  body `{ chat_id, text, parse_mode: "Markdown", disable_web_page_preview: true }`.
- Text format:
  ```
  📥 Context received from `<from>`
  *Topic:* <topic>
  *Scope:* <scope>
  *Tags:* <comma-separated, omit line if empty>
  
  <content preview, max 240 chars + "…">
  ```
- Failure to notify must NOT fail the push. Log the error.

### Stack

- Node.js 18+
- Express 4 (the only dependency)
- Built-in `fs`, `path`, `os` for filesystem and home dir

No TypeScript. No build step. Single `server.js` file is fine.

### Files to produce

```
server.js              — the HTTP server (everything above)
package.json           — name "agent-comms", express dep, "start" script
.env.example           — documents every env var, mostly commented out
.gitignore             — node_modules, .env, *.log, .DS_Store, inbound/, .agent-comms/
README.md              — quickstart, modes overview, push examples
```

Optionally also produce:

```
scripts/configure.sh   — interactive setup that writes ~/.claude/.env
launchd/com.agent-comms.plist (macOS) — service template with __HOME__ + __REPO__ placeholders
```

### Acceptance tests

Your generated server should pass these tests when run from the project
directory with `node server.js`:

```bash
# 1. Health check
curl -s http://localhost:8090/health | grep -q '"status":"ok"' && echo PASS

# 2. Connect JSON
curl -s http://localhost:8090/a2a-connect.json | grep -q '"protocol":"agent-comms-v1"' && echo PASS

# 3. Localhost mode push (no token needed since AGENT_COMMS_MODE=localhost)
curl -s -X POST http://localhost:8090/context/push \
  -H "Content-Type: application/json" \
  -d '{"from":"test","topic":"hello","content":"# Hi","scope":"archive"}' \
  | grep -q '"received":true' && echo PASS

# 4. Bad payload returns 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8090/context/push \
  -H "Content-Type: application/json" \
  -d '{"from":"test"}' \
  | grep -q "^400$" && echo PASS

# 5. File landed on disk
ls ~/.agent-comms/inbound/test/*.md && echo PASS

# 6. Switch to lan mode + bad token returns 401
AGENT_COMMS_MODE=lan AGENT_COMMS_TOKEN=secret123 node server.js &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8090/context/push \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer wrong" \
  -d '{"from":"x","topic":"x","content":"x"}' \
  | grep -q "^401$" && echo PASS
kill %1
```

All six should print `PASS`. If any don't, fix the implementation.

### Security expectations

- Never log the bearer token, even on auth failures.
- Localhost mode must reject proxied requests (presence of
  `X-Forwarded-For`).
- Don't trust the Host header for security decisions — it's only used to
  build display URLs.
- File writes use the `from` and `topic` fields — both must be slugified
  before joining into a path so a malicious agent can't write outside
  the inbound dir via `../`.

### What NOT to add

- No TLS. (Tailnet does it for you. LAN users opt in by reading the docs.)
- No rate limiting. (Single user, single shelf.)
- No authentication beyond a single shared bearer.
- No database. Markdown files on disk, that's it.

### When you're done

Walk me through what you built, what tests you ran, and any decisions you
made that aren't pinned in this spec. I'll review the code before running
it.

═══════════════════════════════════════════════════════════════════════════

End of build prompt.

---

## After your agent finishes

Things to verify before running the generated code:

1. **Read `server.js` end-to-end.** It should be one file, ~300-400 LOC.
   If it's much bigger, the agent over-engineered.
2. **Check the auth middleware.** Localhost mode must reject
   `X-Forwarded-For`. Bearer mode must compare tokens with no early-exit
   timing leaks (a constant-time compare is overkill for a 32-hex-byte
   token but worth a glance).
3. **Check the slug function.** It must reject `..` and path separators
   in `from` and `topic`. Otherwise a malicious agent writes outside the
   inbound dir.
4. **Run the acceptance tests** in the spec. All six should pass.
5. **Diff against this repo's `server.js`** if you want a sanity check —
   the protocol is identical, so file-to-file diffs should be small
   (style differences, framework idioms, comment density).

If steps 1-4 pass, you have a working agent-comms server you wrote
yourself, with no dependency on this repo.

## Wire compatibility

Servers built from this prompt are wire-compatible with each other and
with the reference implementation in this repo. That means:

- A skill written for one works against the other.
- An agent that can push to one can push to the other (same auth, same
  payload, same response shape).
- The connect dashboard layout differs (every implementation styles it
  differently) but the JSON shape is fixed.

The protocol name `agent-comms-v1` is the contract. If anyone evolves
the protocol, the version bumps and everyone re-reads the spec.

---

## Reporting issues with the spec

If your agent produces something that doesn't pass the acceptance tests,
the spec is wrong somewhere. File an issue at
https://github.com/GGCryptoh/agent-comms/issues with:

- Which test failed
- What your agent produced for the relevant code path
- What you think the spec should have said

Spec bugs get fixed. Implementation bugs get filed against whichever
implementation is broken.
