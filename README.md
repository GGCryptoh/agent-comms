# agent-comms

> A small HTTP server that lets coding agents push context to each other —
> over LAN, over Tailscale, or just on a single machine.
> No accounts, no SaaS, no schema migrations. Just markdown files on disk.
> Now with **6-word LAN pairing** — connect two machines without copy-pasting tokens.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)

---

## 60-second pair (the headline)

Two machines on the same LAN. Both have agent-comms installed and running
in `lan` or `tailnet` mode. You want them to talk.

```bash
# On the RECEIVER (the side you're connecting TO):
agent-comms code
#   →  gown blue energy joy vintage spirit

# On the INITIATOR (the side you're connecting FROM):
agent-comms discover --lan
#   →  [1] mac-mini.local  http://192.168.1.42:8090  ...

agent-comms pair http://192.168.1.42:8090 \
  --code "gown blue energy joy vintage spirit" \
  --rel friend --expires 30d
#   →  ✓ Request sent. Waiting for accept...

# Back on the RECEIVER:
agent-comms pending
#   →  fe8bbff4  laptop  (218110e4, 192.168.1.17)  received ...

agent-comms accept fe8bbff4 --rel friend --expires 30d
#   →  ✓ Accepted.

# Initiator's CLI returns:
#   →  ✓ Saved peer "mac-mini-local" → http://192.168.1.42:8090
#   →  ✓ Stored bearer token (64 chars)

# Done. Push context with the existing /context/push semantics.
```

The 6 words are read aloud over a channel you trust (voice call, in-person,
encrypted DM). The receiver's server only accepts the request if the words
match — and even then, the receiving operator has to explicitly `accept`
or `block`. Two layers of human consent.

Full protocol: see [pairing](#pairing--6-word-pin-protocol) below.

---

## What this solves

You're running Claude Code on your laptop. You're also running it on a Mac
Mini at home. Or you've got Codex on a remote box, or Cursor on a teammate's
machine. Each instance accumulates context as it works — PR reviews,
research, deployment outcomes, bug-hunt notes — and that context normally
dies in chat history.

**agent-comms is a shared shelf.** One sender drops a markdown summary on
the shelf; any agent on the network can pick it up later. The server is
dumb on purpose: receive JSON over HTTP, write a markdown file, optionally
ping Telegram. Whatever indexes or consumes the markdown is up to the
receiving tooling.

> **Senders are not just AI agents.** The protocol is HTTP. Anything
> that can POST JSON with a bearer token can push: a coding agent
> (Claude Code, Codex, Cursor), a CI step, a cron job, a Slack bot,
> a GitHub webhook relay, even a one-line `curl` from your terminal.
> The "agent" framing throughout the docs is the marquee use case —
> not a requirement.

```
   Any HTTP client                  agent-comms (this server)
   (coding agent, CI job, cron,
    webhook relay, curl, etc.)
        │
        │  POST /context/push
        │  Authorization: Bearer <token>
        │  { from, topic, content, scope, tags, to? }
        ▼
   ┌──────────────────────────────────────────────────┐
   │  Verifies auth, files the markdown to            │
   │  ~/.agent-comms/inbound/<from>/<date>-<topic>.md │
   │  Optionally pings Telegram.                      │
   └──────────────────────────────────────────────────┘
                    │
                    ▼
   Whatever consumes ~/.agent-comms/inbound/
   (memory indexer, dashboard, your own scripts,
    or another agent doing GET /context/pull)
```

---

## Three install paths

Pick whichever fits your trust level.

### 🟢 Path 1 — Have your own agent install it (fastest)

Works with any AI coding agent that can fetch a URL and run shell commands:
**Claude Code · Codex · GitHub Copilot · Cursor · Windsurf · Aider · Continue ·**
or any custom agent with `WebFetch`/`curl` + `Bash` capabilities. Open
your agent on the machine that should run the server, then paste:

```
Read https://github.com/GGCryptoh/agent-comms/blob/main/AGENTS.md and
follow the recipe to install agent-comms on this machine. Detect my
network situation (Tailscale / LAN / localhost) and pick a sensible
mode for me. Show me the connect URL and bearer token (if any) when
you're done.
```

Your agent reads the [AGENTS.md](AGENTS.md) recipe, detects whether
you're on Tailscale, picks the right mode, runs `configure.sh` and
`install.sh` non-interactively, then verifies `/health`. Total time:
~2 minutes.

### 🟡 Path 2 — Install it yourself (manual)

```bash
git clone https://github.com/GGCryptoh/agent-comms.git ~/__CODE/agent-comms
cd ~/__CODE/agent-comms
bash scripts/install.sh
```

That's it. `install.sh` does dependency install (pnpm/npm), runs the
interactive configure step (mode, token, port, push-vs-pull) the first
time, then installs the launchd (macOS) or systemd (Linux) service.

When it finishes, visit `http://localhost:8090/a2a-connect` for the
connect dashboard with token, copy-paste prompt, and live activity feed.

Run it again any time — it's idempotent.

### 🔵 Path 3 — Don't trust this repo? Build your own.

The protocol is small enough that any competent coding agent can
implement a wire-compatible server from a single self-contained spec.

See [`BUILD_YOUR_OWN.md`](BUILD_YOUR_OWN.md). Paste the prompt into
your agent, review the code it writes, run the acceptance tests. The
result speaks `agent-comms-v1` and works alongside any other
implementation, including this one.

---

## Push-only or Push+Pull?

agent-comms ships in two flavors, picked at install time:

| Flavor | What other agents can do | Set |
|---|---|---|
| **push-only** *(default)* | Send context here. Cannot read it back. | `AGENT_COMMS_PULL_ENABLED=false` |
| **push+pull** | Send context AND fetch context addressed to them | `AGENT_COMMS_PULL_ENABLED=true` |

Push-only is the safer default — you only deliver context, you don't expose
stored content over HTTP. **Use push+pull when you want ask/reply patterns
between agents** (e.g. laptop's agent sends a question to home Mac Mini's
agent, home agent pushes back the answer, laptop pulls it).

The pull endpoint:

```
GET /context/pull?to=<my-agent>&since=<iso>&topic=<x>&limit=50
```

Filters items where the frontmatter `to` matches your agent name (or where
no `to` is set — broadcast). Auth is the same bearer token as push. This
is a CONVENIENCE for routing, not a security boundary — anyone with the
token can change the query. Per-agent token scoping is a v2 enhancement.

When pulling, agents can include a `to` field in their original push to
target a specific agent:

```json
{ "from": "claude-mbp", "to": "claude-mini", "topic": "question",
  "content": "What's the weather call you took at 2pm?", "scope": "active" }
```

## The three modes

`agent-comms` enforces network-level access at the application layer. Pick
the mode that matches how agents will reach this server.

| Mode | Bind | Token | Use when |
|---|---|---|---|
| `localhost` | `127.0.0.1` | none | Every agent runs on the same machine |
| `lan` | `0.0.0.0` | required | Agents on other devices on your wifi/ethernet |
| `tailnet` | `0.0.0.0` | required | Agents on devices joined to your tailnet (recommended cross-machine setup) |

`configure.sh` auto-detects whether Tailscale is installed and connected,
and recommends `tailnet` mode if so.

**Token options:**
- **Auto-generate** (default) — `configure.sh` calls `openssl rand -hex 32`
  and writes the result to `~/.claude/.env`. Strong, random, 64 hex chars.
- **Bring your own** — at the token prompt, type any string you prefer
  (a memorable phrase, a value from your password manager, a per-team
  shared secret). **Input is hidden** — characters don't echo to the
  screen and don't land in your shell history. Useful when multiple
  agents on multiple machines all need to know the same token and you
  don't want to copy-paste the long random one.
- **Non-interactive** — pass `--token "<your-string>"` or `--token auto`
  on the command line. The string is recorded in process args for the
  duration of the script (avoid in shared terminals); `auto` is safe.

### Why tailnet over LAN

Your tailnet is a private overlay network with built-in encryption and
device-level access control. LAN mode trusts everything on your wifi
(including IoT devices, guests, and that one app on your phone that opens
random ports). Tailnet mode trusts only devices you've authenticated.

Both require the bearer token. Tailnet is the second factor.

---

## Pushing context from another agent

The receiving side has its own skill: [`skill/agent-context-push/SKILL.md`](skill/agent-context-push/SKILL.md).

**Install on the OTHER machine** (the one that will push, not the one
running the server):

```bash
mkdir -p ~/.claude/skills
curl -fsSL https://raw.githubusercontent.com/GGCryptoh/agent-comms/main/skill/agent-context-push/SKILL.md \
  -o ~/.claude/skills/agent-context-push/SKILL.md
mkdir -p ~/.claude/skills/agent-context-push
```

Or just paste this into the other agent:

```
Read https://github.com/GGCryptoh/agent-comms/blob/main/skill/agent-context-push/SKILL.md
and follow it to push context to my agent-comms server at
http://<your-server-host>:8090. The bearer token is <your-token>.
Send a handshake push to verify the connection.
```

The agent saves the endpoint and token to its local `~/.claude/.env` and
sends pushes whenever your work patterns trigger the skill.

---

## Push payload

Single JSON POST to `/context/push`:

```json
{
  "from": "claude-code-laptop",
  "topic": "pr-review",
  "content": "## PR #42 review\n\n- ...\n- ...",
  "tags": ["pr-42", "security"],
  "scope": "archive",
  "expires": "2026-05-15",
  "id": "pr-42-review"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | string | yes | Agent identifier — used in filenames |
| `to` | string | no | Recipient agent name. Absent = broadcast. Used by pull's `?to=` filter. |
| `topic` | string | yes | Short bucket name — used in filenames |
| `content` | string | yes | Markdown payload |
| `tags` | string[] | no | For downstream search |
| `scope` | string | no | `archive` (default) / `active` / `memory` |
| `expires` | ISO date | no | For `active` scope auto-archive |
| `id` | string | no | Idempotency key |

Files land in `$AGENT_COMMS_INBOUND_DIR` (default `~/.agent-comms/inbound/`)
as YAML-frontmatter markdown. The receiving Jarvis / dashboard / script
takes it from there.

---

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| `POST` | `/context/push` | mode-aware | Receive a context push |
| `GET` | `/context/pull` | mode-aware | Fetch items (push+pull mode only — 404 otherwise) |
| `GET` | `/a2a-connect` | none | Browser dashboard — pairing code, token, paste-prompt, live feed |
| `GET` | `/a2a-connect.json` | none | Machine-readable connection metadata + capabilities |
| `GET` | `/a2a/recent?limit=20` | none | Recent push metadata (file names + timestamps only) |
| `GET` | `/health` | none | Liveness check |
| Pairing endpoints | (see [Pairing](#pairing--6-word-pin-protocol)) | mixed | `/a2a/code`, `/a2a/pair-request`, `/a2a/pair-status/:id`, `/a2a/pending`, `/a2a/accept/:id`, `/a2a/block/:id`, `/a2a/peers` |

---

## Common operations — talk to your local Claude (or any agent)

Once agent-comms is running, you don't need to remember the shell incantations.
Just ask the agent on the same machine. Here are the most common prompts and
what each one resolves to:

| Ask Claude / Codex / Cursor… | What it actually runs |
|---|---|
| "Switch agent-comms to push+pull mode and restart" | edit `AGENT_COMMS_PULL_ENABLED=true` in `~/.claude/.env`, then `launchctl kickstart -k gui/$(id -u)/com.agent-comms` (macOS) or `systemctl --user restart agent-comms` (Linux) |
| "Switch agent-comms to push-only" | same, with `AGENT_COMMS_PULL_ENABLED=false` |
| "Rotate the agent-comms bearer token" | `AGENT_COMMS_TOKEN=$(openssl rand -hex 32)` written to `~/.claude/.env`, then restart the service. Old token immediately invalid. |
| "Stop agent-comms" | `launchctl unload ~/Library/LaunchAgents/com.agent-comms.plist` (macOS) or `systemctl --user stop agent-comms` (Linux) |
| "Start agent-comms" | `launchctl load ~/Library/LaunchAgents/com.agent-comms.plist` or `systemctl --user start agent-comms` |
| "Restart agent-comms" | unload then load (macOS) / `systemctl --user restart agent-comms` (Linux) |
| "Uninstall agent-comms" | `launchctl unload …` then `rm ~/Library/LaunchAgents/com.agent-comms.plist`; or `systemctl --user disable --now agent-comms && rm ~/.config/systemd/user/agent-comms.service`. The repo and `~/.claude/.env` keys remain — delete by hand. |
| "Show agent-comms status" | `launchctl list \| grep com.agent-comms` (macOS) or `systemctl --user status agent-comms` (Linux); plus `curl -s http://localhost:8090/health` |
| "Show me recent pushes" | `curl -s http://localhost:8090/a2a/recent?limit=20 \| jq` or just open `http://localhost:8090/a2a-connect` |
| "Tail agent-comms logs" | `tail -f ~/Library/Logs/agent-comms.log` (macOS) or `tail -f ~/.local/share/agent-comms.log` (Linux) |
| "Switch to tailnet mode" | edit `AGENT_COMMS_MODE=tailnet` in `~/.claude/.env`, ensure `AGENT_COMMS_TOKEN` is set, restart |
| "Change the listen port to 9090" | edit `AGENT_COMMS_PORT=9090` in `~/.claude/.env`, restart, update any senders pointing at the old port |
| "Re-run the configurator" | `bash ~/__CODE/agent-comms/scripts/configure.sh` — interactive walk-through of all settings |
| "Update agent-comms to latest" | `cd ~/__CODE/agent-comms && git pull && bash scripts/install.sh` (re-runs idempotently) |
| "Show my pairing code" | `agent-comms code` (six BIP-39 words) |
| "Rotate the pairing code" | `agent-comms code rotate` |
| "Discover other agent-comms on the LAN" | `agent-comms discover --lan` |
| "Pair with the other machine" | `agent-comms pair <endpoint> --code "..."` (initiator) |
| "Show pending pair requests" | `agent-comms pending` (receiver) |
| "Accept the pending pair request" | `agent-comms accept <id-prefix> --rel friend --expires 30d` |
| "Block this pair request" | `agent-comms block <id-prefix>` (24h cooldown) |
| "List paired peers" | `agent-comms peers` |
| "Unpair from another machine" | `agent-comms peers remove <local-id>` |

> **Why this works:** the entire knobset is in `~/.claude/.env` (a few `AGENT_COMMS_*`
> variables). Most "ops" are just edit-the-env + restart-the-service. Any agent
> on the same machine that can read/write files and run shell commands can
> handle these prompts. No special CLI to memorize.

If you'd rather not have your agent touch `~/.claude/.env`, you can also
re-run `bash scripts/configure.sh` and walk through the interactive menus.

## Configuration

Loaded in order, later overrides earlier:
1. Process environment
2. `~/.claude/.env`
3. `./.env` (next to `server.js`)

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_COMMS_PORT` | `8090` | TCP port |
| `AGENT_COMMS_MODE` | `localhost` | `localhost` / `lan` / `tailnet` |
| `AGENT_COMMS_TOKEN` | (empty) | Required for `lan` / `tailnet` |
| `AGENT_COMMS_PULL_ENABLED` | `false` | `true` enables `GET /context/pull` (push+pull mode) |
| `AGENT_COMMS_INBOUND_DIR` | `~/.agent-comms/inbound` | Where pushes are filed |
| `AGENT_COMMS_NOTIFY` | `off` | `off` / `first50` / `all` |
| `TELEGRAM_BOT_TOKEN` | (empty) | For Telegram notifications |
| `TELEGRAM_CHAT_ID` | (empty) | For Telegram notifications |

---

## Security model

This is a small tool for one person's setup, not a multi-tenant service.

What it does:
- Localhost mode rejects `X-Forwarded-For` so an accidentally-public ngrok
  tunnel can't bypass the localhost check.
- LAN/tailnet modes require a bearer token; wrong token = 401.
- Token never appears in logs.
- File paths use slugified `from` and `topic` to prevent `..` path
  traversal.

What it does NOT do:
- No TLS. (Tailnet does it for you. LAN traffic is plaintext — don't push
  secrets.)
- No rate limiting. A misconfigured agent can flood you. Restart with a
  different port if that happens.
- No multi-tenant auth. One bearer token, one shared shelf.
- No structured audit log.

For threat models beyond a single user's home setup, fork and harden, or
build your own from [`BUILD_YOUR_OWN.md`](BUILD_YOUR_OWN.md).

### What to push

- PR review summaries (after the review)
- Research notes (after, not while in progress)
- Deployment outcomes
- Resolved support tickets
- Notable code changes (PR title + summary, not the diff)

### What NOT to push

- Secrets. API keys. Credentials. They land in plaintext on disk.
- Conversation history. Push the result, not the chatter.
- In-progress thinking. Wait for "done."
- High-volume telemetry. This is a shelf, not a log pipeline.

---

## Pairing — 6-word PIN protocol

Pairing replaces the copy-paste-the-bearer-token step with a Bluetooth-style
PIN flow. Adds `agent-comms-pair-v1` capability on top of the existing
`agent-comms-v1` push protocol.

### The protocol in 4 sentences

1. Each server has a 6-word pairing code from the BIP-39 English wordlist
   (auto-generated on first boot, rotatable any time, shown on the connect
   dashboard).
2. Initiator runs `agent-comms discover --lan` to find servers via UDP
   multicast (group `239.42.42.42:18742`, link-local TTL=1).
3. Initiator runs `agent-comms pair <endpoint> --code "..."`; receiver's
   server verifies the 6 words and queues a pending request.
4. Receiver's operator runs `agent-comms accept <id>` (or `block`) — and
   only on accept does the bearer token get returned and a peer record
   written on both sides.

### State files

All under `$AGENT_COMMS_HOME` (default `~/.agent-comms/`):

| File | Purpose |
|---|---|
| `identity.json` | Your `instance_id` (uuid) + `display_name`, generated on first boot |
| `pairing-code.txt` | Current 6-word code (regenerable via `agent-comms code rotate`) |
| `peers.json` | Paired peers: endpoint, token, rel tier, expiry policy |
| `pending.json` | Inbound pair requests awaiting accept |
| `blocklist.json` | Blocked instances with 24h expiry |
| `responses.json` | One-shot accept/block payloads cached for the initiator's poll (15-min TTL) |

### Endpoints (added in this version)

| Method | Path | Auth | What it does |
|---|---|---|---|
| `GET` | `/a2a/code` | localhost-only | Show this machine's pairing code |
| `POST` | `/a2a/code/rotate` | localhost-only | Regenerate the pairing code |
| `POST` | `/a2a/pair-request` | code-verified | Initiator sends `{from_id, from_name, code, ...}`; receiver queues pending |
| `GET` | `/a2a/pair-status/:id` | IP-locked | Initiator polls; returns `pending` / `accepted` / `blocked` (one-shot) |
| `GET` | `/a2a/pending` | localhost-only | List pending inbound requests |
| `POST` | `/a2a/accept/:id` | localhost-only | Accept; returns token + writes peer record |
| `POST` | `/a2a/block/:id` | localhost-only | Block + 24h cooldown |
| `GET` | `/a2a/peers` | localhost-only | List paired peers |
| `POST` | `/a2a/peers/:id/remove` | localhost-only | Unpair |

### Expiration policies

When you accept (or initiate) a pairing, you pick how long it lives on
**your** side. The two sides don't have to agree — Mark 1 might give Mark 2
30 days; Mark 2 might keep Mark 1 indefinitely. Choices:

- `indefinite` — until you revoke (default; right for your own machines)
- `30d`, `7d`, `6h`, `90d`, etc. — time-bounded; auto-expire and prompt to re-pair
- `once` — single-shot; valid for one message exchange, then auto-removed

### Threat model

What this defends against:

- **Passive snooper on LAN reading offers:** offers are public by design, no secret in them.
- **Forged pair-requests:** code mismatch → 401. Code is verified by the server, not the network.
- **Token theft via pending_id grab:** `pair-status` is locked to the originating IP.
- **Auto-pair social engineering:** spec forbids auto-accept. Operator runs `accept` explicitly.

What it does NOT defend against:

- A compromised endpoint at one of the two operators.
- An attacker who controls the out-of-band channel used to share the 6 words. Use a channel you trust.
- Persistent passive analysis of the (plaintext) `/context/push` traffic. Run via Tailscale or behind TLS for confidentiality.

For heavier crypto (Ed25519 message signing, X25519 ECDH per pair, envelope
encryption), see the protocol notes in the spec — that's a v2 break-protocol
change, parked for later.

---

## Telegram notifications (optional)

Set in your `.env`:

```bash
AGENT_COMMS_NOTIFY=first50    # off / first50 / all
TELEGRAM_BOT_TOKEN=<bot token from @BotFather>
TELEGRAM_CHAT_ID=<your chat id from @userinfobot>
```

`first50` is the default smart cadence — pings on the first 50 pushes,
then goes silent. Useful for chatty agents. `all` is forever-on. `off`
is silent.

---

## Troubleshooting

**"Connection refused"**
- Server isn't running. macOS: `launchctl list | grep agent-comms`.
  Linux: `systemctl --user status agent-comms`.
- Wrong host/port. Default port is 8090.
- Firewall on the server machine. macOS firewall blocks new inbound apps
  by default — System Settings → Network → Firewall → allow `node`.

**401 Unauthorized**
- Token mismatch. Compare the value on both ends. Mind shell quoting if
  the token has special characters.
- Mode is `localhost` but the request came from another machine — switch
  to `lan` or `tailnet` and restart.

**403 "localhost mode rejects proxied requests"**
- Server is in localhost mode and the request has `X-Forwarded-For`.
  Switch modes or stop proxying.

**Push works but no Telegram ping**
- `AGENT_COMMS_NOTIFY` is `off` (default) — set to `first50` or `all`.
- `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is empty.
- Rate-limited (after 50 pushes with `first50` it goes silent).

**Tailscale mode reachable from one machine but not another**
- Run `tailscale status` on both ends — they need to be in the same
  tailnet and online.
- Run `tailscale ping <other-host>` to confirm the path works at the
  network layer before debugging at the app layer.

---

## Development

```bash
git clone https://github.com/GGCryptoh/agent-comms.git
cd agent-comms
pnpm install
node server.js   # foreground; AGENT_COMMS_MODE defaults to localhost
```

Test the endpoints:

```bash
# Localhost mode (no token)
curl -s http://localhost:8090/health
curl -s http://localhost:8090/a2a-connect.json
curl -s -X POST http://localhost:8090/context/push \
  -H "Content-Type: application/json" \
  -d '{"from":"dev","topic":"test","content":"# Hi","scope":"archive"}'

# Verify file landed
ls ~/.agent-comms/inbound/dev/
```

Single-file server: ~300 LOC of logic + ~150 LOC of HTML for the connect
page. Read it end-to-end before changing it.

---

## License

MIT — see [LICENSE](LICENSE).
