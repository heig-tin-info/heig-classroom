import type { FastifyReply } from "fastify";

import type { AppConfig } from "../../config.js";
import { installationClient } from "../../github/app.js";

/** Installation client of the classroom's org, or 409 when the App is absent. */
export async function clientFor(
  config: AppConfig,
  reply: FastifyReply,
  org: { installationId: number | null; login: string },
) {
  if (org.installationId === null) {
    await reply.code(409).send({
      error: "app_not_installed",
      message: `GitHub App is not installed on ${org.login}`,
    });
    return null;
  }
  return installationClient(config, org.installationId);
}
