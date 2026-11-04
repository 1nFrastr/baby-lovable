import { z } from "zod";

const resourceName = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
export const backendInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("inspect_schema") }).strict(),
  z.object({ action: z.literal("apply_migration"), name: resourceName, sql: z.string().min(1).max(100_000) }).strict(),
  z.object({ action: z.literal("configure_auth") }).strict(),
  z.object({
    action: z.literal("create_bucket"), name: resourceName,
    public: z.boolean().default(false),
    allowedMimeTypes: z.array(z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/i)).min(1).max(20),
    fileSizeLimit: z.number().int().min(1).max(50 * 1024 * 1024).default(10 * 1024 * 1024),
  }).strict(),
  z.object({ action: z.literal("deploy_function"), name: resourceName, source: z.string().min(1).max(200_000) }).strict(),
  z.object({ action: z.literal("configure_stripe_webhook") }).strict(),
]);
export type BackendInput = z.infer<typeof backendInputSchema>;
