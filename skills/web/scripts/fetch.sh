#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$here/lib.sh"
if [[ $# -lt 1 ]]; then
  echo "usage: fetch.sh <url> [keenable fetch flags]" >&2
  exit 2
fi
ensure_keenable
exec "$KEENABLE_BIN" fetch "$@"
