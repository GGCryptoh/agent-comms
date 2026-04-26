#!/usr/bin/env bash
# Install agent-comms as a launchd service (macOS) or systemd unit (Linux).
# Idempotent: safe to re-run.
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OS="$(uname -s)"

echo ""
echo "============================================"
echo "  agent-comms — service install"
echo "============================================"
echo ""
echo "Repo:    $REPO_DIR"
echo "OS:      $OS"
echo ""

# ── Dependencies ──
if ! command -v node >/dev/null 2>&1; then
  echo "✗ node is not installed. Install Node.js 18+ first."
  exit 1
fi

if [[ ! -d "$REPO_DIR/node_modules" ]]; then
  echo "Installing npm dependencies..."
  ( cd "$REPO_DIR" && (pnpm install --silent 2>/dev/null || npm install --silent) )
fi

if [[ ! -f "$HOME/.claude/.env" ]] || ! grep -qE "^AGENT_COMMS_MODE=" "$HOME/.claude/.env" 2>/dev/null; then
  echo "ℹ AGENT_COMMS_MODE not configured yet — running configure.sh first"
  echo ""
  bash "$REPO_DIR/scripts/configure.sh" "$@"
  echo ""
  echo "── Continuing with service install ──"
  echo ""
fi

# ── macOS: launchd ──
if [[ "$OS" == "Darwin" ]]; then
  PLIST_SRC="$REPO_DIR/launchd/com.agent-comms.plist"
  PLIST_DST="$HOME/Library/LaunchAgents/com.agent-comms.plist"

  if [[ ! -f "$PLIST_SRC" ]]; then
    echo "✗ template not found: $PLIST_SRC"
    exit 1
  fi

  mkdir -p "$HOME/Library/LaunchAgents"
  mkdir -p "$HOME/Library/Logs"

  # Render template (replace __HOME__ + __REPO__)
  sed -e "s|__HOME__|$HOME|g" -e "s|__REPO__|$REPO_DIR|g" "$PLIST_SRC" > "$PLIST_DST"

  # Reload (unload first if already loaded, ignore errors)
  launchctl unload "$PLIST_DST" >/dev/null 2>&1 || true
  launchctl load "$PLIST_DST"

  echo "✓ launchd agent installed: $PLIST_DST"
  echo "  PID: $(launchctl list | grep com.agent-comms | awk '{print $1}')"
  echo "  Logs: ~/Library/Logs/agent-comms.log"
  echo "  ✓ Auto-starts on reboot (RunAtLoad=true, KeepAlive=true)"
  echo ""
  echo "  To stop:    launchctl unload $PLIST_DST"
  echo "  To restart: launchctl unload $PLIST_DST && launchctl load $PLIST_DST"

# ── Linux: systemd ──
elif [[ "$OS" == "Linux" ]]; then
  UNIT_DST="$HOME/.config/systemd/user/agent-comms.service"
  mkdir -p "$(dirname "$UNIT_DST")"

  PORT="$(grep -E '^AGENT_COMMS_PORT=' "$HOME/.claude/.env" | cut -d= -f2- || echo 8090)"
  PORT="${PORT:-8090}"

  cat > "$UNIT_DST" <<UNIT
[Unit]
Description=agent-comms — A2A context push server
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=$(command -v node) $REPO_DIR/server.js
Restart=on-failure
RestartSec=10
EnvironmentFile=-$HOME/.claude/.env
StandardOutput=append:$HOME/.local/share/agent-comms.log
StandardError=append:$HOME/.local/share/agent-comms.log

[Install]
WantedBy=default.target
UNIT

  mkdir -p "$HOME/.local/share"
  systemctl --user daemon-reload
  systemctl --user enable agent-comms.service
  systemctl --user restart agent-comms.service

  echo "✓ systemd unit installed: $UNIT_DST"
  echo "  Status: systemctl --user status agent-comms"
  echo "  Logs: ~/.local/share/agent-comms.log"

  # ── Reboot survival on Linux: user systemd units don't auto-start unless
  # ── lingering is enabled for the user account.
  echo ""
  echo "── Reboot survival ──"
  LINGER="$(loginctl show-user "$USER" --property=Linger 2>/dev/null | cut -d= -f2)"
  if [[ "$LINGER" == "yes" ]]; then
    echo "✓ User lingering already enabled — service auto-starts on reboot."
  else
    echo "⚠ User lingering is NOT enabled."
    echo "  Without it, the service stops when you log out and won't auto-start"
    echo "  after a reboot until you log back in."
    echo ""
    if [[ -t 0 ]]; then
      read -p "  Enable lingering now? Requires sudo. [Y/n]: " ans
    else
      ans="n"
    fi
    if [[ ! "$ans" =~ ^[Nn] ]]; then
      if sudo loginctl enable-linger "$USER"; then
        echo "  ✓ Lingering enabled. Service will now survive reboots."
      else
        echo "  ✗ enable-linger failed (sudo cancelled or not available)."
        echo "    Run later: sudo loginctl enable-linger $USER"
      fi
    else
      echo "  Skipped. To enable later: sudo loginctl enable-linger $USER"
    fi
  fi

else
  echo "✗ unsupported OS: $OS (only macOS + Linux)"
  exit 1
fi

echo ""
echo "Connect page: http://localhost:${PORT:-8090}/a2a-connect"
