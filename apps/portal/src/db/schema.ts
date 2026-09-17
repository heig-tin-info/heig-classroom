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
  /** Convention, p. ex. `codespace/{student}-tp-pointeurs`. `{student}` est substitué. */
  targetRepoPattern: text("target_repo_pattern"),
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
  quitUrl?: string;
  extraAllowedHosts?: string[];
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
    /** Vrai si la session est née d'un `GET /exam/<devoir>/start` vérifié. */
    sebVerified: integer("seb_verified", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    index("sessions_pair_idx").on(t.student, t.assignmentId, t.state),
    index("sessions_state_idx").on(t.state, t.lastSeen),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
