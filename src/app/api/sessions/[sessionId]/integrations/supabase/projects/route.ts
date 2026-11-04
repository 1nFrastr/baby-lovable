import { NextResponse } from "next/server";

import { integrationErrorResponse } from "@/app/api/integrations/_responses";
import { listLinkedUserSupabaseProjects, listSupabaseProvisioningOrganizations } from "@/lib/integrations/service";
import { requireSessionAuth } from "@/lib/session/auth-context";
import { getSessionMeta } from "@/lib/session/store";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await params;
    const auth = await requireSessionAuth(request);
    const session = await getSessionMeta(sessionId, auth);
    if (!session) {
      return NextResponse.json({ error: "App not found." }, { status: 404 });
    }
    if (new URL(request.url).searchParams.has("organizations")) {
      const organizations = await listSupabaseProvisioningOrganizations(auth.userId, sessionId);
      return NextResponse.json({ organizations: organizations.map(({ slug, name }) => ({ slug, name })) }, { headers: { "Cache-Control": "no-store" } });
    }
    const projects = await listLinkedUserSupabaseProjects(auth.userId, sessionId);
    return NextResponse.json(
      {
        projects: projects.map(({ id, ref, name, region, status }) => ({
          id, ref, name, region, status,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
