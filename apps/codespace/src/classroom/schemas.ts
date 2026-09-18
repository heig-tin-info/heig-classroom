/**
 * Zod validation of the messages of `packages/contracts/src/codespace.ts`.
 *
 * The shared contract is written in TypeScript types, not in Zod schemas: it is
 * read by both applications and `packages/contracts` only has `zod` in
 * `peerDependencies`. The schemas therefore live here, on the *receiving* side,
 * and the assertion functions at the bottom of the file make compilation fail
 * if one drifts from the other. If a field is missing from the contract, it is
 * fixed in `packages/contracts`, never here.
 */
import type {
  CodespaceAssignmentSync,
  CodespaceRepoRef,
  LaunchTokenClaims,
  ServiceTokenClaims,
} from "@hgc/contracts";
import { z } from "zod";

/**
 * An assignment or student id also names a directory under `VOLUMES_ROOT`
 * (`git/staging.ts`, `SAFE_ID`). Refusing it here gives a readable 400 rather
 * than an exception at the first session start.
 */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeId(value: string): boolean {
  return SAFE_ID.test(value) && value !== "." && value !== "..";
}

/** ISO 8601 date readable by `Date.parse`; the contract says no more. */
const IsoDate = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), "ISO 8601 date expected");

const RepoRefSchema = z.object({
  /** `<owner>/<name>` on the forge. */
  fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repository expected in the form owner/name"),
  defaultBranch: z.string().min(1),
});

export const AssignmentSyncSchema = z.object({
  id: z.string().refine(isSafeId, "assignment id unsuitable for a path"),
  slug: z.string().min(1),
  name: z.string().min(1),
  classroomId: z.string().min(1),
  classroomName: z.string(),
  mode: z.enum(["online", "online_seb"]),
  image: z.string().min(1).nullable(),
  sourceRepo: RepoRefSchema,
  browserExamKeys: z.array(z.string().min(1)),
  teacher: z.object({ id: z.string().min(1), email: z.string().min(1) }),
  quota: z.object({ maxActiveSessions: z.number().int().min(0) }),
  startAt: IsoDate,
  deadlineAt: IsoDate.nullable(),
});

export type AssignmentSyncBody = z.infer<typeof AssignmentSyncSchema>;

export const LaunchClaimsSchema = z.object({
  iss: z.literal("heig-classroom"),
  aud: z.literal("heig-codespace"),
  iat: z.number(),
  exp: z.number(),
  jti: z.string().min(1),
  sub: z.string().refine(isSafeId, "subject unsuitable for a volume path"),
  email: z.string().min(1),
  displayName: z.string(),
  githubLogin: z.string().nullable(),
  assignmentId: z.string().min(1),
  repo: RepoRefSchema.nullable(),
});

export type LaunchClaims = z.infer<typeof LaunchClaimsSchema>;

// --- Agreement with the shared contract, checked at compile time -----------
// Each function fails to compile if the schema drifts from the type. They are
// never called; their only effect is on `tsc`.

/* eslint-disable @typescript-eslint/no-unused-vars */
const _syncMatchesContract = (v: AssignmentSyncBody): CodespaceAssignmentSync => v;
const _repoMatchesContract = (v: z.infer<typeof RepoRefSchema>): CodespaceRepoRef => v;
const _launchMatchesContract = (v: LaunchClaims): LaunchTokenClaims => v;
const _serviceAudience = (v: ServiceTokenClaims): { aud: string; iss: string } => v;
void _syncMatchesContract;
void _repoMatchesContract;
void _launchMatchesContract;
void _serviceAudience;
