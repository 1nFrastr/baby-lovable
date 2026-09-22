#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 1 ]]; then
  echo "usage: remove.sh <pkg>..." >&2
  exit 2
fi
pnpm remove "$@"
