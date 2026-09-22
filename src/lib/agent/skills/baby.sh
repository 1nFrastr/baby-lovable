#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INDEX="$ROOT/skills/index.tsv"

usage() {
  echo "Usage: baby skills | baby skill <name>" >&2
  exit 2
}

cmd="${1:-skills}"
case "$cmd" in
  skills)
    if [[ ! -f "$INDEX" ]]; then
      echo "No skills installed." >&2
      exit 1
    fi
    echo "Skills (read SKILL.md then exec; do not load all):"
    while IFS=$'\t' read -r name description || [[ -n "${name:-}" ]]; do
      [[ -z "${name:-}" || "$name" == \#* ]] && continue
      echo "- ${name}: ${description}"
    done < "$INDEX"
    ;;
  skill)
    name="${2:-}"
    [[ -n "$name" ]] || usage
    file="$ROOT/skills/${name}/SKILL.md"
    if [[ ! -f "$file" ]]; then
      echo "Unknown skill: ${name}" >&2
      echo "Run: baby skills" >&2
      exit 1
    fi
    cat "$file"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    ;;
esac
