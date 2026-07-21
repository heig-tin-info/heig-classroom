import { ArrowDown, ArrowUp, Building2, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ComponentType, ReactNode } from "react";

import type { DateFormat, Me } from "@hgc/contracts";

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

/** Ticking clock for countdowns; re-renders every `intervalMs`. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

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
 * Instant tooltip (replaces the laggy native `title`): dark bubble with an
 * arrow, rendered in a portal on hover/focus after 120 ms, tippy-like pop
 * animation (`tip-in` in style.css), flipped below the anchor near the top
 * edge and clamped to the viewport. Wraps any element; keep the accessible
 * name (`aria-label`) on the control itself — the bubble is aria-hidden.
 * A nullish label renders the child untouched (conditional tooltips).
 */
export function Tip({
  label,
  children,
  className = "inline-flex",
}: {
  label: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  const [tip, setTip] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!label) return <>{children}</>;
  const arm = (el: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const below = r.top < 44;
      setTip({
        x: Math.min(Math.max(r.left + r.width / 2, 16), window.innerWidth - 16),
        y: below ? r.bottom + 7 : r.top - 7,
        below,
      });
    }, 120);
  };
  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setTip(null);
  };
  return (
    <span
      className={className}
      onMouseEnter={(e) => arm(e.currentTarget)}
      onMouseLeave={disarm}
      onFocus={(e) => arm(e.currentTarget)}
      onBlur={disarm}
      onClick={disarm}
    >
      {children}
      {tip
        ? createPortal(
            <span
              aria-hidden
              className={`pointer-events-none fixed ${Z.tooltip}`}
              style={{
                left: tip.x,
                top: tip.y,
                transform: `translate(-50%, ${tip.below ? "0" : "-100%"})`,
              }}
            >
              <span
                className={`tip-bubble relative block rounded-md bg-zinc-800 px-2 py-1 text-xs font-medium text-white shadow-lg dark:bg-zinc-600 ${
                  tip.below ? "origin-top" : "origin-bottom"
                } ${label.length > 60 ? "max-w-xs whitespace-normal" : "whitespace-nowrap"}`}
              >
                {label}
                <span
                  className={`absolute left-1/2 size-2 -translate-x-1/2 rotate-45 bg-zinc-800 dark:bg-zinc-600 ${
                    tip.below ? "-top-1" : "-bottom-1"
                  }`}
                />
              </span>
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

/** Icon-only button on the shared Tip tooltip (label = accessible name too). */
export function IconButton({
  label,
  danger,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; danger?: boolean }) {
  return (
    <Tip label={label}>
      <button
        {...props}
        aria-label={label}
        className={`rounded-md p-1.5 transition-colors disabled:pointer-events-none disabled:opacity-40 ${
          danger
            ? "text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
            : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        }`}
      />
    </Tip>
  );
}

/** User avatar: uploaded/IdP picture, or initials on the accent color. */
export function Avatar({ me, className = "size-16 text-xl" }: { me: Me; className?: string }) {
  if (me.avatarUrl) {
    return (
      <img
        src={me.avatarUrl}
        alt=""
        className={`rounded-full object-cover ${className}`}
        referrerPolicy="no-referrer"
      />
    );
  }
  const initials =
    `${me.givenName.charAt(0)}${me.familyName.charAt(0)}`.toUpperCase() || "?";
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full bg-accent font-semibold text-white ${className}`}
    >
      {initials}
    </span>
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

/** Account preference adopted in App.tsx; module-level on purpose — date
    formatting is plain string work, every view re-renders through the `me`
    query when the preference changes. */
let dateFormat: DateFormat = "iso";
export function setDateFormat(f: DateFormat | null | undefined) {
  dateFormat = f ?? "iso";
}

/** A date-time in an explicit format (used by the settings preview). */
export function formatDateTimeAs(iso: string, f: DateFormat): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  const [Y, M, D] = [d.getFullYear(), p(d.getMonth() + 1), p(d.getDate())];
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  switch (f) {
    case "eu":
      return `${D}.${M}.${Y} ${hm}`;
    case "uk":
      return `${D}/${M}/${Y} ${hm}`;
    case "us":
      return `${M}/${D}/${Y} ${d.getHours() % 12 || 12}:${p(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
    default:
      return `${Y}-${M}-${D} ${hm}`;
  }
}

/** Local date-time in the user's preferred format; ISO `2026-09-01 08:00` by default. */
export function isoDateTime(iso: string): string {
  return formatDateTimeAs(iso, dateFormat);
}

/** "labo-02-quadratic" → "Labo 02 Quadratic" (default assignment/classroom name). */
export function humanize(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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
  // Deliberately no close-on-backdrop-click: modals hold forms, and a stray
  // click outside must not discard them. Closing is the X or an explicit button.
  return (
    <div
      className={`modal-backdrop fixed inset-0 ${Z.modal} flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="modal-panel mt-10 w-full max-w-3xl rounded-xl bg-white p-5 shadow-2xl dark:bg-zinc-900">
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

/** Centered spinner for a panel whose data is still loading. */
export function Spinner({ label, className = "py-12" }: { label?: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label ?? "Loading"}
      className={`flex flex-col items-center justify-center gap-2 ${className}`}
    >
      <Loader2 className="size-6 animate-spin text-accent" />
      {label ? <p className="text-sm text-zinc-500 dark:text-zinc-400">{label}</p> : null}
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
      // disabled:pointer-events-none: hovering a disabled button must hit the
      // wrapping Tip span (disabled controls swallow mouse events).
      className={`hgc-btn inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-150 hover:-translate-y-px active:translate-y-0 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none ${styles} ${props.className ?? ""}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`hgc-card rounded-xl bg-white shadow-[0_1px_2px_rgb(0_0_0/0.05),0_4px_16px_rgb(0_0_0/0.04)] transition-all duration-200 dark:bg-zinc-900 dark:shadow-[0_1px_2px_rgb(0_0_0/0.3)] ${className}`}
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

/**
 * Radio group for 2–3 mutually exclusive choices: every option is visible
 * (unlike a dropdown), and the plain native radio is the whole selected
 * state — no boxes, borders or fills, the form stays light. A `fieldset`
 * so `disabled` freezes every radio natively.
 */
export function RadioGroup<T extends string>({
  name,
  label,
  help,
  value,
  options,
  onChange,
  disabled,
  className = "",
}: {
  /** Groups the native radios (one form can hold several groups). */
  name: string;
  label: ReactNode;
  help?: string;
  value: T;
  options: { value: T; label: string; description?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <fieldset className={`min-w-0 text-sm ${disabled ? "opacity-60" : ""} ${className}`} disabled={disabled}>
      <legend className="mb-1.5 flex items-center gap-1 font-medium text-zinc-700 dark:text-zinc-300">
        {label}
        {help ? <HelpIcon topic={help} /> : null}
      </legend>
      <div className="space-y-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={`flex items-start gap-2 ${disabled ? "" : "cursor-pointer"}`}
          >
            <input
              type="radio"
              name={name}
              className="mt-0.5 accent-accent"
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span className="min-w-0">
              <span className="block leading-5">{o.label}</span>
              {o.description ? (
                <span className="block text-xs leading-4 text-zinc-500 dark:text-zinc-400">
                  {o.description}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// --- Range calendar (assignment start → deadline) ---

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Local "YYYY-MM-DD" key — comparable with plain string ordering. */
export function localDateKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Days of a month as "YYYY-MM-DD" keys, padded with nulls to a Monday start. */
function monthDays(year: number, month: number): (string | null)[] {
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const count = new Date(year, month + 1, 0).getDate();
  return [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: count }, (_, i) => localDateKey(new Date(year, month, i + 1))),
  ];
}

/**
 * Inline two-month calendar (one on mobile), Monday-first.
 * - `mode="range"`: first click picks the start, second the end; the interval
 *   is drawn as a continuous band. Clicking again restarts the selection, and
 *   while the end is pending the hovered range is previewed.
 * - `mode="single"`: one date only, carried in `end` (`start` is ignored).
 * Dates are "YYYY-MM-DD" strings ("" = unset); time is not this component's
 * concern — pair it with `type="time"` inputs.
 */
export function RangeCalendar({
  start,
  end,
  mode,
  onChange,
}: {
  start: string;
  end: string;
  mode: "range" | "single";
  onChange: (start: string, end: string) => void;
}) {
  const today = localDateKey();
  const anchor = (mode === "range" ? start : end) || end || today;
  const [view, setView] = useState({
    y: Number(anchor.slice(0, 4)),
    m: Number(anchor.slice(5, 7)) - 1,
  });
  const [hover, setHover] = useState("");

  const picking = mode === "range" && start !== "" && end === "";
  // While picking the end, preview the band up to the hovered day.
  const bandEnd = end || (picking && hover >= start ? hover : "");

  const pick = (day: string) => {
    if (mode === "single") onChange("", day);
    else if (!start || end || day < start) onChange(day, "");
    else onChange(start, day);
  };

  const shift = (delta: number) =>
    setView(({ y, m }) => {
      const n = y * 12 + m + delta;
      return { y: Math.floor(n / 12), m: ((n % 12) + 12) % 12 };
    });

  const nav = (delta: number, label: string, className = "") => (
    <button
      type="button"
      aria-label={label}
      onClick={() => shift(delta)}
      className={`rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 ${className}`}
    >
      {delta < 0 ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
    </button>
  );

  return (
    <div className="flex justify-center gap-8" onMouseLeave={() => setHover("")}>
      {[0, 1].map((k) => {
        const y = view.y + Math.floor((view.m + k) / 12);
        const m = (view.m + k) % 12;
        return (
          <div key={k} className={k === 1 ? "hidden sm:block" : ""}>
            <div className="mb-1 flex items-center justify-between">
              {k === 0 ? nav(-1, "Previous month") : <span className="size-6" />}
              <span className="text-sm font-medium">
                {MONTH_NAMES[m]} {y}
              </span>
              {/* Right arrow lives on the last visible month (first on mobile). */}
              {k === 0 ? nav(1, "Next month", "sm:invisible") : nav(1, "Next month")}
            </div>
            <div className="grid grid-cols-7 text-center">
              {WEEKDAYS.map((d) => (
                <span key={d} className="pb-1 text-xs font-medium text-zinc-400">
                  {d}
                </span>
              ))}
              {monthDays(y, m).map((day, i) =>
                day === null ? (
                  <span key={`pad-${i}`} />
                ) : (
                  <button
                    key={day}
                    type="button"
                    onClick={() => pick(day)}
                    onMouseEnter={() => setHover(day)}
                    aria-pressed={day === start || day === end}
                    className={`h-8 w-9 text-sm tabular-nums transition-colors ${
                      (mode === "range" && day === start) || day === end
                        ? `bg-accent font-medium text-white ${
                            mode === "single" || !bandEnd || start === bandEnd
                              ? "rounded-md"
                              : day === start
                                ? "rounded-l-md"
                                : "rounded-r-md"
                          }`
                        : bandEnd !== "" && day > start && day < bandEnd && mode === "range"
                          ? "bg-accent/10 text-zinc-800 dark:text-zinc-200"
                          : day === bandEnd && picking
                            ? "rounded-r-md bg-accent/70 text-white"
                            : `rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                                day === today ? "font-semibold text-accent" : ""
                              }`
                    }`}
                  >
                    {Number(day.slice(8, 10))}
                  </button>
                ),
              )}
            </div>
          </div>
        );
      })}
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
