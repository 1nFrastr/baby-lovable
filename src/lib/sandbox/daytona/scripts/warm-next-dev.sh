#!/usr/bin/env bash
# Bake Turbopack/dev filesystem cache (`.next/dev`) into the Daytona snapshot.
# `next build` does not warm `next dev` — caches are separate directories.
set -eu

PORT="${1:-3000}"
WARM_LOG="${WARM_LOG:-/tmp/next-dev-warm.log}"

rm -rf .next
pnpm dev --port "${PORT}" --hostname 127.0.0.1 >"${WARM_LOG}" 2>&1 &
DEV_PID=$!

cleanup() {
  kill "${DEV_PID}" 2>/dev/null || true
  wait "${DEV_PID}" 2>/dev/null || true
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 90); do
  if ! kill -0 "${DEV_PID}" 2>/dev/null; then
    echo "next dev exited early during snapshot warm:" >&2
    cat "${WARM_LOG}" >&2 || true
    exit 1
  fi
  # HTTP < 500 means the app answered (same readiness bar as preview probe).
  if node -e "fetch('http://127.0.0.1:${PORT}/').then((r)=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"; then
    ready=1
    break
  fi
  sleep 2
done

if [ "${ready}" != "1" ]; then
  echo "timed out waiting for next dev on :${PORT} during snapshot warm:" >&2
  cat "${WARM_LOG}" >&2 || true
  exit 1
fi

cleanup
trap - EXIT

# Persist filesystem cache; drop the warm-run log file noise.
rm -f .next/dev/logs/next-development.log 2>/dev/null || true
test -d .next/dev
