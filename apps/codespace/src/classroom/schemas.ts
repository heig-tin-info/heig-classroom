/**
 * Validation Zod des messages de `packages/contracts/src/codespace.ts`.
 *
 * Le contrat partagé est écrit en types TypeScript, pas en schémas Zod : il
 * est lu par les deux applications et `packages/contracts` n'a `zod` qu'en
 * `peerDependencies`. Les schémas vivent donc ici, du côté qui *reçoit*, et
 * les fonctions d'assertion en bas de fichier font échouer la compilation si
 * l'un s'écarte de l'autre. Si un champ manque au contrat, il se corrige dans
 * `packages/contracts`, jamais ici.
 */
import type {
  CodespaceAssignmentSync,
  CodespaceRepoRef,
  LaunchTokenClaims,
  ServiceTokenClaims,
} from "@hgc/contracts";
import { z } from "zod";

/**
 * Un identifiant de devoir ou d'étudiant nomme aussi un répertoire sous
 * `VOLUMES_ROOT` (`git/staging.ts`, `SAFE_ID`). Le refuser ici donne un 400
 * lisible plutôt qu'une exception au premier démarrage de session.
 */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeId(value: string): boolean {
  return SAFE_ID.test(value) && value !== "." && value !== "..";
}

/** Date ISO 8601 relisible par `Date.parse` ; le contrat n'en dit pas plus. */
const IsoDate = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), "date ISO 8601 attendue");

const RepoRefSchema = z.object({
  /** `<owner>/<name>` sur la forge. */
  fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "dépôt attendu sous la forme owner/name"),
  defaultBranch: z.string().min(1),
});

export const AssignmentSyncSchema = z.object({
  id: z.string().refine(isSafeId, "identifiant de devoir impropre à un chemin"),
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
  sub: z.string().refine(isSafeId, "sujet impropre à un chemin de volume"),
  email: z.string().min(1),
  displayName: z.string(),
  githubLogin: z.string().nullable(),
  assignmentId: z.string().min(1),
  repo: RepoRefSchema.nullable(),
});

export type LaunchClaims = z.infer<typeof LaunchClaimsSchema>;

// --- Concordance avec le contrat partagé, vérifiée à la compilation --------
// Chaque fonction échoue à compiler si le schéma s'écarte du type. Elles ne
// sont jamais appelées ; leur seul effet est sur `tsc`.

/* eslint-disable @typescript-eslint/no-unused-vars */
const _syncMatchesContract = (v: AssignmentSyncBody): CodespaceAssignmentSync => v;
const _repoMatchesContract = (v: z.infer<typeof RepoRefSchema>): CodespaceRepoRef => v;
const _launchMatchesContract = (v: LaunchClaims): LaunchTokenClaims => v;
const _serviceAudience = (v: ServiceTokenClaims): { aud: string; iss: string } => v;
void _syncMatchesContract;
void _repoMatchesContract;
void _launchMatchesContract;
void _serviceAudience;
