#!/usr/bin/env bash
# Cloud Agent environment bootstrap for baby-lovable (workflow-agent-app).
#
# Runs once after the repository is checked out (or when a build snapshot is
# created). It installs the system + Node dependencies the host app needs and
# warms the local Supabase Docker images so `start.sh` boots quickly.
#
# It must be idempotent: safe to run again against a partially prepared machine.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SUPABASE_CLI_VERSION="v2.117.0"

log() { echo "[install] $*"; }

# ---------------------------------------------------------------------------
# 1. System packages: Docker (runs the local Supabase stack) + fuse-overlayfs
#    (Docker storage driver that works inside the nested Cloud Agent VM).
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Installing docker.io, fuse-overlayfs, uidmap ..."
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    docker.io fuse-overlayfs uidmap
  # Some base images ship a half-configured fuse3 conffile prompt; force-resolve.
  sudo dpkg --configure -a --force-confold || true
else
  log "docker already installed: $(docker --version)"
fi

# Docker 29's default nftables firewall backend cannot program rules in this
# nested VM, which breaks container-to-container networking (Supabase's realtime
# migrator can't reach Postgres). Legacy iptables works.
sudo update-alternatives --set iptables /usr/sbin/iptables-legacy || true
sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy || true

# ---------------------------------------------------------------------------
# 2. Supabase CLI (pinned) — used to run the local stack.
# ---------------------------------------------------------------------------
if ! command -v supabase >/dev/null 2>&1; then
  log "Installing Supabase CLI ${SUPABASE_CLI_VERSION} ..."
  curl -fsSL \
    "https://github.com/supabase/cli/releases/download/${SUPABASE_CLI_VERSION}/supabase_linux_amd64.tar.gz" \
    -o /tmp/supabase.tar.gz
  tar -xzf /tmp/supabase.tar.gz -C /tmp supabase
  sudo install -m 0755 /tmp/supabase /usr/local/bin/supabase
else
  log "supabase CLI already installed: $(supabase --version)"
fi

# ---------------------------------------------------------------------------
# 3. Node dependencies.
#    `npm ci` refuses to install because the committed lockfile omits a few
#    platform-specific optional deps (@swc/helpers, chokidar, @emnapi/*), so use
#    `npm install`, which reconciles them deterministically from package.json.
# ---------------------------------------------------------------------------
log "Installing Node dependencies (npm install) ..."
npm install --no-audit --no-fund

# ---------------------------------------------------------------------------
# 4. Warm the Supabase Docker images so the first boot is fast. We start a
#    throwaway dockerd, pull + apply migrations once, then tear it back down.
#    The pulled image layers persist in /var/lib/docker (captured by the build
#    snapshot); the ephemeral DB volume is discarded.
# ---------------------------------------------------------------------------
if [ ! -S /var/run/docker.sock ]; then
  log "Warming Supabase Docker images ..."
  sudo dockerd --storage-driver=fuse-overlayfs >/tmp/dockerd-install.log 2>&1 &
  DOCKERD_PID=$!

  for _ in $(seq 1 60); do
    if sudo docker info >/dev/null 2>&1; then break; fi
    sleep 1
  done
  sudo chmod 666 /var/run/docker.sock || true

  supabase start >/tmp/supabase-warm.log 2>&1 || log "supabase warm start reported an issue (non-fatal)"
  supabase stop >/dev/null 2>&1 || true

  sudo kill "$DOCKERD_PID" >/dev/null 2>&1 || true
  # Give dockerd a moment to release the socket before install exits.
  sleep 2 || true
else
  log "dockerd socket already present; skipping image warm."
fi

log "install complete."
