import { AppShell } from "@/components/app-shell";
import { QueryProvider } from "@/components/query-provider";

export default function SessionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <QueryProvider>
      <AppShell />
      {children}
    </QueryProvider>
  );
}
