import type { FastifyReply } from "fastify";

import type { AppConfig } from "../../config.js";
import { installationClient } from "../../github/app.js";

/**
 * Repository-name slug of a free-text name: accents folded, everything else
 * collapsed to single dashes, capped at 60 characters. Shared by assignments
 * (`<slug>-squashed`, student repositories) and groups (`<assignment-slug>-
 * <group-slug>`), and it lives here rather than in lifecycle.ts so groups.ts
 * can reuse it without an import cycle (lifecycle.ts imports the publish
 * guard from groups.ts). Returns "" when the name has no usable character.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

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
