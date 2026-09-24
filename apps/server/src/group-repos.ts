/**
 * Group repositories (issue #2, lot 2, ADR-014).
 *
 * Data model: ONE `student_repos` row per group repository, `group_id` set.
 * Everything that happens to a repository — pushes, CI grades, deadline,
 * freeze, LLM review, teacher adjustment — keeps happening to that one row,
 * so none of those flows had to learn about groups. What changes is the
 * question "which repository is this student's?": the members are read from
 * `assignment_group_members` (by roster entry), never copied onto the row,
 * and `user_id` is merely the student whose acceptance created it.
 *
 * This module is the single place that answers that question (read views,
 * grade sheet, refresh hints, e-mails) and the single place that grants or
 * takes back a member's GitHub access.
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Octokit } from "octokit";

import { groupRepoName, isLiveIndividualRepo, pickStudentRepo } from "@hgc/domain";

import { audit } from "./audit.js";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import {
  assignmentGroupMembers,
  assignmentGroups,
  assignments,
  classrooms,
  enrollments,
  organizations,
  studentRepos,
  users,
} from "./db/schema.js";
import { publish, type Topic } from "./events.js";
import { installationClient } from "./github/app.js";
import { inviteCollaborator, revokeCollaborator } from "./github/collaborators.js";
import { repoIsLive } from "./repos.js";

export type RepoRow = typeof studentRepos.$inferSelect;
export type GroupRow = typeof assignmentGroups.$inferSelect;

/** A member of a group with the account behind their roster entry, if any. */
export interface GroupMemberAccount {
  groupId: string;
  enrollmentId: string;
  nom: string;
  prenom: string;
  userId: string | null;
  githubLogin: string | null;
}

/** Members of the given groups, in roster order. */
export async function groupMemberAccounts(
  db: Db,
  groupIds: string[],
): Promise<GroupMemberAccount[]> {
  if (groupIds.length === 0) return [];
  return db
    .select({
      groupId: assignmentGroupMembers.groupId,
      enrollmentId: enrollments.id,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      userId: users.id,
      githubLogin: users.githubLogin,
    })
    .from(assignmentGroupMembers)
    .innerJoin(enrollments, eq(assignmentGroupMembers.enrollmentId, enrollments.id))
    .leftJoin(users, eq(enrollments.userId, users.id))
    .where(inArray(assignmentGroupMembers.groupId, groupIds))
    .orderBy(asc(enrollments.nom), asc(enrollments.prenom));
}

/** The group of a roster entry on an assignment, or null. */
export async function groupOfEnrollment(
  db: Db,
  assignmentId: string,
  enrollmentId: string,
): Promise<GroupRow | null> {
  const [row] = await db
    .select({ group: assignmentGroups })
    .from(assignmentGroupMembers)
    .innerJoin(assignmentGroups, eq(assignmentGroupMembers.groupId, assignmentGroups.id))
    .where(
      and(
        eq(assignmentGroupMembers.assignmentId, assignmentId),
        eq(assignmentGroupMembers.enrollmentId, enrollmentId),
      ),
    )
    .limit(1);
  return row?.group ?? null;
}

/** The repository row of a group, whatever its state, or null. */
export async function groupRepoRow(
  db: Db,
  assignmentId: string,
  groupId: string,
): Promise<RepoRow | null> {
  const [row] = await db
    .select()
    .from(studentRepos)
    .where(and(eq(studentRepos.assignmentId, assignmentId), eq(studentRepos.groupId, groupId)))
    .limit(1);
  return row ?? null;
}

/**
 * Users who still work in a live individual repository of the assignment. In
 * a group assignment those are lot-1 leftovers (acceptance created individual
 * repositories before lot 2): they keep that repository, so the group one
 * neither shows it to them nor invites them into it.
 */
async function individualHolders(
  db: Db,
  assignmentIds: string[],
): Promise<(assignmentId: string, userId: string) => boolean> {
  const rows = assignmentIds.length
    ? await db
        .select({
          assignmentId: studentRepos.assignmentId,
          userId: studentRepos.userId,
          groupId: studentRepos.groupId,
          provisionStatus: studentRepos.provisionStatus,
          fullName: studentRepos.fullName,
          deletedAt: studentRepos.deletedAt,
        })
        .from(studentRepos)
        .where(
          and(
            inArray(studentRepos.assignmentId, [...new Set(assignmentIds)]),
            isNull(studentRepos.groupId),
          ),
        )
    : [];
  // The rule is the domain's, not a second SQL spelling of it.
  const holders = new Set(
    rows.filter(isLiveIndividualRepo).map((r) => `${r.assignmentId}:${r.userId}`),
  );
  return (assignmentId, userId) => holders.has(`${assignmentId}:${userId}`);
}

/** A member GitHub can be asked about: an account with a linked login. */
export type ReachableMember = GroupMemberAccount & { userId: string; githubLogin: string };

/**
 * The members of a group to give access to its repository: those with a
 * linked GitHub account (the others are invited when they accept or link
 * it), minus the lot-1 individual-repository holders.
 */
export async function invitableMembers(
  db: Db,
  assignmentId: string,
  groupId: string,
): Promise<ReachableMember[]> {
  const holds = await individualHolders(db, [assignmentId]);
  return (await groupMemberAccounts(db, [groupId])).filter(
    (m): m is ReachableMember =>
      m.userId !== null && m.githubLogin !== null && !holds(assignmentId, m.userId),
  );
}

type RepoOwnership = Pick<RepoRow, "assignmentId" | "userId" | "groupId">;

/**
 * The users a set of repositories belongs to: the owner of an individual
 * repository, every member with an account for a group one (whoever created
 * it — a student moved out of the group no longer reads it), minus the lot-1
 * individual-repository holders, who do not work in it.
 */
export async function repoUserIds(db: Db, repos: RepoOwnership[]): Promise<string[]> {
  const ids = new Set<string>();
  const groupRepos = repos.filter((r) => r.groupId !== null);
  for (const r of repos) if (r.groupId === null) ids.add(r.userId);
  if (groupRepos.length === 0) return [...ids];
  const assignmentOf = new Map(groupRepos.map((r) => [r.groupId!, r.assignmentId]));
  const holds = await individualHolders(db, [...assignmentOf.values()]);
  for (const m of await groupMemberAccounts(db, [...assignmentOf.keys()])) {
    if (m.userId && !holds(assignmentOf.get(m.groupId)!, m.userId)) ids.add(m.userId);
  }
  return [...ids];
}

/** `user:<id>` refresh-hint topics of `repoUserIds`. */
export async function repoUserTopics(db: Db, repos: RepoOwnership[]): Promise<Topic[]> {
  return (await repoUserIds(db, repos)).map((id) => `user:${id}` as const);
}

/** A group as the read views show it next to a student. */
export interface GroupRef {
  id: string;
  name: string;
}

/**
 * "Which repository is this student's?" for the read views of several
 * assignments at once (detail table, grade sheet, student home): two queries,
 * then lookups. The rule itself is `pickStudentRepo` (@hgc/domain).
 */
export async function studentRepoResolver(db: Db, assignmentIds: string[]) {
  const repos = assignmentIds.length
    ? await db.select().from(studentRepos).where(inArray(studentRepos.assignmentId, assignmentIds))
    : [];
  const memberships = assignmentIds.length
    ? await db
        .select({
          assignmentId: assignmentGroupMembers.assignmentId,
          enrollmentId: assignmentGroupMembers.enrollmentId,
          id: assignmentGroups.id,
          name: assignmentGroups.name,
        })
        .from(assignmentGroupMembers)
        .innerJoin(assignmentGroups, eq(assignmentGroupMembers.groupId, assignmentGroups.id))
        .where(inArray(assignmentGroupMembers.assignmentId, assignmentIds))
    : [];

  const own = new Map<string, RepoRow>();
  const ofGroup = new Map<string, RepoRow>();
  for (const r of repos) {
    if (r.groupId) ofGroup.set(r.groupId, r);
    else own.set(`${r.assignmentId}:${r.userId}`, r);
  }
  const groups = new Map<string, GroupRef>(
    memberships.map((m) => [`${m.assignmentId}:${m.enrollmentId}`, { id: m.id, name: m.name }]),
  );

  const groupOf = (assignmentId: string, enrollmentId: string): GroupRef | null =>
    groups.get(`${assignmentId}:${enrollmentId}`) ?? null;

  return {
    repos,
    groupOf,
    repoOf(
      assignmentId: string,
      student: { enrollmentId: string; userId: string | null },
    ): RepoRow | undefined {
      const group = groupOf(assignmentId, student.enrollmentId);
      return pickStudentRepo(
        student.userId ? own.get(`${assignmentId}:${student.userId}`) : undefined,
        group ? ofGroup.get(group.id) : undefined,
      );
    },
  };
}

// --- GitHub access of the members -----------------------------------------

type Actor = { actorUserId: string | null; reason: string };

/**
 * Invites one member on a group repository (write access, like an individual
 * one), audited. Idempotent on GitHub's side: an existing collaborator is a
 * 204, an existing invitation is renewed. Throws on failure — each caller
 * decides whether a failed invitation fails its request.
 */
export async function inviteMember(
  db: Db,
  octokit: Octokit,
  repo: Pick<RepoRow, "id" | "fullName">,
  member: { enrollmentId: string; githubLogin: string },
  actor: Actor,
): Promise<"pending" | "accepted"> {
  const [owner, name] = repo.fullName!.split("/") as [string, string];
  const status = await inviteCollaborator(octokit, owner, name, member.githubLogin, "push");
  await audit(db, {
    actorUserId: actor.actorUserId,
    actorType: actor.actorUserId ? "user" : "system",
    action: "group.repo.invite",
    subjectType: "student_repo",
    subjectId: repo.id,
    payload: {
      repo: repo.fullName,
      login: member.githubLogin,
      enrollmentId: member.enrollmentId,
      invitation: status,
      reason: actor.reason,
    },
  });
  return status;
}

/**
 * Invites every member in `members`, best effort: one member GitHub refuses
 * (a renamed account, a blocked user) must not deprive the others of their
 * access. Returns the logins that failed, for the caller's audit and log.
 */
export async function inviteMembers(
  db: Db,
  octokit: Octokit,
  repo: Pick<RepoRow, "id" | "fullName" | "groupId">,
  members: { enrollmentId: string; githubLogin: string }[],
  actor: Actor,
): Promise<{ invited: string[]; failed: string[] }> {
  const invited: string[] = [];
  const failed: string[] = [];
  for (const m of members) {
    // The list was read before a provisioning that takes seconds: a member
    // removed meanwhile (nothing to revoke yet, the repository was still
    // pending) must not be invited from that stale list.
    if (repo.groupId && !(await isMember(db, repo.groupId, m.enrollmentId))) continue;
    try {
      await inviteMember(db, octokit, repo, m, actor);
      invited.push(m.githubLogin);
    } catch {
      failed.push(m.githubLogin);
    }
  }
  return { invited, failed };
}

async function isMember(db: Db, groupId: string, enrollmentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: assignmentGroupMembers.id })
    .from(assignmentGroupMembers)
    .where(
      and(
        eq(assignmentGroupMembers.groupId, groupId),
        eq(assignmentGroupMembers.enrollmentId, enrollmentId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Attaches one member to their group's existing repository: the teacher
 * adding them to the group, or their own acceptance once a fellow member has
 * created it. Null when there is nothing to do — no live repository yet, or
 * a member who cannot be invited (no linked GitHub account, or a lot-1
 * individual repository they keep). Throws when GitHub refuses; the caller
 * decides what that means for its request.
 */
export async function attachMember(
  db: Db,
  /** Only called when there is someone to invite: no GitHub token otherwise. */
  octokit: () => Promise<Octokit>,
  target: { assignmentId: string; groupId: string; enrollmentId: string },
  actor: Actor,
): Promise<{ repo: RepoRow; invitation: "pending" | "accepted" } | null> {
  const repo = await groupRepoRow(db, target.assignmentId, target.groupId);
  if (!repo || repo.provisionStatus !== "ok" || !repo.fullName || repo.deletedAt) return null;
  const member = (await invitableMembers(db, target.assignmentId, target.groupId)).find(
    (m) => m.enrollmentId === target.enrollmentId,
  );
  if (!member) return null;
  const invitation = await inviteMember(db, await octokit(), repo, member, actor);
  publish("repos", [`user:${member.userId}`]);
  return { repo, invitation };
}

/**
 * Live group repositories a roster entry is a member of — optionally only
 * the one of `groupId`. What a removal from the group, or from the roster,
 * has to revoke.
 */
export async function memberGroupRepos(
  db: Db,
  enrollmentId: string,
  groupId?: string,
): Promise<RepoRow[]> {
  const rows = await db
    .select({ repo: studentRepos })
    .from(assignmentGroupMembers)
    .innerJoin(studentRepos, eq(studentRepos.groupId, assignmentGroupMembers.groupId))
    .where(
      and(
        eq(assignmentGroupMembers.enrollmentId, enrollmentId),
        groupId ? eq(assignmentGroupMembers.groupId, groupId) : undefined,
        repoIsLive(),
      ),
    );
  return rows.map((r) => r.repo);
}

/** GitHub login behind a roster entry, or null when no account is linked. */
export async function enrollmentLogin(db: Db, enrollmentId: string): Promise<string | null> {
  const [row] = await db
    .select({ login: users.githubLogin })
    .from(enrollments)
    .innerJoin(users, eq(enrollments.userId, users.id))
    .where(eq(enrollments.id, enrollmentId))
    .limit(1);
  return row?.login ?? null;
}

/**
 * Takes a member's access away from each of `repos` (collaborator seat and
 * pending invitation), audited. Strict: the first failure throws, so the
 * caller leaves the membership in place instead of pretending the student
 * lost an access they still have. Returns the repositories revoked.
 */
export async function revokeMember(
  db: Db,
  octokit: Octokit,
  repos: Pick<RepoRow, "id" | "fullName">[],
  member: { enrollmentId: string; githubLogin: string | null },
  actor: Actor,
): Promise<string[]> {
  // No linked account: GitHub never heard of this student, nothing to take.
  if (!member.githubLogin) return [];
  const revoked: string[] = [];
  for (const repo of repos) {
    const [owner, name] = repo.fullName!.split("/") as [string, string];
    const { invitationsCancelled } = await revokeCollaborator(
      octokit,
      owner,
      name,
      member.githubLogin,
    );
    await audit(db, {
      actorUserId: actor.actorUserId,
      actorType: actor.actorUserId ? "user" : "system",
      action: "group.repo.revoke",
      subjectType: "student_repo",
      subjectId: repo.id,
      payload: {
        repo: repo.fullName,
        login: member.githubLogin,
        enrollmentId: member.enrollmentId,
        invitationsCancelled,
        reason: actor.reason,
      },
    });
    revoked.push(repo.fullName!);
  }
  return revoked;
}

/**
 * A student just linked their GitHub account: their groups may already have
 * a repository they could not be invited on (no login to invite). Invites
 * them on each one of a published assignment, best effort — the link itself
 * must never fail on it, and their own acceptance re-invites them anyway.
 * Returns the repositories they were invited on.
 */
export async function inviteOnGithubLink(
  app: { db: Db; log: { warn: (obj: object, msg: string) => void } },
  config: AppConfig,
  userId: string,
  githubLogin: string,
): Promise<string[]> {
  const rows = await app.db
    .select({
      repo: studentRepos,
      enrollmentId: enrollments.id,
      installationId: organizations.installationId,
    })
    .from(enrollments)
    .innerJoin(assignmentGroupMembers, eq(assignmentGroupMembers.enrollmentId, enrollments.id))
    .innerJoin(studentRepos, eq(studentRepos.groupId, assignmentGroupMembers.groupId))
    .innerJoin(assignments, eq(studentRepos.assignmentId, assignments.id))
    .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
    .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(assignments.state, "published"),
        isNotNull(organizations.installationId),
        repoIsLive(),
      ),
    );
  const invited: string[] = [];
  // A lot-1 individual repository keeps its student (see individualHolders).
  const holds = await individualHolders(
    app.db,
    rows.map((r) => r.repo.assignmentId),
  );
  for (const { repo, enrollmentId, installationId } of rows) {
    if (holds(repo.assignmentId, userId)) continue;
    try {
      const client = await installationClient(config, installationId!);
      await inviteMember(
        app.db,
        client.octokit,
        repo,
        { enrollmentId, githubLogin },
        { actorUserId: userId, reason: "github.link" },
      );
      invited.push(repo.fullName!);
    } catch (err) {
      app.log.warn({ err, repo: repo.fullName }, "group repository invitation on link failed");
    }
  }
  return invited;
}

// --- Acceptance -------------------------------------------------------------

export type GroupClaim =
  | { kind: "individual"; row: RepoRow }
  | { kind: "group"; group: GroupRow; row: RepoRow; repoName: string }
  | { kind: "refused"; error: "no_group"; message: string };

/**
 * First half of a group-mode acceptance, database only: which row the
 * acceptance provisions or attaches to, and under which repository name.
 *
 * - A live individual repository of the student (lot-1 leftover,
 *   `isLiveIndividualRepo`) answers `individual`: they keep it, exactly as
 *   before lot 2. A failed or pending lot-1 row does not: the student goes
 *   to their group's repository like everyone else.
 * - A student in no group is refused (`no_group`).
 * - Otherwise the group's row, inserted by the first member to get here
 *   (`user_id` = that member). The partial unique index on
 *   (assignment_id, group_id) is the idempotency key: two members accepting
 *   at the same second insert the same row, one insert wins, both read the
 *   winner back — and `claimProvisioning` then lets only one of them
 *   provision it.
 */
export async function claimGroupRepo(
  db: Db,
  opts: {
    assignment: { id: string; slug: string };
    orgLogin: string;
    enrollmentId: string;
    userId: string;
  },
): Promise<GroupClaim> {
  const { assignment, userId } = opts;
  const [own] = await db
    .select()
    .from(studentRepos)
    .where(
      and(
        eq(studentRepos.assignmentId, assignment.id),
        eq(studentRepos.userId, userId),
        isNull(studentRepos.groupId),
      ),
    )
    .limit(1);
  if (own && isLiveIndividualRepo(own)) return { kind: "individual", row: own };

  const group = await groupOfEnrollment(db, assignment.id, opts.enrollmentId);
  if (!group) {
    return {
      kind: "refused",
      error: "no_group",
      message: "You are not in any group for this assignment — ask your teacher to add you",
    };
  }

  let row = await groupRepoRow(db, assignment.id, group.id);
  if (!row) {
    await db
      .insert(studentRepos)
      .values({ id: randomUUID(), assignmentId: assignment.id, userId, groupId: group.id })
      .onConflictDoNothing();
    row = await groupRepoRow(db, assignment.id, group.id);
    if (!row) throw new Error(`group repository row of ${group.id} not found after insert`);
  }
  return { kind: "group", group, row, repoName: await repoNameFor(db, opts, group, row) };
}

/**
 * The GitHub name of a group repository: the one it has once provisioned,
 * else `groupRepoName`, disambiguated when another row the platform tracks
 * already bears or RESERVES it (`claimProvisioning` writes the name on the
 * row while it is still pending). Provisioning adopts an existing repository
 * of that name (a 422 is "step already done"), so a collision with another
 * classroom of the same organization would otherwise hand this group someone
 * else's work. Deterministic, so two members accepting together compute the
 * same name.
 */
async function repoNameFor(
  db: Db,
  opts: { assignment: { slug: string }; orgLogin: string },
  group: GroupRow,
  row: RepoRow,
): Promise<string> {
  if (row.provisionStatus === "ok" && row.fullName) return row.fullName.split("/")[1]!;
  const base = groupRepoName(opts.assignment.slug, group.slug);
  const [taken] = await db
    .select({ id: studentRepos.id })
    .from(studentRepos)
    .where(
      and(
        sql`lower(${studentRepos.fullName}) = lower(${`${opts.orgLogin}/${base}`})`,
        ne(studentRepos.id, row.id),
      ),
    )
    .limit(1);
  return taken ? groupRepoName(opts.assignment.slug, group.slug, group.id.slice(0, 8)) : base;
}

/** A claim older than this is taken over: the process that held it died. */
export const PROVISION_CLAIM_STALE_MS = 5 * 60_000;

/**
 * Takes the right to provision a row, atomically: true for exactly one of
 * several concurrent acceptances of the same row. Claimable: a row that
 * failed, or that is pending with no claim or a stale one. A provisioned row
 * is never claimed again. The claim also reserves the repository's full name
 * on the row, so `repoNameFor` in another classroom sees the name as taken
 * while this provisioning is still in flight.
 */
export async function claimProvisioning(db: Db, rowId: string, fullName: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - PROVISION_CLAIM_STALE_MS);
  const claimed = await db
    .update(studentRepos)
    .set({ provisionStatus: "pending", provisionClaimedAt: new Date(), fullName })
    .where(
      and(
        eq(studentRepos.id, rowId),
        or(
          eq(studentRepos.provisionStatus, "error"),
          and(
            eq(studentRepos.provisionStatus, "pending"),
            or(
              isNull(studentRepos.provisionClaimedAt),
              lt(studentRepos.provisionClaimedAt, staleBefore),
            ),
          ),
        ),
      ),
    )
    .returning({ id: studentRepos.id });
  return claimed.length > 0;
}

/**
 * Records a failed provisioning — unless the row got provisioned meanwhile:
 * a late failure (a stale claim taken over, a replay) must never turn a
 * repository that works back into an error, or deadline, freeze, review and
 * revocation would all skip it.
 */
export async function markProvisionFailed(db: Db, rowId: string, error: string): Promise<void> {
  await db
    .update(studentRepos)
    .set({ provisionStatus: "error", provisionError: error.slice(0, 500) })
    .where(and(eq(studentRepos.id, rowId), ne(studentRepos.provisionStatus, "ok")));
}

/**
 * For provisioning's adoption path: may this row adopt the existing GitHub
 * repository `githubRepoId`? Not when another row already records it — that
 * is another classroom's (or another group's) repository, and adopting it
 * would invite this student onto someone else's work before the unique
 * `github_repo_id` ever refused the row.
 */
export async function adoptableBy(db: Db, rowId: string, githubRepoId: number): Promise<boolean> {
  const [other] = await db
    .select({ id: studentRepos.id })
    .from(studentRepos)
    .where(and(eq(studentRepos.githubRepoId, githubRepoId), ne(studentRepos.id, rowId)))
    .limit(1);
  return other === undefined;
}
