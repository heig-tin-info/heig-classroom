/**
 * Group assignments (issue #2, lot 2, ADR-014): the two pure rules the server
 * applies around group repositories.
 *
 * - `groupRepoName`: what the group repository is called on GitHub.
 * - `pickStudentRepo`: which repository a student's line reads, when an
 *   assignment can hold both a group repository and — from lot 1, before
 *   acceptance knew about groups — an individual one.
 */

/** GitHub refuses a repository name longer than 100 characters. */
export const GITHUB_REPO_NAME_MAX = 100;

/**
 * `<assignment-slug>-<group-slug>`, capped at GitHub's limit (both slugs are
 * already `[a-z0-9-]`, up to 60 characters each). `disambiguator` is appended
 * when that name is already taken by another repository of the organization
 * (two classrooms of the same organization with the same assignment slug both
 * have a `group-1`); it survives the cap, the prefix is what gets shortened.
 */
export function groupRepoName(
  assignmentSlug: string,
  groupSlug: string,
  disambiguator?: string,
): string {
  const tail = disambiguator ? `-${disambiguator}` : "";
  const head = `${assignmentSlug}-${groupSlug}`
    .slice(0, GITHUB_REPO_NAME_MAX - tail.length)
    .replace(/-+$/, "");
  return `${head}${tail}`;
}

/**
 * The repository a student's line reads on an assignment. `own` is the
 * student's individual repository (no group), `group` the repository of their
 * group. A live individual repository wins: in a group assignment it can only
 * be a lot-1 leftover, created before acceptance knew about groups, and the
 * student keeps working in it as before. Once it is gone (deleted on GitHub),
 * the group repository takes over; with neither, the dead individual one is
 * still shown so its deletion stays visible.
 */
export function pickStudentRepo<R extends { deletedAt: Date | string | null }>(
  own: R | undefined,
  group: R | undefined,
): R | undefined {
  if (own && own.deletedAt === null) return own;
  return group ?? own;
}
