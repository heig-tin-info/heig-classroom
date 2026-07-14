import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleCheck,
  GitCommitHorizontal,
  GitPullRequest,
  GraduationCap,
  Lock,
  ShieldAlert,
  UserPlus,
  X,
} from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import type { NoticeKind } from "@hgc/contracts";

import { Z } from "./ui";

/**
 * Toasts, bottom right, slide-in/out (see `toast-*` keyframes in style.css).
 * Two entry points share the stack:
 * - `useNotify()(kind, message)` — real-time SSE notices (NoticeKind, shared
 *   with the server via @hgc/contracts), gated by the per-browser
 *   preferences (localStorage);
 * - `useToast()(message, tone?)` — one-shot flow feedback (e.g. the GitHub
 *   linking return), never gated: the user just did the action.
 */

/** Local default per kind — the Record enforces the catalogue is complete. */
const NOTICE_DEFAULTS: Record<NoticeKind, boolean> = {
  student_joined: true,
  assignment_accepted: true,
  commit_pushed: false,
  grade_captured: true,
  protected_reverted: true,
  deadline_applied: true,
  llm_review_dispatched: true,
  sync: true,
};

/** Settings order: labels come from i18n (`notify.<kind>`). */
export const NOTICE_KINDS = (Object.keys(NOTICE_DEFAULTS) as NoticeKind[]).map((kind) => ({
  kind,
}));

const PREFS_KEY = "hgc-notify-prefs";

export function notifyPrefs(): Record<NoticeKind, boolean> {
  const defaults = { ...NOTICE_DEFAULTS };
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<
      Record<NoticeKind, boolean>
    >;
    return { ...defaults, ...stored };
  } catch {
    return defaults;
  }
}

export function setNotifyPref(kind: NoticeKind, enabled: boolean) {
  const prefs = notifyPrefs();
  prefs[kind] = enabled;
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

const ICONS: Record<NoticeKind, typeof UserPlus> = {
  student_joined: UserPlus,
  assignment_accepted: CircleCheck,
  commit_pushed: GitCommitHorizontal,
  grade_captured: GraduationCap,
  protected_reverted: ShieldAlert,
  deadline_applied: Lock,
  llm_review_dispatched: Bot,
  sync: GitPullRequest,
};

export type ToastTone = "success" | "error" | "warning";

const TONE_ICONS: Record<ToastTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertTriangle,
  warning: AlertTriangle,
};

const TONE_COLORS: Record<ToastTone, string> = {
  success: "text-emerald-500",
  error: "text-red-500",
  warning: "text-amber-500",
};

interface Toast {
  id: number;
  icon: typeof CheckCircle2;
  iconColor: string;
  message: string;
  /** Plays the exit animation; the entry is removed when it ends. */
  leaving?: boolean;
}

const ToastContext = createContext<{
  notify: (kind: NoticeKind, message: string) => void;
  toast: (message: string, tone?: ToastTone) => void;
}>({
  notify: () => {},
  toast: () => {},
});

export function useNotify() {
  return useContext(ToastContext).notify;
}

export function useToast() {
  return useContext(ToastContext).toast;
}

const AUTO_DISMISS_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  // Two-step removal: flag `leaving` so the slide-out animation plays, the
  // element itself is dropped by its onAnimationEnd.
  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
  }, []);

  const push = useCallback(
    (icon: typeof CheckCircle2, iconColor: string, message: string) => {
      const id = ++seq.current;
      setToasts((prev) => [...prev.slice(-4), { id, icon, iconColor, message }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const notify = useCallback(
    (kind: NoticeKind, message: string) => {
      if (!notifyPrefs()[kind]) return;
      push(ICONS[kind], "text-accent", message);
    },
    [push],
  );

  const toast = useCallback(
    (message: string, tone: ToastTone = "success") => {
      push(TONE_ICONS[tone], TONE_COLORS[tone], message);
    },
    [push],
  );

  return (
    <ToastContext.Provider value={{ notify, toast }}>
      {children}
      <div className={`pointer-events-none fixed bottom-4 right-4 ${Z.toast} flex flex-col items-end gap-2`}>
        {toasts.map((t) => {
          const Icon = t.icon;
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex max-w-sm items-start gap-2 rounded-xl bg-white px-3 py-2.5 text-sm shadow-[0_4px_24px_rgb(0_0_0/0.15)] ring-1 ring-zinc-100 dark:bg-zinc-900 dark:ring-zinc-800 dark:shadow-[0_4px_24px_rgb(0_0_0/0.5)] ${t.leaving ? "toast-leave" : "toast-enter"}`}
              role="status"
              onAnimationEnd={() => {
                if (t.leaving) setToasts((prev) => prev.filter((x) => x.id !== t.id));
              }}
            >
              <Icon className={`mt-0.5 size-4 shrink-0 ${t.iconColor}`} />
              <span className="text-zinc-700 dark:text-zinc-200">{t.message}</span>
              <button
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
                className="ml-1 rounded p-0.5 text-zinc-300 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-300"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
