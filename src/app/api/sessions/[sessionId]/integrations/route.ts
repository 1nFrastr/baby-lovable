import { NextResponse } from "next/server";
import { z } from "zod";

import {
  integrationErrorResponse,
  integrationStatusResponse,
} from "@/app/api/integrations/_responses";
import {
  getIntegrationsStatus,
  linkSessionStripe,
  linkSessionSupabaseManual,
  linkSessionSupabaseViaConnect,
  publishSession,
  provisionSessionSupabase,
  refreshSessionConnections,
  unlinkSessionStripe,
  unlinkSessionSupabase,
} from "@/lib/integrations/service";
import { choosePublishTeam, disconnectPublishAccount, resumeVercelPublication } from "@/lib/integrations/vercel-publish";
import { requireSessionAuth } from "@/lib/session/auth-context";
import { getSessionMeta } from "@/lib/session/store";

const nonempty = z.string().trim().min(1).max(16_384);
const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("link_supabase_connect"),
    projectRef: nonempty.max(128).regex(/^[a-z0-9]+$/i),
  }),
  z.strictObject({
    action: z.literal("link_supabase_manual"),
    projectUrl: z.string().trim().max(2048).regex(/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/i),
    anonKey: nonempty,
    serviceRoleKey: nonempty,
    projectName: z.string().trim().min(1).max(200).optional(),
  }),
  z.strictObject({ action: z.literal("unlink_supabase") }),
  z.strictObject({ action: z.literal("provision_supabase"), organizationSlug: z.string().regex(/^[a-z0-9-]{1,100}$/) }),
  z.strictObject({
    action: z.literal("link_stripe"),
    publishableKey: nonempty.regex(/^pk_(test|live)_[A-Za-z0-9]+$/),
    secretKey: nonempty.regex(/^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/),
    webhookSecret: nonempty.regex(/^whsec_[A-Za-z0-9]+$/).optional(),
  }),
  z.strictObject({ action: z.literal("unlink_stripe") }),
  z.strictObject({ action: z.literal("publish") }),
  z.strictObject({ action: z.literal("select_vercel_team"), teamId: z.string().regex(/^team_[A-Za-z0-9]{1,128}$/) }),
  z.strictObject({ action: z.literal("unlink_vercel") }),
  z.strictObject({ action: z.literal("reconcile_vercel_publish") }),
  z.strictObject({ action: z.literal("refresh_connections") }),
]);

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
    return integrationStatusResponse(
      await getIntegrationsStatus(sessionId, auth.userId),
    );
  } catch (error) {
    return integrationErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  // Cookie authentication requires an explicit same-origin mutation boundary.
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (
    origin !== new URL(request.url).origin ||
    (site !== null && site !== "same-origin" && site !== "none")
  ) {
    return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 });
  }

  try {
    const { sessionId } = await params;
    const auth = await requireSessionAuth(request);
    const session = await getSessionMeta(sessionId, auth);
    if (!session) {
      return NextResponse.json({ error: "App not found." }, { status: 404 });
    }

    const parsed = actionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Check the connection details and try again." },
        { status: 400 },
      );
    }

    const body = parsed.data;
    let result;
    switch (body.action) {
      case "select_vercel_team":
        await choosePublishTeam(sessionId, auth.userId, body.teamId);
        result = await getIntegrationsStatus(sessionId, auth.userId);
        break;
      case "unlink_vercel":
        await disconnectPublishAccount(sessionId, auth.userId);
        result = await getIntegrationsStatus(sessionId, auth.userId);
        break;
      case "reconcile_vercel_publish":
        await resumeVercelPublication(sessionId, auth.userId);
        result = await getIntegrationsStatus(sessionId, auth.userId);
        break;
      case "provision_supabase":
        result = await provisionSessionSupabase(auth.userId, sessionId, body.organizationSlug);
        if (!result) return NextResponse.json({ provisioning: true }, { status: 202 });
        break;
      case "link_supabase_connect":
        result = await linkSessionSupabaseViaConnect({
          sessionId,
          userId: auth.userId,
          projectRef: body.projectRef,
        });
        break;
      case "link_supabase_manual":
        result = await linkSessionSupabaseManual({
          sessionId,
          userId: auth.userId,
          projectUrl: body.projectUrl,
          anonKey: body.anonKey,
          serviceRoleKey: body.serviceRoleKey,
          projectName: body.projectName,
        });
        break;
      case "unlink_supabase":
        result = await unlinkSessionSupabase(sessionId, auth.userId);
        break;
      case "link_stripe":
        if (body.publishableKey.startsWith("pk_live_") !== /^(?:sk|rk)_live_/.test(body.secretKey)) {
          return NextResponse.json(
            { error: "Use Stripe keys from the same test or live mode." },
            { status: 400 },
          );
        }
        result = await linkSessionStripe({
          sessionId,
          userId: auth.userId,
          publishableKey: body.publishableKey,
          secretKey: body.secretKey,
          webhookSecret: body.webhookSecret,
        });
        break;
      case "unlink_stripe":
        result = await unlinkSessionStripe(sessionId, auth.userId);
        break;
      case "refresh_connections":
        result = await refreshSessionConnections(sessionId, auth.userId);
        break;
      case "publish":
        result = await publishSession({ sessionId, userId: auth.userId });
        break;
    }
    return integrationStatusResponse(result);
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
