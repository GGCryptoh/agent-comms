# For coding agents — deterministic install recipe

You're an AI coding agent — Claude Code, Codex, GitHub Copilot, Cursor,
Windsurf, Aider, Continue, or any custom agent with HTTP fetch + shell
execution capabilities — and the user asked you to install
**agent-comms** by pointing you at this repo. Follow this recipe exactly.

The recipe assumes only:
- You can fetch URLs (curl, WebFetch, fetch tool, browser, etc.)
- You can run shell commands (Bash tool, terminal, etc.)
- You have read/write access to the user's home directory

## Goal

By the end, the user has a running `agent-comms` server with sane defaults,
configured for their network situation (localhost / LAN / Tailscale), with
a bearer token if applicable, and reachable on `http://<host>:8090/a2a-connect`.

## Recipe

### 1. Detect the network situation

Run, in order, and capture the outputs:

```bash
uname -s                          # Darwin or Linux
command -v tailscale && tailscale status --json 2>/dev/null | head -50
ifconfig 2>/dev/null | grep -A1 "^en0\|^eth0" | grep "inet " | head -1
hostname
```

Decision:

- **Tailscale is installed AND status shows the node is connected**
  (`Self.Online: true` in the JSON) → suggest **tailnet** mode. Capture
  the tailnet IP from `Self.TailscaleIPs[0]` and the tailnet hostname
  from `Self.HostName`.
- **No Tailscale, but the user has a LAN IP** (the `inet` line
  resolved) → ask: localhost or lan?
- **Otherwise** → localhost mode.

Do NOT decide alone if it's ambiguous. State your reading and ask the
user to confirm before continuing.

### 2. Clone the repo

```bash
git clone https://github.com/GGCryptoh/agent-comms.git ~/__CODE/agent-comms
cd ~/__CODE/agent-comms
```

If the directory exists, `git pull --ff-only` instead.

### 3. Install dependencies

```bash
pnpm install   # or: npm install
```

If neither pnpm nor npm is available, stop and tell the user to install
Node.js 18+.

### 4. Ask the user: push-only or push+pull?

Before configuring, ask:

> "Do you want push-only or push+pull? Push-only (default, safer) means
> agents can DELIVER context here but can't read it back over HTTP.
> Push+pull means agents can ALSO fetch context addressed to them — needed
> for ask/reply patterns between agents."

If they don't have a strong opinion, default to push-only.

### 5. Configure non-interactively

The configure script supports flags for headless setup:

```bash
bash scripts/configure.sh \
  --mode <localhost|lan|tailnet> \
  --token <auto|"your-token-string"> \
  --port 8090 \
  --notify <off|first50|all> \
  --pull <on|off> \
  --yes
```

- `--mode` is required. Use the value you picked in step 1.
- `--token auto` generates a 32-byte hex token via `openssl rand -hex 32`.
  Required for `lan` and `tailnet`. Ignored for `localhost`.
- If the user wants to bring their OWN token (a memorable phrase, a value
  from their password manager, a shared team secret), don't pass `--token`
  on the command line — drop the `--yes` flag for that one step and let
  the interactive prompt collect it with hidden input. Or pass
  `--token "<their-value>"` if they hand it to you directly. Don't echo
  the value back in your final report — it's a secret.
- `--port` defaults to 8090. Skip unless 8090 is taken.
- `--notify` defaults to `off`. Set `first50` if the user wants Telegram pings.
- `--pull` defaults to `off` (push-only). Set `on` if step 4 said push+pull.
- `--yes` skips all confirmation prompts.

The script writes to `~/.claude/.env` (chmod 600).

### 6. Install as a service

```bash
bash scripts/install.sh
```

This sets up launchd (macOS) or a user systemd unit (Linux) and starts the
server. Idempotent — safe to re-run.

**On Linux**, the script asks if it should run `sudo loginctl enable-linger
$USER` so the service survives reboots. If the user is non-interactive (say,
a CI run), skip lingering and tell them to run it later.

**On macOS**, the launchd plist auto-starts on reboot via `RunAtLoad=true`
+ `KeepAlive=true`. No further action needed.

### 7. Verify

```bash
curl -s http://localhost:8090/health
```

Expect `{"status":"ok","service":"agent-comms",...}`. If you don't get
that response, check `~/Library/Logs/agent-comms.log` (macOS) or
`~/.local/share/agent-comms.log` (Linux).

### 8. Report back to the user

Tell them:

- The mode you set up (localhost / lan / tailnet)
- Whether pull is enabled (push+pull vs push-only)
- The connect URL (use the tailnet hostname if tailnet mode, the LAN IP
  if lan mode, `localhost` if localhost)
- The bearer token (only if applicable — read it from `~/.claude/.env`,
  show only first/last 6 chars unless they ask for the full value)
- Whether reboot survival is set up (Linux: lingering enabled or not)
- That they can paste this prompt into ANOTHER agent on a different
  machine to enable cross-agent context push:

> "Read http://&lt;your-host&gt;:8090/a2a-connect.json and follow the
> agent-context-push protocol. The bearer token is &lt;token&gt;.
> Save it as `AGENT_COMMS_TOKEN` in `~/.claude/.env`, then send a
> handshake push with topic=handshake, scope=archive."

## Failure modes you should handle

- **gh / git not installed** → tell the user, exit
- **Node version < 18** → tell the user
- **Port 8090 already taken** → ask for a different port, re-run configure
  with `--port`
- **Service won't start** → tail the log file, paste the relevant lines
  back to the user, suggest fixes (most common: `AGENT_COMMS_TOKEN` not
  set in lan/tailnet mode)
- **Tailscale installed but not authenticated** → suggest the user run
  `tailscale up`, then re-run configure

## What you should NOT do

- Don't install the receiving-side skill (`skill/agent-context-push/`)
  on the SAME machine as the server. The skill is for the OTHER agent
  that will push TO this server. If the user wants both — server here,
  agents on other machines pushing to it — install the skill on those
  other machines, not this one.
- Don't enable Telegram notifications without confirming the user has
  `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set.
- Don't share the bearer token in plain text via any channel that's
  publicly logged or recorded. Use the value the user can read from
  `~/.claude/.env` themselves.

## When in doubt

Read the [main README](README.md). Read [`server.js`](server.js). The
codebase is intentionally small (~300 LOC of server logic) so you can
comprehend it end-to-end before making changes.
