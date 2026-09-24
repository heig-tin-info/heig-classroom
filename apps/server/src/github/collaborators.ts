/**
 * Outside collaborators of a student repository: the one invitation call the
 * provisioning makes, and its reverse for group repositories (issue #2, lot
 * 2), where a member who leaves the group must lose their access for real.
 * Both are idempotent, so a retried request never fails on its own trace.
 */
import type { Octokit } from "octokit";

export type CollaboratorPermission = "push" | "pull";

/**
 * Invites `login` on `owner/repo`. `pending` when GitHub created an
 * invitation (201), `accepted` when the user already is a collaborator (204).
 */
export async function inviteCollaborator(
  octokit: Octokit,
  owner: string,
  repo: string,
  login: string,
  permission: CollaboratorPermission = "push",
): Promise<"pending" | "accepted"> {
  const res = await octokit.request("PUT /repos/{owner}/{repo}/collaborators/{username}", {
    owner,
    repo,
    username: login,
    permission,
  });
  return res.status === 201 ? "pending" : "accepted";
}

/**
 * Takes every access of `login` away from `owner/repo`: the collaborator seat
 * if the invitation was accepted, the invitation itself if it is still
 * pending (removing a collaborator does not cancel an invitation). A user who
 * had neither is a no-op, not an error — the revocation may be a replay.
 */
export async function revokeCollaborator(
  octokit: Octokit,
  owner: string,
  repo: string,
  login: string,
): Promise<{ invitationsCancelled: number }> {
  try {
    await octokit.request("DELETE /repos/{owner}/{repo}/collaborators/{username}", {
      owner,
      repo,
      username: login,
      request: { retries: 0 },
    });
  } catch (err) {
    // 404: no such collaborator (or a renamed account) — nothing to remove.
    if ((err as { status?: number }).status !== 404) throw err;
  }
  const { data: invitations } = await octokit.request(
    "GET /repos/{owner}/{repo}/invitations",
    { owner, repo, per_page: 100 },
  );
  const mine = invitations.filter(
    (i: { invitee?: { login?: string } | null }) =>
      i.invitee?.login?.toLowerCase() === login.toLowerCase(),
  );
  for (const invitation of mine) {
    await octokit.request("DELETE /repos/{owner}/{repo}/invitations/{invitation_id}", {
      owner,
      repo,
      invitation_id: invitation.id,
    });
  }
  return { invitationsCancelled: mine.length };
}
