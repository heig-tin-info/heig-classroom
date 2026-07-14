/**
 * Notification catalogues shared by the server (emitters) and the web app
 * (toggles, toasts). One definition each: adding a kind on one side without
 * the other is a compile error.
 */

/** Real-time toast kinds carried by SSE notices (events.ts AppNotice). */
export type NoticeKind =
  | "student_joined"
  | "assignment_accepted"
  | "commit_pushed"
  | "grade_captured"
  | "protected_reverted"
  | "deadline_applied"
  | "llm_review_dispatched"
  | "sync";

/**
 * Transactional email catalogue. `audience` only drives which toggles each
 * role sees in the settings; the trigger sites decide the actual recipient.
 * `default` is the opt-out gate when the user never touched the preference.
 */
export const EMAIL_KINDS = {
  "assignment.published": { audience: "student", default: true },
  "deadline.reminder": { audience: "student", default: true },
  "grade.final": { audience: "student", default: true },
  "repo.invitation": { audience: "student", default: true },
  "provision.error": { audience: "teacher", default: true },
  "deadline.applied": { audience: "teacher", default: true },
  "org.deleted": { audience: "teacher", default: true },
} as const;

export type EmailKind = keyof typeof EMAIL_KINDS;

export function isEmailKind(k: string): k is EmailKind {
  return k in EMAIL_KINDS;
}
