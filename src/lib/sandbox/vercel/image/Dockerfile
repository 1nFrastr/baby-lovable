# baby-lovable Vercel Sandbox image.
# linux/amd64 only — VCR will not serve other platforms to Sandbox.
# Keep Node / pnpm pins in sync with Daytona snapshot-image.ts and
# templates/nextjs-starter/package.json → packageManager.
FROM node:22.14.0-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep jq \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@10.12.1 \
  && pnpm --version \
  && git --version \
  && rg --version | head -n 1 \
  && jq --version

WORKDIR /vercel/sandbox

COPY starter/ /vercel/sandbox/
COPY skills/ /vercel/sandbox/.baby/skills/
COPY baby /vercel/sandbox/.baby/bin/baby
COPY warm-next-dev.sh /tmp/warm-next-dev.sh

RUN chmod +x /vercel/sandbox/.baby/bin/baby \
  && find /vercel/sandbox/.baby/skills -type f -name '*.sh' -exec chmod +x {} + \
  && chmod +x /tmp/warm-next-dev.sh \
  && pnpm install --frozen-lockfile \
  && test -f node_modules/next/package.json \
  && test -d node_modules/.pnpm \
  && node -e "require('next/package.json')" \
  && bash /tmp/warm-next-dev.sh 3000 \
  && rm -f /tmp/warm-next-dev.sh

WORKDIR /vercel/sandbox
