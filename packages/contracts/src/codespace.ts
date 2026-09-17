// --- Codespace (environnement en ligne) : contrat entre classroom et le portail ---
//
// classroom est la source de vérité des devoirs, des étudiants et des dépôts ;
// le portail (apps/codespace) est la source de vérité des sessions. Les deux
// se parlent uniquement par ces messages, signés HS256 avec un secret partagé
// (`CODESPACE_LAUNCH_SECRET` des deux côtés). Ni l'un ni l'autre n'importe le
// code de l'autre (règle d'import du CLAUDE.md racine).

/**
 * Mode de travail d'un devoir.
 * - `free` : flux historique, l'étudiant clone et pousse avec son compte GitHub.
 * - `online` : le travail se fait dans le portail ; l'étudiant n'a qu'un droit
 *   de lecture sur son dépôt, le portail pousse pour lui.
 * - `online_seb` : comme `online`, et la session n'est ouverte que depuis Safe
 *   Exam Browser (vérification côté portail) ; l'étudiant n'a aucun accès au
 *   dépôt avant la notation.
 */
export type WorkMode = "free" | "online" | "online_seb";
export const WORK_MODES: readonly WorkMode[] = ["free", "online", "online_seb"];

/** Réglages "environnement en ligne" d'un enseignant, posés par l'administrateur. */
export interface TeacherCodespaceGrant {
  /** L'enseignant voit et peut choisir les modes `online*` dans ses devoirs. */
  enabled: boolean;
  /** Sessions actives simultanées autorisées pour l'ensemble de ses devoirs. */
  maxActiveSessions: number;
}

/** Repo cible d'un étudiant, tel que classroom l'a provisionné. */
export interface CodespaceRepoRef {
  fullName: string;
  defaultBranch: string;
}

/**
 * Devoir tel que le portail doit le connaître. classroom l'envoie (PUT) à
 * chaque enregistrement d'un devoir en mode `online*`, avant qu'un étudiant
 * puisse le lancer ; le portail le crée ou le met à jour (idempotent).
 */
export interface CodespaceAssignmentSync {
  /** Identifiant du devoir dans classroom ; clé du devoir dans le portail. */
  id: string;
  slug: string;
  name: string;
  classroomId: string;
  classroomName: string;
  mode: Exclude<WorkMode, "free">;
  /** Image du catalogue du portail ; null = image par défaut. */
  image: string | null;
  /** Dépôt modèle (squashé) : ce dont l'espace de travail est amorcé en mode examen. */
  sourceRepo: CodespaceRepoRef;
  /** Browser Exam Keys acceptés (mode `online_seb`), un par couple plateforme/version. */
  browserExamKeys: string[];
  /** Enseignant propriétaire : porteur du quota. */
  teacher: { id: string; email: string };
  quota: { maxActiveSessions: number };
  startAt: string;
  deadlineAt: string | null;
}

/**
 * Jeton de lancement : classroom l'émet quand un étudiant clique Démarrer, le
 * portail le vérifie sur `GET /launch?token=...`. Durée de vie courte (5 min),
 * usage unique (`jti`).
 */
export interface LaunchTokenClaims {
  iss: "heig-classroom";
  aud: "heig-codespace";
  iat: number;
  exp: number;
  jti: string;
  /** Identifiant de l'utilisateur dans classroom (stable). */
  sub: string;
  email: string;
  displayName: string;
  githubLogin: string | null;
  assignmentId: string;
  /** Dépôt cible de l'étudiant ; null s'il n'est pas encore provisionné. */
  repo: CodespaceRepoRef | null;
}

/** Jeton de service pour les appels serveur → serveur (PUT devoir, etc.). */
export interface ServiceTokenClaims {
  iss: "heig-classroom" | "heig-codespace";
  aud: "heig-codespace-api" | "heig-classroom-api";
  iat: number;
  exp: number;
}

/** Réponse du portail à `GET /api/assignments/:id/sessions` (tableau enseignant). */
export interface CodespaceSessionSummary {
  sessionId: string;
  userId: string;
  email: string;
  state: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastPushAt: string | null;
}
