const VERCEL_DEV_ORIGIN = "*.vercel.run";

/**
 * Next.js `allowedDevOrigins` must include the public preview hostname or
 * `/_next` assets are blocked (SSR HTML, no hydration, no overlay).
 */
export function withVercelAllowedDevOrigin(source: string): string {
  if (
    source.includes(`"${VERCEL_DEV_ORIGIN}"`) ||
    source.includes(`'${VERCEL_DEV_ORIGIN}'`)
  ) {
    return source;
  }

  if (/allowedDevOrigins\s*:/.test(source)) {
    return source.replace(
      /allowedDevOrigins\s*:\s*\[/,
      `allowedDevOrigins: [${JSON.stringify(VERCEL_DEV_ORIGIN)}, `,
    );
  }

  return source.replace(
    /(const nextConfig(?::\s*\w+)?\s*=\s*\{)/,
    `$1\n  allowedDevOrigins: [${JSON.stringify(VERCEL_DEV_ORIGIN)}],`,
  );
}
