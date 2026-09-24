import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../../config.js";
import { installationClient } from "../../github/app.js";
import { enrollmentLogin, memberGroupRepos, revokeMember } from "../../group-repos.js";

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

/**
 * Takes a student's access away from their group repositories — every one of
 * them, or only the one of `groupId` — before a membership disappears (group
 * removal, move, roster removal; issue #2, lot 2). Answers the reply itself
 * and returns null when GitHub could not be reached or refused: the caller
 * must then leave the membership alone. Returns the repositories revoked
 * (possibly none: no repository yet, or no linked GitHub account).
 */
export async function revokeGroupAccess(
  app: FastifyInstance,
  config: AppConfig,
  req: FastifyRequest,
  reply: FastifyReply,
  opts: {
    org: { installationId: number | null; login: string };
    enrollmentId: string;
    groupId?: string;
    reason: string;
    /** What the 502 says was left unchanged. */
    refusal: string;
  },
): Promise<string[] | null> {
  const repos = await memberGroupRepos(app.db, opts.enrollmentId, opts.groupId);
  if (repos.length === 0) return [];
  const client = await clientFor(config, reply, opts.org);
  if (!client) return null;
  try {
    return await revokeMember(
      app.db,
      client.octokit,
      repos,
      { enrollmentId: opts.enrollmentId, githubLogin: await enrollmentLogin(app.db, opts.enrollmentId) },
      { actorUserId: req.user!.id, reason: opts.reason },
    );
  } catch (err) {
    req.log.error({ err, enrollmentId: opts.enrollmentId }, "group repository revocation failed");
    await reply.code(502).send({ error: "revoke_failed", message: opts.refusal });
    return null;
  }
}
