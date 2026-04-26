---
name: agent-comms-pair
description: Pair this machine with another agent-comms server on the local network using a 6-word PIN. Triggers when the user says "pair my agent", "connect to the other machine", "pair with my Mac Mini", "set up agent-comms with another laptop", "discover agent-comms on the LAN", or anything along those lines. Uses the agent-comms-pair-v1 protocol — UDP multicast probe, BIP-39 6-word code verification, explicit human accept on the receiving side. No shared bootstrap key.
trigger_keywords: pair agent-comms, connect to another agent, pair with my mac mini, pair with my laptop, agent-comms pair, discover agent-comms, agent pairing, lan pair, six word code, pairing code, connect a2a server
---

# agent-comms-pair

This skill teaches a coding agent how to pair this machine with another
agent-comms server on the same local network, using the `agent-comms-pair-v1`
protocol (Bluetooth-style PIN: 6 words from the BIP-39 English wordlist).

The full protocol and source live at
**https://github.com/GGCryptoh/agent-comms**. This skill is the on-ramp —
it tells the agent which commands to run and in what order. Read the repo
README for the full picture.

## When to trigger

When the user wants to connect this machine to another agent-comms server
on the LAN — typical phrases:

- "Pair my agent with the Mac Mini"
- "Connect to the other laptop's agent-comms"
- "Discover agent-comms on the network"
- "I have a 6-word code from the other machine"

Do not run this skill for cross-WAN pairing — it uses LAN multicast.
For agents not on the same physical network, fall back to manual setup
(`agent-comms` connect dashboard + paste-the-token) per the parent README.

## Pre-flight

1. Confirm `agent-comms` is installed locally. The CLI lives at
   `bin/agent-comms` in the repo, or on `$PATH` if installed via
   `npm install -g`.
2. Confirm the local server is running (`curl -s localhost:8090/health`).
   If not, `npm start` in the repo dir, or restart the launchd/systemd
   service.
3. Confirm you know which side you are:
   - **Initiator** (you reach out): you'll need the OTHER side's 6-word
     code and the URL discovery returns.
   - **Receiver** (someone reaches out to you): you don't need anything
     up front. A pending request will appear when the other side
     initiates.

## Initiator flow

```bash
# 1. discover other agent-comms servers on the LAN
agent-comms discover --lan

# Output lists each one with endpoint, instance_id, capabilities.

# 2. ask the OTHER operator for their 6-word pairing code
#    They run: agent-comms code   on their machine.
#    They read the words to you over a channel YOU TRUST.
#    Common channels: voice call, in-person, encrypted DM.
#    NOT email (cached / forwardable).

# 3. send the pair request
agent-comms pair <endpoint> --code "six words here" \
  --rel friend --expires 30d --name "$(hostname)"

#    Flags:
#    --rel       friend | business | full_authority | vendor | guest
#    --expires   30d, 7d, 6h, 90d, never, once
#    --name      what you want the other side to display you as

# 4. agent-comms blocks waiting for accept on the other side.
#    Tell the user: "Waiting for the other operator to accept...
#    They should run `agent-comms pending` then `agent-comms accept <id>`."

# 5. on accept, the bearer token + endpoint land in
#    ~/.agent-comms/peers.json and pushes work via existing
#    /context/push semantics.
```

## Receiver flow

```bash
# 1. user says "someone is trying to pair, accept it"
agent-comms pending

#    Output lists each pending request with:
#    - 8-char id prefix
#    - sender display_name
#    - sender ip
#    - requested rel + expiry

# 2. confirm the OTHER operator's identity before accepting.
#    If you didn't expect a pair request, BLOCK it:
#       agent-comms block <id-prefix>
#    Block adds a 24h cooldown for that instance.

# 3. accept with explicit tier and expiry
agent-comms accept <id-prefix> --rel friend --expires 30d

#    Tier choices and expiry choices match the initiator's side.
#    You don't have to match — your side picks how much YOU trust
#    them, independently.
```

## Common operations

```bash
# show your machine's pairing code (the 6 words)
agent-comms code

# rotate the code (e.g. after a successful pair, or if it leaked)
agent-comms code rotate

# list all paired peers
agent-comms peers

# unpair
agent-comms peers remove <local-id>

# first-run setup (auto-runs on server boot too)
agent-comms init --name "my-laptop"
```

## Trust model — what to tell the user

Pairing creates a `peers.json` entry on **both** sides. Each side independently
chose:
- The **relationship tier** for the other side (your trust level for them).
- The **expiry policy** (indefinite, time-bounded, single-shot).

The 6-word code is verified by the receiver's server — sending the wrong
code returns 401. The receiver also has to **explicitly accept**; sending
the right code is necessary but not sufficient.

If something feels off (different fingerprint, unexpected request,
suspicious activity), the right move is always:

```bash
agent-comms peers remove <id>      # locally, immediate
agent-comms code rotate            # invalidate the current code
```

## What this skill is NOT

- It is not the push skill. To push context, use `agent-context-push`
  (sibling skill in the same repo).
- It does not replace the bearer-token model. After pairing, pushes still
  use `Authorization: Bearer <token>`. Pairing just automates the
  copy-paste of that token, with explicit human verification.
- It does not provide envelope encryption. Messages over `/context/push`
  are still plaintext JSON over HTTP. Use Tailscale or run the server
  behind TLS for confidentiality.

## Quick reference

| Step | Initiator | Receiver |
|---|---|---|
| 1 | `discover --lan` | (server already running) |
| 2 | get 6-word code from other operator | run `agent-comms code` and read aloud |
| 3 | `pair <endpoint> --code "..."` | (request appears in `pending`) |
| 4 | (waiting) | `accept <id>` or `block <id>` |
| 5 | peer record + token written | peer record written |

## See also

- Repo: https://github.com/GGCryptoh/agent-comms
- Push skill: `skill/agent-context-push/SKILL.md`
- Build your own: `BUILD_YOUR_OWN.md`
