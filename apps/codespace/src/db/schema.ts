/**
 * Drizzle schema (SQLite, better-sqlite3).
 *
 * Les quatre entités du cadrage, et rien d'autre : `users`, `assignments`,
 * `sessions`, `push_events`. La session de *connexion* au portail n'est pas
 * une cinquième table : c'est un jeton signé sans état (`auth/session.ts`),
 * justifié dans docs/v1.md § 3.
 *
 * Timestamps are stored as epoch milliseconds (`timestamp_ms`), UTC, like
 * heig-classroom stores `timestamptz`. SQLite has no timestamp type and a
 * text date would sort badly across time zones.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * One row per ref changed by a successful `receive-pack` on a staging
 * repository. This is the timestamped proof of submission (invariant 7: the
 * row is written *before* any relay to the forge is attempted), and the work
 * queue for the relay job at the same time.
 *
 * `state` stays `pending` for as long as the relay is worth retrying — a
 * forge outage must never turn into a lost submission — and only moves to
 * `failed` once the attempt budget is exhausted.
 */
export const pushEvents = sqliteTable(
  "push_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    student: text("student").notNull(),
    assignment: text("assignment").notNull(),
    /** Full ref name, e.g. `refs/heads/main`. */
    ref: text("ref").notNull(),
    /** Ref value after the push. */
    sha: text("sha").notNull(),
    /** Ref value before the push; null when the ref was created. */
    oldSha: text("old_sha"),
    /** Null when the ref was deleted. */
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    state: text("state", { enum: ["pending", "relayed", "failed"] })
      .notNull()
      .default("pending"),
    /** Relay attempts already made; drives the backoff. */
    attempts: integer("attempts").notNull().default(0),
    /** Epoch ms before which the relay job must not pick this row up. */
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
    relayedAt: integer("relayed_at", { mode: "timestamp_ms" }),
    /** Last relay error, tokens redacted (see git/relay.ts). */
    lastError: text("last_error"),
  },
  (t) => [
    index("push_events_state_idx").on(t.state, t.nextAttemptAt),
    index("push_events_session_idx").on(t.sessionId, t.receivedAt),
  ],
);

export type PushEventRow = typeof pushEvents.$inferSelect;
export type NewPushEventRow = typeof pushEvents.$inferInsert;

/**
 * Les trois autres entités du cadrage (jalon-0 V1) : l'utilisateur, le
 * devoir, la session. Avec `push_events` ci-dessus, cela fait les quatre
 * tables annoncées et rien d'autre : la session de connexion au portail est
 * un cookie signé sans état côté serveur (auth/session.ts), pas une
 * cinquième table.
 */

/**
 * Utilisateur du portail, créé à la première connexion OIDC (invariant 4 :
 * aucune autre source d'identité). `login` est l'identifiant institutionnel
 * (`preferred_username`) : c'est lui qui nomme le répertoire de volume, donc
 * il doit satisfaire le `SAFE_ID` de `git/staging.ts`.
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    /** Sujet OIDC : la clé d'identité, stable même si l'adresse change. */
    oidcSub: text("oidc_sub").notNull(),
    login: text("login").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull().default(""),
    /**
     * Login GitHub, quand il est connu. Il vient des revendications du jeton
     * de lancement pour un compte venu de classroom (classroom est la source
     * de vérité du lien GitHub) ; il reste null pour un compte OIDC autonome.
     */
    githubLogin: text("github_login"),
    /** Déduit du rôle de realm Keycloak à chaque connexion, jamais stocké à la main. */
    role: text("role", { enum: ["student", "teacher"] })
      .notNull()
      .default("student"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("users_oidc_sub_idx").on(t.oidcSub),
    uniqueIndex("users_login_idx").on(t.login),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

/**
 * Devoir. En v0 il vient de `seed/assignments.yaml` (analyse.md § 5 :
 * « un devoir est un fichier YAML jusqu'au pilote ») ; l'interface enseignant
 * de création est hors périmètre.
 *
 * `templateRepo` / `targetRepo` portent l'invariant 6 : en mode examen le
 * dépôt de transit est amorcé depuis le **modèle**, et le dépôt cible n'est
 * qu'une destination de relais.
 */
export const assignments = sqliteTable("assignments", {
  /** Identifiant court, nomme aussi le sous-répertoire du volume. */
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  mode: text("mode", { enum: ["lab", "exam"] })
    .notNull()
    .default("lab"),
  /** Image étudiante à lancer, p. ex. `codespace/c-dev:4.137.0`. */
  image: text("image").notNull(),
  /** `http.uploadpack` du dépôt de transit ; vrai par défaut (analyse.md 3.2). */
  uploadPack: integer("upload_pack", { mode: "boolean" }).notNull().default(true),
  /** Dépôt modèle de l'enseignant : URL ou chemin d'un dépôt local. */
  templateRepo: text("template_repo"),
  /** Dépôt cible fixe `<owner>/<name>`. Exclusif de `targetRepoPattern`. */
  targetRepo: text("target_repo"),
  /**
   * Convention, p. ex. `codespace/{student}-tp-pointeurs`. `{student}` est
   * substitué. **Repli** : un devoir synchronisé depuis classroom reçoit le
   * dépôt de l'étudiant par le jeton de lancement, et c'est
   * `sessions.targetRepo` qui fait foi. Ces deux colonnes restent pour la
   * graine YAML autonome (`seed/assignments.yaml`).
   */
  targetRepoPattern: text("target_repo_pattern"),

  // --- Devoir synchronisé depuis heig-classroom ---------------------------
  // Toutes nulles pour un devoir de la graine YAML autonome.
  /** Enseignant propriétaire : porteur du quota (`sessions.teacherId`). */
  teacherId: text("teacher_id"),
  teacherEmail: text("teacher_email"),
  /** Sessions vivantes simultanées autorisées à cet enseignant, tous devoirs confondus. */
  maxActiveSessions: integer("max_active_sessions"),
  classroomId: text("classroom_id"),
  classroomName: text("classroom_name"),
  /**
   * Dépôt modèle de l'enseignant, tel que classroom le nomme. Invariant 6 :
   * c'est de là, et de nulle part ailleurs, qu'un dépôt de transit d'examen
   * est amorcé. `templateRepo` en porte l'URL de clonage.
   */
  sourceRepo: text("source_repo", { mode: "json" }).$type<AssignmentRepoRef>(),
  /** Fenêtre d'ouverture. Null = pas de borne de ce côté. */
  opensAt: integer("opens_at", { mode: "timestamp_ms" }),
  closesAt: integer("closes_at", { mode: "timestamp_ms" }),
  /** Config Key du `.seb` servi (seb/sebFile.ts). Null hors mode examen. */
  configKey: text("config_key"),
  /** Un BEK par couple (plateforme, version) : liste, pas scalaire (analyse.md 4.4). */
  beks: text("beks", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default([]),
  /** Réglages du `.seb` : `examKeySalt`, `quitUrl`, `extraAllowedHosts`. */
  sebConfig: text("seb_config", { mode: "json" }).$type<AssignmentSebConfig>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export interface AssignmentSebConfig {
  /** Sel du Browser Exam Key, stable pour un devoir (seb/sebFile.ts). */
  examKeySalt: string;
  /**
   * `startURL` inscrite dans le `.seb`, donc dans le calcul de la Config Key.
   * Absente pour un devoir autonome (le portail prend alors sa propre route
   * `/exam/<id>/start`) ; présente pour un devoir synchronisé, où c'est
   * classroom qui authentifie l'étudiant avant de rediriger vers `/launch`.
   */
  startUrl?: string;
  quitUrl?: string;
  extraAllowedHosts?: string[];
}

/** Dépôt sur la forge, tel que classroom le nomme (`CodespaceRepoRef`). */
export interface AssignmentRepoRef {
  fullName: string;
  defaultBranch: string;
}

export type AssignmentRow = typeof assignments.$inferSelect;
export type NewAssignmentRow = typeof assignments.$inferInsert;

/**
 * Session : un couple (étudiant, devoir) et le conteneur qui le sert.
 * Une seule vivante par couple (analyse.md D5) ; la contrainte est tenue par
 * `sessions/store.ts`, pas par un index partiel, parce que « vivante » est un
 * ensemble d'états et que SQLite n'indexe pas cela sans duplication.
 *
 * `student` duplique `users.login` à dessein : le chemin du volume en dérive
 * et ne doit pas bouger si la fiche utilisateur change.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    student: text("student").notNull(),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => assignments.id),
    /** Identifiant Podman ; null entre la création de la ligne et le `run`. */
    containerId: text("container_id"),
    containerName: text("container_name"),
    /** Adresse sur le pont `codespace` : c'est toute l'authentification du canal Git. */
    containerIp: text("container_ip"),
    /** `<VOLUMES_ROOT>/<student>/<assignment>`, conservé après destruction du conteneur. */
    volumeDir: text("volume_dir").notNull(),
    state: text("state", { enum: ["starting", "running", "stopped", "closed", "failed"] })
      .notNull()
      .default("starting"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** Battement, mis à jour par le proxy à chaque requête. */
    lastSeen: integer("last_seen", { mode: "timestamp_ms" }).notNull(),
    /** Jeton du cookie `cs_session`, porté par le navigateur de l'étudiant. */
    cookieToken: text("cookie_token").notNull(),
    /** Vrai si la session est née d'une vérification SEB (invariant 5). */
    sebVerified: integer("seb_verified", { mode: "boolean" }).notNull().default(false),
    /**
     * Enseignant porteur du quota, recopié du devoir à la création. Recopié
     * plutôt que joint : le quota se compte d'une requête, et un devoir
     * réaffecté ne déplace pas les sessions déjà ouvertes.
     */
    teacherId: text("teacher_id"),
    /** `jti` du jeton de lancement qui a ouvert ou repris cette session. */
    launchJti: text("launch_jti"),
    /**
     * Dépôt de l'étudiant, apporté par le jeton de lancement. C'est la cible
     * du relais et, en mode travaux pratiques, la source du miroir. Null pour
     * une session née de la graine YAML : le devoir porte alors la convention.
     */
    targetRepo: text("target_repo", { mode: "json" }).$type<AssignmentRepoRef>(),
  },
  (t) => [
    index("sessions_pair_idx").on(t.student, t.assignmentId, t.state),
    index("sessions_state_idx").on(t.state, t.lastSeen),
    // Le comptage du quota : sessions vivantes d'un enseignant, tous devoirs
    // confondus.
    index("sessions_teacher_idx").on(t.teacherId, t.state),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;

/**
 * Usage unique des jetons de lancement. Une ligne par `jti` consommé ; la
 * clé primaire *est* la garantie — un second `INSERT` du même `jti` échoue,
 * et c'est ce refus que `classroom/routes.ts` transforme en 403.
 *
 * `exp` n'est gardé que pour la purge : au-delà, le jeton est de toute façon
 * refusé par `verifyHs256`, donc la ligne n'a plus rien à empêcher.
 */
export const launchTokensUsed = sqliteTable(
  "launch_tokens_used",
  {
    jti: text("jti").primaryKey(),
    /** `exp` du jeton, en millisecondes. La ligne est purgée après. */
    exp: integer("exp", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("launch_tokens_used_exp_idx").on(t.exp)],
);

export type LaunchTokenUsedRow = typeof launchTokensUsed.$inferSelect;
