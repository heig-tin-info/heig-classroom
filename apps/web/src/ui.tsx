import { ArrowDown, ArrowUp, Building2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ComponentType, ReactNode } from "react";

import { HelpIcon } from "./help";

/**
 * Stacking scale (SSOT): popovers < modal = toasts < modal overlay <
 * help drawer < tooltips. Literal Tailwind tokens live here so the JIT
 * scanner picks them up; compose with template strings.
 */
export const Z = {
  popover: "z-30",
  modal: "z-50",
  toast: "z-50",
  /** Above the modal: CreatingOverlay greys the whole dialog out. */
  overlay: "z-[60]",
  /** Help must be able to slide over a modal that summoned it. */
  helpBackdrop: "z-[75]",
  help: "z-[80]",
  tooltip: "z-[90]",
} as const;

// --- Sortable tables (one motif for every hand-rolled table) ---

export interface SortState<K extends string> {
  key: K;
  dir: 1 | -1;
}

const defaultCompare = (x: string | number, y: string | number) =>
  typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));

/**
 * Sort state + sorted rows for a client-side table: clicking the active
 * column flips the direction, clicking another selects it ascending.
 */
export function useSortableTable<T, K extends string>(
  rows: T[],
  rank: (row: T, key: K) => string | number,
  initial: SortState<NoInfer<K>>,
  compare: (x: string | number, y: string | number) => number = defaultCompare,
) {
  const [sort, setSort] = useState<SortState<K>>(initial);
  const toggle = (k: K) =>
    setSort((s) => (s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: 1 }));
  const sorted = useMemo(
    () => [...rows].sort((a, b) => compare(rank(a, sort.key), rank(b, sort.key)) * sort.dir),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rank/compare are stable per table
    [rows, sort],
  );
  return { sorted, sort, toggle };
}

/** Clickable column header bound to useSortableTable. */
export function SortHeader<K extends string>({
  k,
  sort,
  onToggle,
  children,
  className = "",
  buttonClassName = "hover:text-zinc-900 dark:hover:text-zinc-100",
}: {
  k: K;
  sort: SortState<K>;
  onToggle: (k: K) => void;
  children: ReactNode;
  className?: string;
  buttonClassName?: string;
}) {
  const active = sort.key === k;
  return (
    <th className={className}>
      <button
        className={`inline-flex items-center gap-1 uppercase tracking-wide ${buttonClassName}`}
        onClick={() => onToggle(k)}
      >
        {children}
        {active ? (
          sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
        ) : null}
      </button>
    </th>
  );
}

/**
 * Icon-only button with a real tooltip: a small dark bubble rendered in a
 * portal on hover/focus (240 ms delay), flipping below the button when there
 * is no room above and clamped to the viewport — no native `title` lag.
 */
export function IconButton({
  label,
  danger,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; danger?: boolean }) {
  const [tip, setTip] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const below = r.top < 40;
    setTip({
      x: Math.min(Math.max(r.left + r.width / 2, 16), window.innerWidth - 16),
      y: below ? r.bottom + 6 : r.top - 6,
      below,
    });
  };
  const arm = (el: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => show(el), 240);
  };
  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setTip(null);
  };
  return (
    <>
      <button
        {...props}
        aria-label={label}
        onMouseEnter={(e) => arm(e.currentTarget)}
        onMouseLeave={disarm}
        onFocus={(e) => arm(e.currentTarget)}
        onBlur={disarm}
        onClick={(e) => {
          disarm();
          props.onClick?.(e);
        }}
        className={`rounded-md p-1.5 transition-colors ${
          danger
            ? "text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
            : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        }`}
      />
      {tip
        ? createPortal(
            <span
              role="tooltip"
              className={`pointer-events-none fixed ${Z.tooltip} whitespace-nowrap rounded-md bg-zinc-800 px-2 py-1 text-xs font-medium text-white shadow-lg dark:bg-zinc-600`}
              style={{
                left: tip.x,
                top: tip.y,
                transform: `translate(-50%, ${tip.below ? "0" : "-100%"})`,
              }}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

/** Public GitHub avatar of an organization, with an icon fallback. */
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
      className={`fixed inset-0 ${Z.modal} flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm`}
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

/** GitHub brand mark (brand icons were removed from lucide). */
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
  help,
  fullWidth,
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  help?: string;
  /** Stretch label and input to the parent width (grid cells). */
  fullWidth?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 text-sm ${fullWidth ? "w-full" : ""}`}>
      <span className="flex items-center gap-1 font-medium text-zinc-700 dark:text-zinc-300">
        {label}
        {help ? <HelpIcon topic={help} /> : null}
      </span>
      <input
        {...props}
        className={`rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm shadow-sm placeholder:text-zinc-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 dark:border-zinc-700 dark:bg-zinc-900 ${fullWidth ? "w-full" : ""} ${className}`}
      />
    </label>
  );
}
