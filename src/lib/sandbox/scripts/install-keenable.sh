#!/usr/bin/env bash
# Bake keenable into the sandbox image. Pin matches the published GitHub release.
set -euo pipefail

VERSION="0.2.3"

case "$(uname -m)" in
  x86_64 | amd64)
    asset="keenable-cli-x86_64-unknown-linux-gnu.tar.xz"
    sha="06b8e7767085d12ae2d1d85add49ba38d415766f5224925dca0cce2a5ebdd723"
    ;;
  aarch64 | arm64)
    asset="keenable-cli-aarch64-unknown-linux-gnu.tar.xz"
    sha="95cadb59ed5ff999e38c1612115fc97083ef021c03784ccaced121f0fdaa9baa"
    ;;
  *)
    echo "keenable: unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
url="https://github.com/keenableai/keenable-cli/releases/download/v${VERSION}/${asset}"
curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$tmp/cli.tar.xz"
echo "${sha}  $tmp/cli.tar.xz" | sha256sum -c -
tar -xf "$tmp/cli.tar.xz" -C "$tmp"
bin="$(find "$tmp" -type f -name keenable -print -quit)"
if [[ -z "$bin" ]]; then
  echo "keenable: archive did not contain a keenable binary" >&2
  exit 1
fi
install -m 755 "$bin" /usr/local/bin/keenable
keenable --version
