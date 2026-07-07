import { Building2, X } from "lucide-react";
import { useState } from "react";
import type { ComponentType, ReactNode } from "react";

/** Avatar public GitHub d'une organisation, avec repli sur une icône. */
export function OrgAvatar({ login, className = "size-5" }: { login: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Building2 className={`${className} text-zinc-400`} />;
  return (
    <img
      src={`https://github.com/${login}.png?size=64`}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`rounded ${className}`}
    />
  );
}

/** Local ISO date-time: `2026-09-01 08:00`. */
export function isoDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Current local time formatted for a datetime-local input. */
export function localDateTimeInputValue(date = new Date()): string {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="mt-10 w-full max-w-3xl rounded-xl bg-white p-5 shadow-2xl dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <span className="flex-1" />
          <button
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Indeterminate progress bar (unknown duration work). */
export function Progress({ label }: { label: string }) {
  return (
    <div className="space-y-1.5" role="status" aria-label={label}>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{label}</p>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className="h-full w-1/3 animate-[progress_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
      </div>
      <style>{`@keyframes progress { 0% { margin-left: -33%; } 100% { margin-left: 100%; } }`}</style>
    </div>
  );
}

/** Marque GitHub (les icônes de marques ont quitté lucide). */
export function GithubIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function Button({
  children,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "subtle";
}) {
  const styles = {
    primary:
      "bg-accent text-white hover:bg-accent-hover shadow-sm disabled:opacity-50",
    ghost:
      "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
    subtle:
      "bg-zinc-100 text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700",
  }[variant];
  return (
    <button
      {...props}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-150 hover:-translate-y-px active:translate-y-0 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${styles} ${props.className ?? ""}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl bg-white shadow-[0_1px_2px_rgb(0_0_0/0.05),0_4px_16px_rgb(0_0_0/0.04)] transition-all duration-200 dark:bg-zinc-900 dark:shadow-[0_1px_2px_rgb(0_0_0/0.3)] ${className}`}
    >
      {children}
    </div>
  );
}

export function Badge({
  tone,
  icon: Icon,
  children,
}: {
  tone: "green" | "amber" | "red" | "zinc";
  icon?: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  const tones = {
    green:
      "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400",
    amber:
      "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-400",
    red: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-400",
    zinc: "bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300",
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones}`}
    >
      {Icon ? <Icon className="size-3" /> : null}
      {children}
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <div className="rounded-full bg-zinc-100 p-3 dark:bg-zinc-800">
        <Icon className="size-6 text-zinc-500 dark:text-zinc-400" />
      </div>
      <p className="font-medium">{title}</p>
      {children ? (
        <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">{children}</p>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      <input
        {...props}
        className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm shadow-sm placeholder:text-zinc-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 dark:border-zinc-700 dark:bg-zinc-900"
      />
    </label>
  );
}
