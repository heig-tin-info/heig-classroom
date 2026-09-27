/**
 * The GitHub side of a journal (issue #45): create the repository, read its
 * tree, read a blob, write a file.
 *
 * Everything goes through the REST API and NOTHING is cloned. Assignment
 * provisioning shells out to git into a temporary directory, which is right
 * for pushing a whole history; a journal only ever needs single files and one
 * tree listing, and the production VM (1 vCPU / 2 GB, shared with Postgres)
 * has no business holding a working copy per course to render a page.
 */
import type { Octokit } from "octokit";

/** One entry of the repository tree, as the ingestion needs it. */
export interface TreeEntry {
  path: string;
  sha: string;
  /** Byte size of a blob; absent for a directory. */
  size: number;
}

export interface RepoTree {
  /** Head commit of the ref the tree was read at. */
  commitSha: string;
  entries: TreeEntry[];
}

/** GitHub's own limits on the endpoints below. */
export const CONTENTS_API_MAX_BYTES = 1_000_000;

export class JournalRepoError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "empty"
      | "conflict"
      | "too_large"
      | "truncated"
      | "name_taken",
  ) {
    super(message);
    this.name = "JournalRepoError";
  }
}

const status = (err: unknown): number | undefined => (err as { status?: number }).status;

/**
 * Creates the private repository and its first commit (the README that
 * explains the layout), then returns what the mirror needs to track it.
 *
 * A name already taken is a `name_taken` error and NEVER an adoption. The
 * assignment provisioner treats a 422 as "step already done" and adopts the
 * existing repository, which is right for a repository it alone writes to;
 * here it would hand a classroom whatever material happened to sit under that
 * name — another teacher's course, rendered to the wrong cohort. Attaching an
 * existing repository is a separate, deliberate action.
 */
export async function createJournalRepo(
  octokit: Octokit,
  opts: { org: string; name: string; description: string; readme: string },
): Promise<{ repoId: number; fullName: string; defaultBranch: string }> {
  let repoId: number;
  let fullName: string;
  let defaultBranch: string;
  try {
    const { data } = await octokit.request("POST /orgs/{org}/repos", {
      org: opts.org,
      name: opts.name,
      description: opts.description,
      private: true,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
      request: { retries: 0 },
    });
    repoId = data.id;
    fullName = data.full_name;
    defaultBranch = data.default_branch || "main";
  } catch (err) {
    if (status(err) === 422) {
      throw new JournalRepoError(
        `A repository named ${opts.org}/${opts.name} already exists`,
        "name_taken",
      );
    }
    throw err;
  }
  // The repository is empty until something is committed: no default branch
  // exists on GitHub's side yet, and this first write creates it.
  await putFile(octokit, {
    org: opts.org,
    repo: opts.name,
    branch: defaultBranch,
    path: "README.md",
    message: "Start the journal",
    content: Buffer.from(opts.readme, "utf8"),
  });
  return { repoId, fullName, defaultBranch };
}

/** The repository behind a `owner/name`, or a `not_found` error. */
export async function resolveRepo(
  octokit: Octokit,
  fullName: string,
): Promise<{ repoId: number; fullName: string; defaultBranch: string; isPrivate: boolean }> {
  const [owner, repo] = fullName.split("/") as [string, string];
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
    return {
      repoId: data.id,
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      isPrivate: data.private,
    };
  } catch (err) {
    if (status(err) === 404) {
      throw new JournalRepoError(`${fullName} is not reachable with this installation`, "not_found");
    }
    throw err;
  }
}

/**
 * The whole tree of a ref, flattened. `truncated` is surfaced rather than
 * swallowed: a silently half-read tree would delete every page it did not see
 * from the mirror.
 */
export async function readTree(
  octokit: Octokit,
  opts: { org: string; repo: string; ref: string },
): Promise<RepoTree> {
  const { org, repo, ref } = opts;
  let commitSha: string;
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner: org,
      repo,
      ref,
      request: { retries: 0 },
    });
    commitSha = data.sha;
  } catch (err) {
    // 409 is GitHub's answer for "this repository is empty"; 404 for a branch
    // that does not exist. Both mean "no pages yet", not "broken".
    if (status(err) === 409 || status(err) === 404) {
      throw new JournalRepoError(`${org}/${repo} has no commit on ${ref}`, "empty");
    }
    throw err;
  }
  const { data: tree } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    { owner: org, repo, tree_sha: commitSha, recursive: "1" },
  );
  if (tree.truncated) {
    throw new JournalRepoError(
      `The tree of ${org}/${repo} is too large to read in one request`,
      "truncated",
    );
  }
  const entries: TreeEntry[] = [];
  for (const e of tree.tree) {
    if (e.type !== "blob" || !e.path || !e.sha) continue;
    entries.push({ path: e.path, sha: e.sha, size: e.size ?? 0 });
  }
  return { commitSha, entries };
}

/**
 * One blob, by sha. The base64 form of the Git blob endpoint rather than the
 * Contents API: it is not capped at 1 MB, and it takes the sha the tree
 * listing already gave us, so a file whose content did not move costs nothing.
 */
export async function readBlob(
  octokit: Octokit,
  opts: { org: string; repo: string; sha: string },
): Promise<Buffer> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
    owner: opts.org,
    repo: opts.repo,
    file_sha: opts.sha,
  });
  return Buffer.from(data.content, data.encoding as BufferEncoding);
}

/** Who a browser edit is committed as: the teacher, not the bot. */
export interface CommitAuthor {
  name: string;
  email: string;
}

/**
 * Writes one file and returns the new blob sha.
 *
 * `baseSha` is the optimistic lock: the blob sha the editor opened the page at.
 * GitHub answers 409 when the file moved since, and that is the whole conflict
 * detection — the platform never has to compare contents, and a teacher who
 * pushed from their clone cannot be overwritten by a browser tab that had been
 * open since this morning.
 */
export async function putFile(
  octokit: Octokit,
  opts: {
    org: string;
    repo: string;
    branch: string;
    path: string;
    message: string;
    content: Buffer;
    /** Blob sha being replaced; absent to create the file. */
    baseSha?: string | undefined;
    author?: CommitAuthor | undefined;
  },
): Promise<{ blobSha: string; commitSha: string }> {
  if (opts.content.length > CONTENTS_API_MAX_BYTES) {
    throw new JournalRepoError(
      `${opts.path} is larger than the 1 MB the contents API accepts`,
      "too_large",
    );
  }
  try {
    const { data } = await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
      owner: opts.org,
      repo: opts.repo,
      path: opts.path,
      branch: opts.branch,
      message: opts.message,
      content: opts.content.toString("base64"),
      ...(opts.baseSha ? { sha: opts.baseSha } : {}),
      ...(opts.author ? { author: opts.author, committer: opts.author } : {}),
      request: { retries: 0 },
    });
    return { blobSha: data.content?.sha ?? "", commitSha: data.commit.sha ?? "" };
  } catch (err) {
    if (status(err) === 409 || status(err) === 422) {
      throw new JournalRepoError(`${opts.path} changed on GitHub since it was opened`, "conflict");
    }
    throw err;
  }
}

/** Removes one file. Same optimistic lock as `putFile`. */
export async function deleteFile(
  octokit: Octokit,
  opts: {
    org: string;
    repo: string;
    branch: string;
    path: string;
    message: string;
    baseSha: string;
    author?: CommitAuthor | undefined;
  },
): Promise<{ commitSha: string }> {
  try {
    const { data } = await octokit.request("DELETE /repos/{owner}/{repo}/contents/{path}", {
      owner: opts.org,
      repo: opts.repo,
      path: opts.path,
      branch: opts.branch,
      message: opts.message,
      sha: opts.baseSha,
      ...(opts.author ? { author: opts.author, committer: opts.author } : {}),
      request: { retries: 0 },
    });
    return { commitSha: data.commit.sha ?? "" };
  } catch (err) {
    if (status(err) === 409 || status(err) === 422) {
      throw new JournalRepoError(`${opts.path} changed on GitHub since it was opened`, "conflict");
    }
    throw err;
  }
}

/** One move inside the repository: same blob, new path. */
export interface Move {
  from: string;
  to: string;
  sha: string;
}

/**
 * Applies several moves as ONE commit, through the Git trees API.
 *
 * This is what reordering costs when the order lives in the file names: moving
 * a page between two neighbours is a rename, and renumbering a run of pages is
 * a handful of them. One commit rather than one per file, so the history reads
 * as "reorder the section" and a reader of the repository is never shown a
 * state where two pages share a number.
 */
export async function commitMoves(
  octokit: Octokit,
  opts: {
    org: string;
    repo: string;
    branch: string;
    message: string;
    moves: readonly Move[];
    expectedHead: string;
    author?: CommitAuthor | undefined;
  },
): Promise<{ commitSha: string }> {
  const { org, repo, branch, moves, expectedHead } = opts;
  const { data: head } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    owner: org,
    repo,
    ref: `heads/${branch}`,
  });
  if (head.object.sha !== expectedHead) {
    throw new JournalRepoError("The journal moved on GitHub since it was opened", "conflict");
  }
  const { data: commit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    owner: org,
    repo,
    commit_sha: expectedHead,
  });
  // A move is the same blob under a new path plus a deletion of the old one;
  // `sha: null` on a path is how the trees API spells "remove it".
  const tree = [
    ...moves.map((m) => ({ path: m.to, mode: "100644" as const, type: "blob" as const, sha: m.sha })),
    ...moves.map((m) => ({ path: m.from, mode: "100644" as const, type: "blob" as const, sha: null })),
  ];
  const { data: newTree } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
    owner: org,
    repo,
    base_tree: commit.tree.sha,
    tree: tree as never,
  });
  const { data: newCommit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner: org,
    repo,
    message: opts.message,
    tree: newTree.sha,
    parents: [expectedHead],
    ...(opts.author ? { author: opts.author, committer: opts.author } : {}),
  });
  try {
    await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner: org,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
      force: false,
      request: { retries: 0 },
    });
  } catch (err) {
    if (status(err) === 422) {
      throw new JournalRepoError("The journal moved on GitHub since it was opened", "conflict");
    }
    throw err;
  }
  return { commitSha: newCommit.sha };
}
