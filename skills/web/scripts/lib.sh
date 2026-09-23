# Shared by search.sh and fetch.sh. Not a standalone command.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "source this file from search.sh or fetch.sh" >&2
  exit 2
fi

ensure_keenable() {
  local root
  root="$(pwd)"
  while [[ "$root" != "/" && ! -d "$root/.baby" ]]; do
    root="$(dirname "$root")"
  done
  if [[ ! -d "$root/.baby" ]]; then
    echo "keenable: .baby runtime is missing" >&2
    return 1
  fi
  export KEENABLE_HOME="$root/.baby/keenable"
  export KEENABLE_APP_TITLE="${KEENABLE_APP_TITLE:-baby-lovable}"
  mkdir -p "$KEENABLE_HOME"
  if [[ -x /usr/local/bin/keenable ]]; then
    KEENABLE_BIN="/usr/local/bin/keenable"
    return 0
  fi
  if command -v keenable >/dev/null 2>&1; then
    KEENABLE_BIN="$(command -v keenable)"
    return 0
  fi
  echo "keenable: CLI is not in this sandbox image. Rebuild the Vercel image or Daytona snapshot." >&2
  return 1
}
