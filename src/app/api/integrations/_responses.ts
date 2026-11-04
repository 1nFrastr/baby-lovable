import { NextResponse } from "next/server";

import { IntegrationProviderError } from "@/lib/integrations/http";
import { IntegrationError } from "@/lib/integrations/service";
import { SupabaseManagementError } from "@/lib/integrations/supabase-management";
import type { SessionIntegrationsProjection } from "@/lib/integrations/types";
import { PUBLISH_ERRORS, redactPublishLogs } from "@/lib/integrations/vercel-publish";
import {
  SessionAccessDeniedError,
  UnauthenticatedError,
} from "@/lib/session/auth-context";

type IntegrationResult = SessionIntegrationsProjection & {
  preview?: {
    status: "pending" | "ready" | "error";
    error: string | null;
  };
};

export function integrationErrorResponse(error: unknown) {
  let status = 500;
  let message = "The request could not be completed. Please try again.";
  if (error instanceof UnauthenticatedError) {
    status = 401;
    message = "Please sign in and try again.";
  } else if (error instanceof SessionAccessDeniedError) {
    status = 403;
    message = "You do not have access to this app.";
  } else if (
    error instanceof IntegrationProviderError ||
    error instanceof SupabaseManagementError
  ) {
    if (error.status === 401 || error.status === 403) {
      status = 400;
      message = "The provider rejected this connection. Check your keys or reconnect your account and review project permissions.";
    } else if (error.status === 429) {
      status = 429;
      message = "The provider is busy. Wait a moment and try again.";
    } else if (error.status === 504 || error.status === null) {
      status = 504;
      message = "The provider did not respond in time. Please try again.";
    } else {
      status = 502;
      message = "The provider could not complete the request. Please try again.";
    }
  } else if (error instanceof IntegrationError) {
    switch (error.status) {
      case 400:
        status = 400;
        message = "Check the connection details and try again.";
        break;
      case 401:
        status = 401;
        message = "Please sign in or reconnect your provider account.";
        break;
      case 403:
        status = 403;
        message = "You do not have access to this app or provider project.";
        break;
      case 404:
        status = 404;
        message = "The app or provider project could not be found.";
        break;
      case 409:
        status = 409;
        message = "The app is not ready for this action. Try again shortly.";
        break;
      case 429:
        status = 429;
        message = "Account connections are busy. Please try again shortly.";
        break;
      case 502:
        status = 502;
        message = "The provider could not complete the request. Please try again.";
        break;
      case 503:
        status = 503;
        message = "This connection is not available yet. Please try again later.";
        break;
    }
  }
  if (error instanceof IntegrationError && ["connect_authorization_required", "stripe_binding_changed"].includes(error.code ?? "")) {
    status = 409;
    message = "The account connection changed or expired. Reconnect the service in Backend before continuing.";
  }
  if (error instanceof IntegrationError && error.code === "publish_uncertain") {
    status = 502;
    message = "Publishing needs attention. Contact support before trying again.";
  }
  if (error instanceof IntegrationError && error.code === "supabase_provision_permission") {
    status = 403;
    message = "Supabase denied project creation. Check your organization role and reconnect with Projects write access.";
  }
  if (error instanceof IntegrationError && error.code === "supabase_provision_declined") {
    status = 400;
    message = "Supabase declined project creation. Check the organization’s project limits in Supabase, or link an existing project.";
  }
  if (error instanceof IntegrationError) {
    // Only fixed messages for these host-generated codes may cross this boundary.
    const adminErrors: Record<string, [number, string]> = {
      supabase_admin_reconnect: [409, "Reconnect Supabase through Connect in Backend to enable project administration. Projects linked with API keys cannot use these controls."],
      supabase_admin_unlinked: [409, "Link a Supabase project in Backend before using these controls."],
      supabase_admin_host_project: [400, "Choose a separate Supabase project for this app. The builder's own project cannot be administered here."],
      supabase_admin_busy: [409, "Wait for the current app changes to finish before updating authentication settings."],
      supabase_admin_project_inactive: [409, "This app's Supabase project is paused. Resume the project in Supabase, then refresh this panel."],
      supabase_admin_invalid_settings: [400, "Provide at least one supported authentication setting. Use booleans, an HTTP or HTTPS site URL, and an array of redirect URLs."],
      supabase_admin_invalid_rows: [400, "Choose an available app table and valid columns, filter, sort order, and page size."],
      supabase_admin_invalid_users: [400, "Use a search of up to 200 characters and a valid user page size and offset."],
    };
    const code = error.code ?? "";
    if (Object.hasOwn(adminErrors, code)) [status, message] = adminErrors[code];
  }
  if (error instanceof IntegrationError) {
    if (error.code && Object.hasOwn(PUBLISH_ERRORS, error.code)) {
      status = error.status;
      message = PUBLISH_ERRORS[error.code];
    } else if (error.code === "vercel_api_error") {
      status = error.status === 401 || error.status === 403 ? 409 : error.status === 429 ? 429 : 502;
      message = error.status === 401 ? PUBLISH_ERRORS.vercel_authorization_required : error.status === 403 ? PUBLISH_ERRORS.vercel_permission : PUBLISH_ERRORS.vercel_network;
    }
  }
  // Provider exceptions can contain tokens, request bodies, or internal URLs.
  // Never serialize or log the original exception at the HTTP boundary.
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function integrationStatusResponse(result: IntegrationResult) {
  const { supabase, stripe, deploy } = result;
  return NextResponse.json(
    {
      supabase: {
        status: supabase.status,
        projectRef: supabase.projectRef,
        projectName: supabase.projectName,
        projectUrl: supabase.projectUrl,
        linkMethod: supabase.linkMethod,
        error: supabase.error ? "The Supabase connection needs attention." : null,
      },
      stripe: {
        status: stripe.status,
        mode: stripe.mode,
        publishableKeyHint: stripe.publishableKeyHint,
        error: stripe.error ? "The Stripe connection needs attention." : null,
      },
      deploy: {
        status: deploy.status,
        provider: deploy.provider,
        deploymentId: deploy.deploymentId,
        url: deploy.url,
        error: deploy.errorCode && Object.hasOwn(PUBLISH_ERRORS, deploy.errorCode) ? PUBLISH_ERRORS[deploy.errorCode] : deploy.error ? (deploy.status === "deploying" ? "Publishing needs attention. Contact support before trying again." : "Publishing failed. Please try again.") : null,
        updatedAt: deploy.updatedAt,
        phase: deploy.phase ?? null,
        sourceSha: deploy.sourceSha ?? null,
        jobId: deploy.jobId ?? null,
        errorCode: deploy.errorCode && Object.hasOwn(PUBLISH_ERRORS, deploy.errorCode) ? deploy.errorCode : null,
        logs: deploy.provider === "vercel" && deploy.logs ? redactPublishLogs(deploy.logs, []) : null,
      },
      ...(result.vercel ? { vercel: {
        connected: result.vercel.connected, teamId: result.vercel.teamId, teamName: result.vercel.teamName,
        projectId: result.vercel.projectId, projectName: result.vercel.projectName, dashboardUrl: result.vercel.dashboardUrl,
      } } : {}),
      ...(result.legacyPublication ? { legacyPublication: { url: result.legacyPublication.url, updatedAt: result.legacyPublication.updatedAt } } : {}),
      connect: { supabase: result.connect?.supabase ?? false, stripe: result.connect?.stripe ?? false, vercel: result.connect?.vercel ?? false },
      secretsConfigured: result.secretsConfigured,
      supabaseOauthConfigured: result.supabaseOauthConfigured,
      supabaseAccountConnected: result.supabaseAccountConnected,
      ...(result.preview
        ? {
            preview: {
              status: result.preview.status,
              error: result.preview.error
                ? "The connection was saved, but the preview could not refresh. Please try again."
                : null,
            },
          }
        : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
