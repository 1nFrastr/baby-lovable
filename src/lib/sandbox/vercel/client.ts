export function vercelAuthOptions(): {
  token: string;
  teamId: string;
  projectId: string;
} | Record<string, never> {
  const token = process.env.VERCEL_TOKEN?.trim();
  const teamId =
    process.env.VERCEL_TEAM_ID?.trim() || process.env.VERCEL_ORG_ID?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }
  return {};
}
