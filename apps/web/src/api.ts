/** Portal API client: session cookies + double-submit CSRF header. */

function csrfToken(): string {
  return (
    document.cookie
      .split("; ")
      .find((c) => c.startsWith("hgc_csrf="))
      ?.slice("hgc_csrf=".length) ?? ""
  );
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API ${status}`);
  }
}

export async function api<T>(
  path: string,
  init: RequestInit & { csv?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET") {
    headers.set("x-csrf-token", csrfToken());
  }
  if (init.body instanceof Blob) {
    headers.set("content-type", init.body.type || "application/octet-stream");
  } else if (init.body && !init.csv) {
    headers.set("content-type", "application/json");
  }
  if (init.csv) {
    headers.set("content-type", "text/csv");
    init.body = init.csv;
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!res.ok) {
    throw new ApiError(res.status, await res.json().catch(() => null));
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface Me {
  id: string;
  email: string;
  givenName: string;
  familyName: string;
  role: "teacher" | "student" | "admin";
  githubLogin: string | null;
  lastLoginAt: string | null;
  avatarUrl: string | null;
  hasUploadedAvatar: boolean;
  locale: "en" | "fr" | null;
}

export interface ClassroomSummary {
  id: string;
  name: string;
  orgLogin: string;
  createdAt: string;
  students: number;
  claimed: number;
  assignments: {
    id: string;
    name: string;
    state: "draft" | "published" | "locked";
    startAt: string;
    deadlineAt: string;
  }[];
  roster: { nom: string; prenom: string; claimed: boolean; staff: boolean }[];
}

export interface RosterEntry {
  id: string;
  nom: string;
  prenom: string;
  email: string;
  status: "pending" | "claimed";
  conflictFlag: boolean;
  staff: boolean;
  githubLogin: string | null;
  lastLoginAt: string | null;
  avatarUrl: string | null;
  hasUploadedAvatar: boolean;
}

export interface ClassroomDetail {
  id: string;
  name: string;
  org: { login: string; installationId: number | null } | null;
  roster: RosterEntry[];
  appSlug: string | null;
}
