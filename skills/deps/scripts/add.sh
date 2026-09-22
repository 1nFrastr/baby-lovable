#!/usr/bin/env bash
set -euo pipefail
dev=0
if [[ "${1:-}" == "--dev" || "${1:-}" == "-D" ]]; then
  dev=1
  shift
fi
if [[ $# -lt 1 ]]; then
  echo "usage: add.sh [--dev] <pkg>..." >&2
  exit 2
fi
if [[ "$dev" == 1 ]]; then
  pnpm add -D "$@"
else
  pnpm add "$@"
fi
