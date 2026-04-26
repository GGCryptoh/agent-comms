---
name: agent-context-push
description: Push context, findings, completed-work summaries, code review notes, research output, deployment outcomes, or any other information into a peer agent-comms server over the local network or Tailscale. Triggers when the user says "push to my agent-comms", "tell my home Jarvis", "send this to my Mac Mini", "log this with my home agent", "push context", or after completing a substantial task whose output the user would want a peer agent to know. Uses the agent-comms-v1 protocol (POST /context/push) with optional bearer auth.
trigger_keywords: push to agent-comms, tell my home jarvis, send to my mac mini, log with home agent, push context, agent-to-agent, peer agent, a2a push, send context home
---

# agent-context-push

This skill teaches a coding agent (Claude Code, Codex, Cursor, etc.) how to push
context into a peer **agent-comms** server using the `agent-comms-v1` protocol.

## When to push

Push when the user has finished substantive work whose result a peer agent
should know about. Concrete cases:

- Finishing a PR review — push the findings so the home agent can recall them
- Completing long-running research — push the summary
- Wrapping a deployment / migration / audit — push the outcome
- Resolving a customer support ticket — push the resolution + customer context
- The user explicitly says "push to my agent-comms", "tell my home Jarvis"

Do NOT push:

- Trivial replies ("yes", "ok", "done")
- Intermediate working state — only push when the work is actually finished
- Sensitive data the user hasn't asked you to share
- Things the user is still iterating on — wait for the final version

## Pre-flight (first-run setup)

Before the first push, this skill needs:

1. **The endpoint URL** — usually `http://<host>:8090/context/push`
2. **The bearer token** (lan/tailnet modes only) — from the connect dashboard at `<host>:8090/a2a-connect`

### Setup steps

1. **Ask the user where their agent-comms server lives.** Example:
   > "What's the URL of your agent-comms connect page? Visit it on the server machine — usually `http://<host>:8090/a2a-connect`."

2. **Fetch the connect JSON** (use `WebFetch` if available, else `curl`):
   ```
   GET <host>:8090/a2a-connect.json
   ```
   The response tells you:
   - `endpoint` — where to POST pushes
   - `auth` — `"bearer"` or `"localhost-only"`
   - `mode` — `localhost` / `lan` / `tailnet`
   - `scopes`, `fields`, `examples` — protocol details

3. **If `auth === "bearer"`, ask the user for the token:**
   > "Your agent-comms endpoint requires a bearer token. Visit `<host>:8090/a2a-connect` in your browser, copy the token from the 'Bearer token' card, and paste it here."

4. **Save to local env.** Append to `~/.claude/.env`:
   ```
   AGENT_COMMS_ENDPOINT=<endpoint>
   AGENT_COMMS_TOKEN=<token>
   ```
   `chmod 600 ~/.claude/.env` if it isn't already.

5. **Send a test handshake** with `topic: "handshake"` and `scope: "archive"` to verify the connection before any real pushes.

## How to push

Once configured, every push is a single HTTP POST.

### Payload

```json
{
  "from": "claude-code-mbp",
  "topic": "pr-review",
  "content": "...",
  "tags": ["pr-42", "security"],
  "scope": "archive",
  "expires": "2026-05-15",
  "id": "pr-42-review-2026-04-25"
}
```

| Field | Required | Notes |
|---|---|---|
| `from` | yes | Your agent's identifier (used in filenames) |
| `topic` | yes | Short bucket name |
| `content` | yes | The payload (markdown supported) |
| `tags` | no | Searchable tags |
| `scope` | no | `archive` (default) / `active` / `memory` — informational only on agent-comms; downstream tooling decides what each means |
| `expires` | no | ISO date for `active` scope auto-archive |
| `id` | no | Idempotency key |

### Curl

```bash
curl -X POST "$AGENT_COMMS_ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_COMMS_TOKEN" \
  -d '{
    "from": "claude-code-mbp",
    "topic": "pr-review",
    "content": "## PR #42 review\n\nKey findings:\n- ...\n",
    "scope": "archive",
    "tags": ["pr-42", "security"]
  }'
```

In `localhost` mode, omit the `Authorization` header.

### Expected responses

- `201 Created` — `{ "received": true, "filed_at": "..." }` — push succeeded
- `400 Bad Request` — payload missing `content` or invalid `scope`
- `401 Unauthorized` — bearer token wrong/missing — re-fetch from dashboard
- `403 Forbidden` — wrong network (localhost mode but you're on LAN), or proxied — switch modes or stop proxying
- `503 Service Unavailable` — server in lan/tailnet mode but no token configured

## Failure handling

If push fails:

1. **Log the failure** — don't silently drop
2. **Single retry after 5s** is OK; more aggressive retries are not
3. **Fall back to local note** — write the payload to `~/.agent-comms-pending/<timestamp>-<topic>.json`
4. **Tell the user explicitly:**
   > "Couldn't push to agent-comms (`<error>`). Saved payload to `~/.agent-comms-pending/...` — re-send with `curl -X POST ... -d @<file>`."

## Idempotency

Use the `id` field for anything that might be retried. Same id = same logical push.
Without `id`, every send creates a new file. Recommended pattern: `<topic>-<sha-or-pr-or-date>`.

## What NOT to push

- Secrets, API keys, credentials. They land in plaintext on disk.
- Full conversation history. Push the *outcome*, not the chatter.
- Unfinished work. Wait for "done", then push.

## Verification step

After every successful push, briefly confirm:

> "Pushed to agent-comms: `topic: pr-review, scope: archive, tags: [pr-42, security]`. Filed at `claude-code-mbp/2026-04-25-pr-review-...md`."

The user shouldn't have to wonder whether it landed.

## Quick reference

| Step | What |
|---|---|
| 1 | Ask user for agent-comms connect URL |
| 2 | `GET /a2a-connect.json` to read protocol |
| 3 | If bearer required, ask user for token (from connect dashboard) |
| 4 | Save endpoint + token to `~/.claude/.env` |
| 5 | Send test handshake push |
| 6 | After real work completes, push with appropriate scope |
| 7 | Confirm to user that the push landed |
