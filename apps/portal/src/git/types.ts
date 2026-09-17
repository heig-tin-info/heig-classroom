/**
 * Shared shapes of the Git channel (P3). Nothing here knows about Podman,
 * OIDC or the session store: the backend receives a `SessionLookup` and a
 * `PushEventStore`, and the modules that own those tables implement them.
 */

/** A repository on the forge, `<owner>/<name>`. */
export interface RepoRef {
  owner: string;
  name: string;
}

/**
 * Everything the Git surface needs to know about a live session. Produced by
 * `sessions/` in V1; a plain `Map` in the tests.
 *
 * `containerIp` is the whole authentication story (analyse.md 3.1): on the
 * `codespace` bridge, with inter-container traffic blocked by nftables (P2),
 * the source address identifies the session, so no token ever enters the
 * student container (invariant 1).
 */
export interface StagingSession {
  sessionId: string;
  student: string;
  assignment: string;
  /** Address the portal handed to this container on the `codespace` bridge. */
  containerIp: string;
  /**
   * `http.uploadpack` for this assignment. True by default (analyse.md 3.2:
   * refusing fetch protects nothing; what changes between modes is what the
   * portal *puts* in the staging repository).
   */
  uploadPack: boolean;
  /** Where successful pushes are relayed. Absent = keep locally only. */
  targetRepo?: RepoRef;
}

export interface SessionLookup {
  /** Undefined for an unknown or closed session; the caller answers 404. */
  bySessionId(sessionId: string): Promise<StagingSession | undefined>;
}

/** The two Git services `git http-backend` speaks. */
export type GitService = "git-upload-pack" | "git-receive-pack";

/** A ref that changed during one `receive-pack`. */
export interface RefChange {
  ref: string;
  /** Null when the ref was created. */
  oldSha: string | null;
  sha: string;
}
