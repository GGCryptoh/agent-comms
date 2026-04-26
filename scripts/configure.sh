#!/usr/bin/env bash
# Interactive (or non-interactive) configure for agent-comms.
# Writes/updates ~/.claude/.env with AGENT_COMMS_* values.
#
# Interactive:
#   bash scripts/configure.sh
#
# Non-interactive (for coding agents):
#   bash scripts/configure.sh --mode lan --token auto --port 8090 --notify first50 --yes
#
# Flags:
#   --mode <localhost|lan|tailnet>   Auth mode
#   --token <value|auto>             Bearer token (auto = openssl rand -hex 32)
#   --port <num>                     Listen port (default 8090)
#   --notify <off|first50|all>       Telegram notify cadence
#   --pull <on|off>                  Bidirectional mode (push+pull). Default off.
#   --yes / -y                       Skip prompts; require all needed flags
#
# In interactive mode, agent-comms detects Tailscale and offers tailnet as
# a smart default if the node is connected.

set -e

CLAUDE_DIR="$HOME/.claude"
ENV_FILE="$CLAUDE_DIR/.env"
mkdir -p "$CLAUDE_DIR"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ─────────────────────────────────────────────────────────────────────
# Arg parsing
# ─────────────────────────────────────────────────────────────────────
ARG_MODE=""
ARG_TOKEN=""
ARG_PORT=""
ARG_NOTIFY=""
ARG_PULL=""
ARG_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)    ARG_MODE="$2"; shift 2 ;;
    --mode=*)  ARG_MODE="${1#*=}"; shift ;;
    --token)   ARG_TOKEN="$2"; shift 2 ;;
    --token=*) ARG_TOKEN="${1#*=}"; shift ;;
    --port)    ARG_PORT="$2"; shift 2 ;;
    --port=*)  ARG_PORT="${1#*=}"; shift ;;
    --notify)  ARG_NOTIFY="$2"; shift 2 ;;
    --notify=*) ARG_NOTIFY="${1#*=}"; shift ;;
    --pull)    ARG_PULL="$2"; shift 2 ;;
    --pull=*)  ARG_PULL="${1#*=}"; shift ;;
    --yes|-y)  ARG_YES=1; shift ;;
    -h|--help)
      sed -n '2,/^set -e$/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 2 ;;
  esac
done

# Helpers
read_env()  { grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }
write_env() {
  local key="$1" val="$2" tmp
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    tmp="$(mktemp)"
    grep -vE "^${key}=" "$ENV_FILE" > "$tmp"
    echo "${key}=${val}" >> "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
}

# ─────────────────────────────────────────────────────────────────────
# Tailscale detection
# ─────────────────────────────────────────────────────────────────────
TAILSCALE_AVAILABLE=0
TAILSCALE_UP=0
TAILSCALE_HOSTNAME=""
TAILSCALE_IP=""
if command -v tailscale >/dev/null 2>&1; then
  TAILSCALE_AVAILABLE=1
  if tailscale status >/dev/null 2>&1; then
    TAILSCALE_UP=1
    TAILSCALE_HOSTNAME="$(tailscale status --json 2>/dev/null | grep -oE '"HostName":\s*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
    TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -1)"
  fi
fi

# Existing values
CUR_MODE="$(read_env AGENT_COMMS_MODE)"
CUR_TOKEN="$(read_env AGENT_COMMS_TOKEN)"
CUR_PORT="$(read_env AGENT_COMMS_PORT)"
CUR_NOTIFY="$(read_env AGENT_COMMS_NOTIFY)"
CUR_PULL="$(read_env AGENT_COMMS_PULL_ENABLED)"

# ─────────────────────────────────────────────────────────────────────
# Banner
# ─────────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  agent-comms · configuration"
echo "============================================"
echo ""
echo "Writes to: $ENV_FILE (chmod 600)"
if [[ $TAILSCALE_UP -eq 1 ]]; then
  echo "Tailscale: ✓ connected (host=${TAILSCALE_HOSTNAME:-?} ip=${TAILSCALE_IP:-?})"
elif [[ $TAILSCALE_AVAILABLE -eq 1 ]]; then
  echo "Tailscale: installed but not connected — run 'tailscale up' to enable tailnet mode"
else
  echo "Tailscale: not installed (install via 'brew install tailscale' or apt to enable tailnet mode)"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────
# MODE
# ─────────────────────────────────────────────────────────────────────
MODE=""
if [[ -n "$ARG_MODE" ]]; then
  MODE="$ARG_MODE"
elif [[ $ARG_YES -eq 1 ]]; then
  echo "Error: --yes requires --mode" >&2
  exit 2
else
  echo "── Mode ──"
  echo "Pick how agents will reach this server:"
  echo "  1) localhost — only this machine (no token needed) [SAFEST]"
  if [[ $TAILSCALE_UP -eq 1 ]]; then
    echo "  2) lan       — anywhere on your wifi/ethernet (token required)"
    echo "  3) tailnet   — anywhere on your tailnet (token required) [RECOMMENDED — Tailscale is up]"
    DEFAULT_CHOICE="3"
  else
    echo "  2) lan       — anywhere on your wifi/ethernet (token required)"
    echo "  3) tailnet   — anywhere on your tailnet (token required) [Tailscale not up — see above]"
    DEFAULT_CHOICE="1"
  fi
  case "$CUR_MODE" in
    localhost) DEFAULT_CHOICE="1" ;;
    lan)       DEFAULT_CHOICE="2" ;;
    tailnet)   DEFAULT_CHOICE="3" ;;
  esac
  echo ""
  read -p "Mode [1-3, default $DEFAULT_CHOICE]: " choice
  choice="${choice:-$DEFAULT_CHOICE}"
  case "$choice" in
    1) MODE="localhost" ;;
    2) MODE="lan" ;;
    3) MODE="tailnet" ;;
    *) echo "Invalid; defaulting to localhost"; MODE="localhost" ;;
  esac
fi

case "$MODE" in
  localhost|lan|tailnet) ;;
  *) echo "Error: invalid mode '$MODE' (must be localhost / lan / tailnet)" >&2; exit 2 ;;
esac

if [[ "$MODE" == "tailnet" && $TAILSCALE_UP -ne 1 ]]; then
  echo ""
  echo "⚠ You picked tailnet mode but Tailscale isn't connected on this machine."
  if [[ $ARG_YES -eq 1 ]]; then
    echo "  Continuing anyway — server will start but other tailnet devices can't reach it"
    echo "  until you run 'tailscale up'."
  else
    read -p "Continue anyway? [y/N]: " cont
    [[ ! "$cont" =~ ^[Yy] ]] && { echo "Aborted."; exit 1; }
  fi
fi

echo "  → mode: $MODE"

# ─────────────────────────────────────────────────────────────────────
# TOKEN
# ─────────────────────────────────────────────────────────────────────
TOKEN=""
if [[ "$MODE" != "localhost" ]]; then
  if [[ -n "$ARG_TOKEN" ]]; then
    if [[ "$ARG_TOKEN" == "auto" ]]; then
      TOKEN="$(openssl rand -hex 32)"
      echo "  → token: auto-generated"
    else
      TOKEN="$ARG_TOKEN"
      echo "  → token: provided via --token"
    fi
  elif [[ $ARG_YES -eq 1 ]]; then
    echo "Error: --yes with mode=$MODE requires --token (use 'auto' to generate)" >&2
    exit 2
  else
    echo ""
    echo "── Bearer token ──"
    if [[ -n "$CUR_TOKEN" ]]; then
      echo "Existing token found (${CUR_TOKEN:0:6}…${CUR_TOKEN: -4})."
      read -p "Keep existing? [Y/n]: " keep
      [[ ! "$keep" =~ ^[Nn] ]] && TOKEN="$CUR_TOKEN"
    fi
    if [[ -z "$TOKEN" ]]; then
      echo ""
      echo "Enter your own token (input hidden — type and press Enter)"
      echo "or just press Enter to auto-generate a 32-byte hex token."
      # Silent / password-style input so the token doesn't echo to the screen
      # or get captured in shell history. read -s suppresses local echo;
      # we still print a newline manually so the next prompt aligns.
      if [[ -t 0 ]]; then
        read -rs -p "Token: " typed
        echo ""
      else
        read -r typed
      fi
      if [[ -n "$typed" ]]; then
        TOKEN="$typed"
        echo "  → using your token (${#TOKEN} chars)"
      else
        TOKEN="$(openssl rand -hex 32)"
        echo "  → auto-generated 64-char hex token"
      fi
    fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────
# PORT
# ─────────────────────────────────────────────────────────────────────
PORT=""
if [[ -n "$ARG_PORT" ]]; then
  PORT="$ARG_PORT"
else
  DEFAULT_PORT="${CUR_PORT:-8090}"
  if [[ $ARG_YES -eq 1 ]]; then
    PORT="$DEFAULT_PORT"
  else
    read -p "Port [default $DEFAULT_PORT]: " typed
    PORT="${typed:-$DEFAULT_PORT}"
  fi
fi
echo "  → port: $PORT"

# ─────────────────────────────────────────────────────────────────────
# NOTIFY
# ─────────────────────────────────────────────────────────────────────
NOTIFY=""
if [[ -n "$ARG_NOTIFY" ]]; then
  NOTIFY="$ARG_NOTIFY"
elif [[ $ARG_YES -eq 1 ]]; then
  NOTIFY="${CUR_NOTIFY:-off}"
else
  echo ""
  echo "── Telegram notifications ──"
  echo "  1) off      — silent [DEFAULT]"
  echo "  2) first50  — first 50 pushes only"
  echo "  3) all      — every push"
  DEF="1"
  case "$CUR_NOTIFY" in first50) DEF="2";; all) DEF="3";; esac
  read -p "Notify [1-3, default $DEF]: " ncho
  ncho="${ncho:-$DEF}"
  case "$ncho" in
    1) NOTIFY="off" ;;
    2) NOTIFY="first50" ;;
    3) NOTIFY="all" ;;
    *) NOTIFY="off" ;;
  esac
fi
case "$NOTIFY" in
  off|first50|all) ;;
  *) echo "Error: invalid notify '$NOTIFY' (off|first50|all)" >&2; exit 2 ;;
esac
echo "  → notify: $NOTIFY"

# ─────────────────────────────────────────────────────────────────────
# PULL — push-only vs push+pull (bidirectional)
# ─────────────────────────────────────────────────────────────────────
PULL=""
if [[ -n "$ARG_PULL" ]]; then
  case "$(echo "$ARG_PULL" | tr '[:upper:]' '[:lower:]')" in
    on|true|yes|1|pull|push+pull) PULL="true" ;;
    off|false|no|0|push|push-only) PULL="false" ;;
    *) echo "Error: invalid --pull '$ARG_PULL' (on|off)" >&2; exit 2 ;;
  esac
elif [[ $ARG_YES -eq 1 ]]; then
  PULL="${CUR_PULL:-false}"
else
  echo ""
  echo "── Push-only or Push+Pull? ──"
  echo "  1) push-only — agents only deliver context here. Default. Safer."
  echo "  2) push+pull — agents can also fetch context they're addressed in."
  echo "                 Required for ask/reply patterns between agents."
  DEF="1"
  [[ "$CUR_PULL" == "true" ]] && DEF="2"
  read -p "Choice [1-2, default $DEF]: " p
  p="${p:-$DEF}"
  case "$p" in
    1) PULL="false" ;;
    2) PULL="true" ;;
    *) PULL="false" ;;
  esac
fi
echo "  → pull: $([[ "$PULL" == "true" ]] && echo "enabled (bidirectional)" || echo "disabled (push-only)")"

# ─────────────────────────────────────────────────────────────────────
# Write
# ─────────────────────────────────────────────────────────────────────
write_env AGENT_COMMS_MODE "$MODE"
write_env AGENT_COMMS_PORT "$PORT"
write_env AGENT_COMMS_NOTIFY "$NOTIFY"
write_env AGENT_COMMS_PULL_ENABLED "$PULL"
[[ -n "$TOKEN" ]] && write_env AGENT_COMMS_TOKEN "$TOKEN" || true

echo ""
echo "============================================"
echo "  Done. Configuration saved."
echo "============================================"
echo ""
echo "  Mode:    $MODE"
echo "  Port:    $PORT"
[[ -n "$TOKEN" ]] && echo "  Token:   ${TOKEN:0:6}…${TOKEN: -4}  (full value in $ENV_FILE)"
echo "  Notify:  $NOTIFY"

# Friendly URL hint
if [[ "$MODE" == "tailnet" && -n "$TAILSCALE_HOSTNAME" ]]; then
  echo ""
  echo "  Connect URL (paste into other agents):"
  echo "    http://${TAILSCALE_HOSTNAME}:${PORT}/a2a-connect"
  [[ -n "$TAILSCALE_IP" ]] && echo "    or http://${TAILSCALE_IP}:${PORT}/a2a-connect"
elif [[ "$MODE" == "lan" ]]; then
  LAN_IP="$(ifconfig 2>/dev/null | awk '/^en0|^eth0/{flag=1; next} /^[a-z]/{flag=0} flag && /inet /{print $2; exit}')"
  echo ""
  echo "  Connect URL (paste into other agents):"
  echo "    http://${LAN_IP:-<your-lan-ip>}:${PORT}/a2a-connect"
else
  echo ""
  echo "  Connect URL (this machine only):"
  echo "    http://localhost:${PORT}/a2a-connect"
fi

echo ""
echo "  Next: bash $(cd "$(dirname "$0")" && pwd)/install.sh"
echo ""
