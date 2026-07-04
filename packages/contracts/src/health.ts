import { z } from "zod";

export const HealthStatus = z.enum(["ok", "degraded"]);

export const HealthResponse = z.object({
  status: HealthStatus,
  checks: z.object({
    database: z.enum(["up", "down"]),
    jobs: z.enum(["up", "down"]),
  }),
  uptimeSeconds: z.number(),
});

export type HealthResponse = z.infer<typeof HealthResponse>;
