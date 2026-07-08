/**
 * Assignment synchronization job (GH-50..53): update the squashed repo,
 * push `sync/<branch>` to every provisioned, non-locked student repository,
 * then open (or reuse) one pull request per repository. The bot never
 * merges; conflicts are carried by the PR and resolved by the student
 * (GH-52). Idempotent: replaying re-pushes the same ref and reuses the
 * open PR, so a retry after a partial failure is safe.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Octokit } from "octokit";

import { audit } from "./audit.js";
import type { AppConfig } from "./config.js";
import { assignments, botCommits, classrooms, organizations, studentRepos } from "./db/schema.js";
import { publish } from "./events.js";
import { installationClient } from "./github/app.js";
import { openSyncWorkspace, updateSquashedRepo } from "./github/sync.js";

export interface SyncJob {
  assignmentId: string;
  [key: string]: unknown;
}

interface PrResult {
  number: number;
  reused: boolean;
}

/** Opens the sync PR or reuses the open one (never two at once, GH-51.3). */
async function upsertSyncPr(opts: {
  octokit: Octokit;
  org: string;
  repo: string;
  branch: string;
  sourceShortSha: string;
  files: { filename: string; status: string }[];
}): Promise<PrResult> {
  const { octokit, org, repo, branch, sourceShortSha, files } = opts;
  const head = `sync/${branch}`;
  const { data: open } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
    owner: org,
    repo,
    state: "open",
    head: `${org}:${head}`,
    base: branch,
    per_page: 1,
  });
  const shown = files.slice(0, 50);
  const fileList = shown.map((f) => `- \`${f.filename}\` (${f.status})`).join("\n");
  const more = files.length > shown.length ? `\n… and ${files.length - shown.length} more files.` : "";

  if (open.length > 0) {
    const pr = open[0]!;
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: org,
      repo,
      issue_number: pr.number,
      body: `Updated to \`${sourceShortSha}\`. Files now included:\n\n${fileList}${more}`,
    });
    return { number: pr.number, reused: true };
  }
  const { data: created } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
    owner: org,
    repo,
    title: `Sync assignment update (${sourceShortSha})`,
    head,
    base: branch,
    body:
      `Your teacher updated the assignment. Merge this pull request to receive:\n\n` +
      `${fileList}${more}\n\n` +
      `If GitHub reports conflicts, resolve them keeping your own work where it matters. ` +
      `Your grade is never affected by this pull request until you merge it.`,
  });
  return { number: created.number, reused: false };
}

export function makeSyncHandler(app: FastifyInstance, config: AppConfig) {
  return async ({ assignmentId }: SyncJob) => {
    const [row] = await app.db
      .select({
        assignment: assignments,
        classroomId: classrooms.id,
        installationId: organizations.installationId,
      })
      .from(assignments)
      .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
      .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
      .where(eq(assignments.id, assignmentId))
      .limit(1);
    if (!row || row.assignment.archivedAt || row.assignment.state === "draft") return;
    const a = row.assignment;
    if (!a.squashedFullName || row.installationId === null) return;

    const client = await installationClient(config, row.installationId);
    const [org, sourceRepo] = a.sourceFullName.split("/") as [string, string];
    const [, squashedRepo] = a.squashedFullName.split("/") as [string, string];

    // Step 1 (GH-51): squashed repo up to date with the source.
    const update = updateSquashedRepo({
      token: client.token,
      org,
      sourceRepo,
      squashedRepo,
      strategy: a.sourceStrategy,
      branches: a.branches,
    });

    // Step 2: propagate to provisioned, non-locked student repositories.
    const repos = await app.db
      .select()
      .from(studentRepos)
      .where(
        and(
          eq(studentRepos.assignmentId, a.id),
          eq(studentRepos.provisionStatus, "ok"),
          isNotNull(studentRepos.fullName),
          isNull(studentRepos.lockedAt),
        ),
      );

    const failures: string[] = [];
    let prs = 0;
    let skipped = 0;
    const ws = openSyncWorkspace({ token: client.token, org, squashedRepo });
    try {
      for (const repo of repos) {
        const [, repoName] = repo.fullName!.split("/") as [string, string];
        try {
          for (const branch of a.branches) {
            const pushedSha = ws.pushSyncRef(repoName, branch);
            await app.db
              .insert(botCommits)
              .values({ studentRepoId: repo.id, sha: pushedSha, kind: "sync" })
              .onConflictDoNothing();

            // Empty diff means the student is already up to date: no PR (GH-52).
            const { data: cmp } = await client.octokit.request(
              "GET /repos/{owner}/{repo}/compare/{basehead}",
              { owner: org, repo: repoName, basehead: `${branch}...sync/${branch}` },
            );
            if (cmp.ahead_by === 0) {
              skipped += 1;
              continue;
            }
            const pr = await upsertSyncPr({
              octokit: client.octokit,
              org,
              repo: repoName,
              branch,
              sourceShortSha: (update.sourceHeads[branch] ?? pushedSha).slice(0, 7),
              files: (cmp.files ?? []).map((f) => ({ filename: f.filename, status: f.status })),
            });
            prs += 1;
            await app.db
              .update(studentRepos)
              .set({ syncPrNumber: pr.number, syncPrState: "open" })
              .where(eq(studentRepos.id, repo.id));
          }
        } catch (err) {
          app.log.error({ err, repo: repo.fullName }, "sync failed for repo");
          failures.push(repo.fullName!);
        }
      }
    } finally {
      ws.dispose();
    }

    await app.db
      .update(assignments)
      .set({ syncedAt: new Date() })
      .where(eq(assignments.id, a.id));
    await audit(app.db, {
      actorType: "system",
      action: "assignment.synced",
      subjectType: "assignment",
      subjectId: a.id,
      payload: {
        branchesChanged: update.changed,
        repos: repos.length,
        pullRequests: prs,
        upToDate: skipped,
        failures,
      },
    });
    publish("assignments", [`classroom:${row.classroomId}`], {
      kind: "sync",
      message: `Sync finished for “${a.name}”: ${prs} pull request${prs === 1 ? "" : "s"} opened, ${skipped} already up to date`,
    });
    publish(
      "repos",
      repos.map((r) => `user:${r.userId}`).concat(`classroom:${row.classroomId}`),
    );
    if (failures.length > 0) {
      throw new Error(`sync incomplete: ${failures.join(", ")}`);
    }
  };
}
