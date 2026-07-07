/**
 * Revert des fichiers protégés (GH-30..35) : quand un push étudiant touche un
 * fichier protégé, le bot restaure la version du dépôt squashed par UN commit
 * (Git Data API), poussé en fast-forward non forcé — une course avec un push
 * étudiant échoue proprement et le webhook suivant redéclenche.
 */
import type { Octokit } from "octokit";

export interface RevertResult {
  sha: string;
  files: string[];
}

export async function revertProtectedFiles(opts: {
  octokit: Octokit;
  org: string;
  studentRepo: string;
  squashedRepo: string;
  branch: string;
  /** Fichiers protégés touchés par le push (intersection déjà calculée). */
  paths: string[];
}): Promise<RevertResult | null> {
  const { octokit, org, studentRepo, squashedRepo, branch, paths } = opts;
  if (paths.length === 0) return null;

  // Contenu de référence : la version distribuée (squashed), branche homonyme.
  const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  for (const path of paths) {
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: org,
        repo: squashedRepo,
        path,
        ref: branch,
        request: { retries: 0 },
      });
      if (Array.isArray(data) || data.type !== "file") continue;
      const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner: org,
        repo: studentRepo,
        content: data.content,
        encoding: "base64",
      });
      tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    } catch (err) {
      // Absent du squashed : le fichier protégé n'a pas de référence, on passe.
      if ((err as { status?: number }).status !== 404) throw err;
    }
  }
  if (tree.length === 0) return null;

  const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    owner: org,
    repo: studentRepo,
    ref: `heads/${branch}`,
  });
  const headSha = ref.object.sha;
  const { data: headCommit } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { owner: org, repo: studentRepo, commit_sha: headSha },
  );
  const { data: newTree } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
    owner: org,
    repo: studentRepo,
    base_tree: headCommit.tree.sha,
    tree,
  });
  const { data: commit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner: org,
    repo: studentRepo,
    message: `Restore protected files\n\n${paths.join("\n")}`,
    tree: newTree.sha,
    parents: [headSha],
  });
  // Fast-forward strict : force=false — en cas de course, GitHub refuse et le
  // prochain webhook rattrapera.
  await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner: org,
    repo: studentRepo,
    ref: `heads/${branch}`,
    sha: commit.sha,
    force: false,
  });
  return { sha: commit.sha, files: tree.map((t) => t.path) };
}
