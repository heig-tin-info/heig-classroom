/**
 * How the platform names the repositories it creates in an organization.
 *
 * One organization holds every classroom of a course, often over several
 * years, so a name that only says what a repository IS collides: two
 * classrooms with the same assignment slug both want `labo-01-group-1`, and
 * two classrooms both want `journal`. Every name is therefore
 * `<what discriminates>-<what it is>`, capped at GitHub's limit, with a
 * DETERMINISTIC disambiguator appended when the name is already taken — a
 * random suffix would leave a second orphan repository behind every retry of
 * a creation that failed halfway.
 */

/** GitHub refuses a repository name longer than 100 characters. */
export const GITHUB_REPO_NAME_MAX = 100;

/**
 * `stem` with `disambiguator` appended, capped. The tail survives the cap and
 * the stem is truncated from the right: the disambiguator is the part that
 * makes the name unique, so cutting it would defeat its purpose. A trailing
 * dash left by the cut is dropped — `labo-01-group` is free and prettier than
 * `labo-01-group-`.
 */
export function repoName(stem: string, disambiguator?: string): string {
  const tail = disambiguator ? `-${disambiguator}` : "";
  const head = stem.slice(0, GITHUB_REPO_NAME_MAX - tail.length).replace(/-+$/, "");
  return `${head}${tail}`;
}

/**
 * The journal repository of a classroom (issue #45):
 * `<classroom-slug>-journal`. The discriminating part comes first, like every
 * other repository the platform creates (`<assignment-slug>-<login>`,
 * `<assignment-slug>-<group-slug>`, `<slug>-squashed`), so the repositories of
 * one classroom sort together in the organization listing.
 *
 * The name records where the journal was CREATED, not who reads it: a journal
 * attached to a second classroom keeps the first one's name. That is why the
 * creation form offers this as a *proposal* the teacher may rewrite — someone
 * who knows the journal will outlive one cohort calls it `prog-c-journal`.
 */
export function journalRepoName(classroomSlug: string, disambiguator?: string): string {
  return repoName(`${classroomSlug}-journal`, disambiguator);
}
