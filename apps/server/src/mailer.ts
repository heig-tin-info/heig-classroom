/**
 * Transactional email via Scaleway TEM. Nothing is sent inline: `queueEmail`
 * checks the recipient's per-kind preference, renders the message in their
 * locale and enqueues it on pg-boss (`email.send`); the worker performs the
 * actual API call with retries. Without SCW credentials the worker logs the
 * email instead of sending (dev dry-run).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { and, eq } from "drizzle-orm";

import { audit } from "./audit.js";
import type { AppConfig } from "./config.js";
import { enrollments, users } from "./db/schema.js";
import { EMAIL_QUEUE, type EmailJobData } from "./jobs.js";

/**
 * Notification catalogue. `audience` only drives which toggles each role sees
 * in the settings; the trigger sites decide the actual recipient.
 */
export const EMAIL_KINDS = {
  "assignment.published": { audience: "student", default: true },
  "deadline.reminder": { audience: "student", default: true },
  "grade.final": { audience: "student", default: true },
  "repo.invitation": { audience: "student", default: true },
  "provision.error": { audience: "teacher", default: true },
  "deadline.applied": { audience: "teacher", default: true },
} as const;

export type EmailKind = keyof typeof EMAIL_KINDS;

export function isEmailKind(k: string): k is EmailKind {
  return k in EMAIL_KINDS;
}

/** Resolved preference map (defaults filled in) for the settings API. */
export function resolvedPrefs(prefs: Record<string, boolean> | null): Record<EmailKind, boolean> {
  const out = {} as Record<EmailKind, boolean>;
  for (const [kind, def] of Object.entries(EMAIL_KINDS)) {
    out[kind as EmailKind] = prefs?.[kind] ?? def.default;
  }
  return out;
}

// --- Unsubscribe links: HMAC over (userId, kind), no login required. ---

export function unsubSignature(config: AppConfig, userId: string, kind: string): string {
  return createHmac("sha256", config.COOKIE_SECRET).update(`unsub:${userId}:${kind}`).digest("hex");
}

export function verifyUnsubSignature(
  config: AppConfig,
  userId: string,
  kind: string,
  sig: string,
): boolean {
  const expected = unsubSignature(config, userId, kind);
  return (
    sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  );
}

function unsubUrl(config: AppConfig, userId: string, kind: EmailKind): string {
  const sig = unsubSignature(config, userId, kind);
  return `${config.PUBLIC_URL}/app/email/unsub?u=${userId}&k=${encodeURIComponent(kind)}&s=${sig}`;
}

// --- Templates (en/fr), plain and minimal HTML. ---

interface EmailContent {
  subject: string;
  intro: string;
  cta?: { label: string; url: string };
}

export interface EmailParams {
  assignmentName?: string;
  classroomName?: string;
  deadlineAt?: string; // preformatted
  repoFullName?: string;
  grade?: string;
  detail?: string;
  [key: string]: string | undefined;
}

function content(kind: EmailKind, locale: "en" | "fr", p: EmailParams, portal: string): EmailContent {
  const repoUrl = p.repoFullName ? `https://github.com/${p.repoFullName}` : portal;
  if (locale === "fr") {
    switch (kind) {
      case "assignment.published":
        return {
          subject: `Nouveau devoir : ${p.assignmentName}`,
          intro: `Le devoir « ${p.assignmentName} » (${p.classroomName}) est ouvert. Échéance : ${p.deadlineAt}.`,
          cta: { label: "Accepter le devoir", url: portal },
        };
      case "deadline.reminder":
        return {
          subject: `Échéance demain : ${p.assignmentName}`,
          intro: `Le devoir « ${p.assignmentName} » (${p.classroomName}) arrive à échéance le ${p.deadlineAt}. Pensez à pousser votre travail.`,
          cta: { label: "Ouvrir le portail", url: portal },
        };
      case "grade.final":
        return {
          subject: `Note disponible : ${p.assignmentName}`,
          intro: `Votre note pour « ${p.assignmentName} » est disponible${p.grade ? ` : ${p.grade}` : ""}.`,
          cta: { label: "Voir ma note", url: portal },
        };
      case "repo.invitation":
        return {
          subject: `Dépôt créé : ${p.assignmentName}`,
          intro: `Votre dépôt ${p.repoFullName} est prêt. Acceptez l'invitation GitHub pour y accéder.`,
          cta: { label: "Ouvrir le dépôt", url: repoUrl },
        };
      case "provision.error":
        return {
          subject: `Échec de provisioning — ${p.assignmentName}`,
          intro: `La création du dépôt pour ${p.detail ?? "un étudiant"} (« ${p.assignmentName} », ${p.classroomName}) a échoué.`,
          cta: { label: "Ouvrir le portail", url: portal },
        };
      case "deadline.applied":
        return {
          subject: `Échéance appliquée : ${p.assignmentName}`,
          intro: `L'échéance de « ${p.assignmentName} » (${p.classroomName}) est passée${p.detail ? ` — ${p.detail}` : ""}.`,
          cta: { label: "Voir les rendus", url: portal },
        };
    }
  }
  switch (kind) {
    case "assignment.published":
      return {
        subject: `New assignment: ${p.assignmentName}`,
        intro: `The assignment “${p.assignmentName}” (${p.classroomName}) is open. Deadline: ${p.deadlineAt}.`,
        cta: { label: "Accept the assignment", url: portal },
      };
    case "deadline.reminder":
      return {
        subject: `Deadline tomorrow: ${p.assignmentName}`,
        intro: `The assignment “${p.assignmentName}” (${p.classroomName}) is due on ${p.deadlineAt}. Remember to push your work.`,
        cta: { label: "Open the portal", url: portal },
      };
    case "grade.final":
      return {
        subject: `Grade available: ${p.assignmentName}`,
        intro: `Your grade for “${p.assignmentName}” is available${p.grade ? `: ${p.grade}` : ""}.`,
        cta: { label: "See my grade", url: portal },
      };
    case "repo.invitation":
      return {
        subject: `Repository ready: ${p.assignmentName}`,
        intro: `Your repository ${p.repoFullName} is ready. Accept the GitHub invitation to access it.`,
        cta: { label: "Open the repository", url: repoUrl },
      };
    case "provision.error":
      return {
        subject: `Provisioning failed — ${p.assignmentName}`,
        intro: `Repository creation for ${p.detail ?? "a student"} (“${p.assignmentName}”, ${p.classroomName}) failed.`,
        cta: { label: "Open the portal", url: portal },
      };
    case "deadline.applied":
      return {
        subject: `Deadline enforced: ${p.assignmentName}`,
        intro: `The deadline of “${p.assignmentName}” (${p.classroomName}) has passed${p.detail ? ` — ${p.detail}` : ""}.`,
        cta: { label: "See the submissions", url: portal },
      };
  }
}

const FOOTER = {
  en: "You receive this email from HEIG Classroom. Unsubscribe from this kind of notification:",
  fr: "Vous recevez cet e-mail de HEIG Classroom. Se désinscrire de ce type de notification :",
} as const;

function render(
  config: AppConfig,
  kind: EmailKind,
  locale: "en" | "fr",
  userId: string,
  params: EmailParams,
): { subject: string; text: string; html: string } {
  const c = content(kind, locale, params, config.PUBLIC_URL);
  const unsub = unsubUrl(config, userId, kind);
  const text = [c.intro, c.cta ? `${c.cta.label}: ${c.cta.url}` : "", "", `${FOOTER[locale]} ${unsub}`]
    .filter((l) => l !== "")
    .join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#18181b">
  <h2 style="font-size:18px;margin:0 0 12px">HEIG Classroom</h2>
  <p style="font-size:14px;line-height:1.6;margin:0 0 20px">${escapeHtml(c.intro)}</p>
  ${c.cta ? `<p style="margin:0 0 24px"><a href="${c.cta.url}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500">${escapeHtml(c.cta.label)}</a></p>` : ""}
  <p style="font-size:12px;color:#71717a;border-top:1px solid #e4e4e7;padding-top:12px">${FOOTER[locale]} <a href="${unsub}" style="color:#71717a">unsubscribe</a></p>
</div>`;
  return { subject: c.subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Queueing (preference check + render at enqueue time) ---

export interface EmailJob {
  userId: string;
  kind: EmailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
  [key: string]: unknown;
}

/**
 * Enqueues one email for `user` unless their preference opts out. Silently a
 * no-op when the queue is down — notifications are best-effort by design.
 */
export async function queueEmail(
  app: FastifyInstance,
  config: AppConfig,
  user: {
    id: string;
    email: string;
    locale: "en" | "fr" | null;
    emailPrefs: Record<string, boolean> | null;
  },
  kind: EmailKind,
  params: EmailParams,
): Promise<void> {
  try {
    if (!app.boss) return;
    const wanted = user.emailPrefs?.[kind] ?? EMAIL_KINDS[kind].default;
    if (!wanted || !user.email) return;
    const locale = user.locale ?? "en";
    const rendered = render(config, kind, locale, user.id, params);
    await app.boss.send(EMAIL_QUEUE, {
      userId: user.id,
      kind,
      to: user.email,
      ...rendered,
    } satisfies EmailJob);
  } catch (err) {
    // Never let a notification failure break the business action around it.
    app.log.error({ err, kind, userId: user.id }, "email enqueue failed");
  }
}

// --- Worker: the actual Scaleway TEM call ---

export function makeEmailHandler(app: FastifyInstance, config: AppConfig) {
  const enabled = config.SCW_SECRET_KEY !== "" && config.SCW_DEFAULT_PROJECT_ID !== "";
  return async (job: EmailJobData) => {
    if (!enabled) {
      app.log.info({ to: job.to, kind: job.kind, subject: job.subject }, "email dry-run (no SCW credentials)");
      return;
    }
    const res = await fetch(
      `https://api.scaleway.com/transactional-email/v1alpha1/regions/${config.MAIL_REGION}/emails`,
      {
        method: "POST",
        headers: {
          "X-Auth-Token": config.SCW_SECRET_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: { email: config.MAIL_FROM, name: config.MAIL_FROM_NAME },
          to: [{ email: job.to }],
          subject: job.subject,
          text: job.text,
          html: job.html,
          project_id: config.SCW_DEFAULT_PROJECT_ID,
          additional_headers: [
            {
              key: "List-Unsubscribe",
              value: `<${config.PUBLIC_URL}/app/email/unsub?u=${job.userId}&k=${encodeURIComponent(job.kind)}&s=${unsubSignature(config, job.userId, job.kind)}>`,
            },
          ],
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Throw so pg-boss retries with backoff.
      throw new Error(`Scaleway TEM ${res.status}: ${body.slice(0, 300)}`);
    }
    await audit(app.db, {
      actorType: "system",
      action: "email.sent",
      subjectType: "user",
      subjectId: job.userId,
      payload: { kind: job.kind, subject: job.subject },
    });
  };
}

/** Loads the recipient fields `queueEmail` needs, by user id. */
export async function mailRecipient(app: FastifyInstance, userId: string) {
  const [u] = await app.db
    .select({
      id: users.id,
      email: users.email,
      locale: users.locale,
      emailPrefs: users.emailPrefs,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u ?? null;
}

/** Every user holding a claimed seat in the classroom (students + staff). */
export async function classroomRecipients(app: FastifyInstance, classroomId: string) {
  return app.db
    .select({
      id: users.id,
      email: users.email,
      locale: users.locale,
      emailPrefs: users.emailPrefs,
    })
    .from(enrollments)
    .innerJoin(users, eq(enrollments.userId, users.id))
    .where(and(eq(enrollments.classroomId, classroomId), eq(enrollments.status, "claimed")));
}
