import {
  Bot,
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
 * Real-time notifications: SSE events may carry a typed notice (NoticeKind,
 * shared with the server via @hgc/contracts); enabled ones pop as toasts at
 * the bottom left and auto-dismiss. Preferences are per kind, stored in this
 * browser (localStorage).
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

interface Toast {
  id: number;
  kind: NoticeKind;
  message: string;
}

const ToastContext = createContext<{ notify: (kind: NoticeKind, message: string) => void }>({
  notify: () => {},
});

export function useNotify() {
  return useContext(ToastContext).notify;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const notify = useCallback((kind: NoticeKind, message: string) => {
    if (!notifyPrefs()[kind]) return;
    const id = ++seq.current;
    setToasts((prev) => [...prev.slice(-4), { id, kind, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className={`pointer-events-none fixed bottom-4 left-4 ${Z.toast} flex flex-col gap-2`}>
        {toasts.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <div
              key={t.id}
              className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-xl bg-white px-3 py-2.5 text-sm shadow-[0_4px_24px_rgb(0_0_0/0.15)] ring-1 ring-zinc-100 dark:bg-zinc-900 dark:ring-zinc-800 dark:shadow-[0_4px_24px_rgb(0_0_0/0.5)]"
              role="status"
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-accent" />
              <span className="text-zinc-700 dark:text-zinc-200">{t.message}</span>
              <button
                aria-label="Dismiss"
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
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
