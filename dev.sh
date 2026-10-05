#!/usr/bin/env bash
set -e
export PATH="$HOME/.bun/bin:$PATH"

if ! command -v bun &>/dev/null; then
  echo "[Installer] Bun not found — installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "[Installer] Installing dependencies..."
bun install

echo "[Installer] Launching Electron..."
exec bun run start
