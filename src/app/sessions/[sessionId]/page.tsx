import { AppShell } from "@/components/app-shell";

interface SessionPageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function SessionPage({ params }: SessionPageProps) {
  const { sessionId } = await params;
  return <AppShell initialSessionId={sessionId} />;
}
