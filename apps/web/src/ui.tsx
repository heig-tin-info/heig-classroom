import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ComponentType, ReactNode, RefObject } from "react";

import type { DateFormat, Me } from "@hgc/contracts";

import { apiErrorMessage } from "./api";
import { HelpIcon } from "./help";
import { useT } from "./i18n";

/*
 * Shared primitives. Every visual value here comes from DESIGN.md (tokens in
 * style.css): semantic colors (`surface`, `fg-muted`, `line`…) swap in dark
 * mode by themselves, so components carry no `dark:` variants.
 */

/** Joins class names, skipping falsy entries. */
export const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(" ");

export type IconType = ComponentType<{ className?: string }>;

/**
 * Stacking scale (SSOT): sheet = dialog = toasts < popovers < busy overlay <
 * help drawer < tooltips. Literal Tailwind tokens live here so the JIT
 * scanner picks them up; compose with template strings.
 *
 * A popover sits ABOVE the dialog layer, not below it: menus are opened from
 * inside sheets, dialogs and the mobile drawer (the account menu), and a
 * panel portalled to <body> under those layers is simply invisible. It stays
 * below `overlay`, which greys out everything on purpose.
 */
export const Z = {
  popover: "z-55",
  modal: "z-50",
  toast: "z-50",
  /** Above the dialog: CreatingOverlay greys the whole dialog out. */
  overlay: "z-60",
  /** Help must be able to slide over a dialog that summoned it. */
  helpBackdrop: "z-75",
  help: "z-80",
  tooltip: "z-90",
} as const;

/**
 * Keyboard contract for an element made clickable without being a <button>
 * (a card, a table row): Enter and Space activate it, and Space does not
 * scroll the page underneath. Spread it next to the element's own `onClick`.
 *
 * `role` is a parameter because a clickable <tr> must stay a row: announcing
 * it as a button would cost the reader the table structure around it. Cards
 * take the default.
 *
 * A key press that started on a nested control (a link, a menu trigger) is
 * that control's business, so only the element itself answers.
 */
export function pressable(onActivate: () => void, role: string = "button") {
  return {
    role,
    tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      onActivate();
    },
  };
}

/** Ticking clock for countdowns; re-renders every `intervalMs`. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/*
 * Floating layers keep a stack. Only the topmost one answers Escape and traps
 * Tab, so the help drawer opened from a dialog (or a menu opened inside a
 * sheet) closes on its own instead of taking everything underneath with it.
 */
const layers: object[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tabbable descendants of `root`, in document order, skipping hidden ones. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
  );
}

/**
 * Registers one open floating layer (dialog, sheet, drawer, menu):
 * - Escape calls `onClose`, but only while this layer is the topmost one;
 * - with `trap` (the default), focus moves into `panel` on open, Tab and
 *   Shift+Tab cycle inside it, and the element that opened the layer gets the
 *   focus back on close.
 * `panel` must carry `tabIndex={-1}` so it can hold the focus by itself when
 * it has no focusable child.
 */
export function useLayer(
  panel: RefObject<HTMLElement | null>,
  onClose: () => void,
  { trap = true, enabled = true }: { trap?: boolean; enabled?: boolean } = {},
) {
  // Latest callback without re-arming the listener on every render.
  const close = useRef(onClose);
  close.current = onClose;
  // Element to give the focus back to, captured during the render that opens
  // the layer: an `autoFocus` inside the panel lands during the commit, before
  // effects run, so reading it from the effect would capture a node the layer
  // is about to unmount.
  const opener = useRef<HTMLElement | null>(null);
  if (!enabled) opener.current = null;
  else opener.current ??= document.activeElement as HTMLElement | null;
  // Giving the focus back is deferred by one frame and cancelled if the layer
  // mounts again right away: that is exactly the mount/cleanup/mount StrictMode
  // replays in development, and restoring there would undo an `autoFocus`
  // inside the panel.
  const restore = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const token = {};
    layers.push(token);
    const onTop = () => layers[layers.length - 1] === token;
    if (restore.current != null) {
      cancelAnimationFrame(restore.current);
      restore.current = null;
    }
    const restoreTo = opener.current;
    if (trap && panel.current && !panel.current.contains(document.activeElement)) {
      (focusableIn(panel.current)[0] ?? panel.current).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (!onTop()) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
        return;
      }
      if (!trap || e.key !== "Tab" || !panel.current) return;
      const items = focusableIn(panel.current);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        panel.current.focus();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      if (!active || !panel.current.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const i = layers.lastIndexOf(token);
      if (i >= 0) layers.splice(i, 1);
      if (trap && restoreTo) {
        restore.current = requestAnimationFrame(() => {
          restore.current = null;
          const active = document.activeElement;
          // Another layer opened in the same tick and has taken the focus (a
          // help topic run from the command palette): it owns the focus now,
          // and pulling it back to our own trigger would strand the reader
          // behind the new panel. The question can only be answered here, one
          // frame later: at cleanup time the focused node has just been
          // unmounted, so the focus is on <body> either way.
          if (active && active !== document.body) return;
          if (restoreTo.isConnected) restoreTo.focus();
        });
      }
    };
  }, [enabled, trap, panel]);
}

/** Escape-only layer, for a floating element with no panel to trap. */
export function useEscape(onEscape: () => void, enabled = true) {
  const none = useRef<HTMLElement>(null);
  useLayer(none, onEscape, { trap: false, enabled });
}

/** Locks the page scroll while a floating layer is open. */
export function useScrollLock() {
  useLayoutEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
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

/** Table styles (DESIGN.md › Components): dense 13 px rows, hairline dividers. */
export const T = {
  table: "w-full text-[13px]",
  head: "text-left text-xs text-fg-muted",
  th: "px-3 py-2 font-medium",
  td: "px-3 py-2.5 align-middle",
  row: "border-t border-line transition-colors",
  rowHover: "hover:bg-surface-2/70",
} as const;

/** Clickable column header bound to useSortableTable. */
export function SortHeader<K extends string>({
  k,
  sort,
  onToggle,
  children,
  className = "",
  right,
}: {
  k: K;
  sort: SortState<K>;
  onToggle: (k: K) => void;
  children: ReactNode;
  className?: string;
  right?: boolean;
}) {
  const active = sort.key === k;
  return (
    <th className={cx(T.th, right && "text-right", className)}>
      <button
        type="button"
        className={cx(
          "inline-flex items-center gap-1 rounded-sm transition-colors hover:text-fg",
          active && "text-fg",
        )}
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
 * Instant tooltip (replaces the laggy native `title`): inverted bubble with an
 * arrow, rendered in a portal on hover/focus after 120 ms, flipped below the
 * anchor near the top edge and clamped to the viewport. Wraps any element;
 * keep the accessible name (`aria-label`) on the control itself — the bubble
 * is aria-hidden. A nullish label renders the child untouched.
 * The bubble never takes the focus (portal, `pointer-events-none`, no
 * tabindex) and Escape dismisses it (WCAG 1.4.13).
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
  // Escape hides the bubble without moving the hover or the focus. Deliberately
  // not part of the layer stack: a tooltip never owns the Escape key.
  useEffect(() => {
    if (!tip) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTip(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tip]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
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
                className={cx(
                  "tip-bubble relative block rounded-lg bg-fg px-2.5 py-1.5 text-xs font-medium leading-snug text-canvas",
                  tip.below ? "origin-top" : "origin-bottom",
                  label.length > 60 ? "max-w-xs whitespace-normal" : "whitespace-nowrap",
                )}
              >
                {label}
                <span
                  className={cx(
                    "absolute left-1/2 size-2 -translate-x-1/2 rotate-45 bg-fg",
                    tip.below ? "-top-1" : "-bottom-1",
                  )}
                />
              </span>
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

// --- Buttons ---

export type ButtonVariant = "primary" | "secondary" | "subtle" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-fill hover:bg-accent-hover",
  secondary: "border border-line-strong bg-surface text-fg hover:bg-surface-2",
  subtle: "bg-surface-3 text-fg hover:bg-line-strong/70",
  ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg",
  danger: "bg-danger text-on-fill hover:opacity-90",
};
const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-3 text-[13px] [&_svg]:size-3.5",
  md: "h-8.5 px-4 text-sm [&_svg]:size-4",
  lg: "h-10 px-5 text-sm [&_svg]:size-4",
};

/** Class list of a button; shared by <Button>, <LinkButton> and raw anchors. */
export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", extra = "") {
  return cx(
    // disabled:pointer-events-none: hovering a disabled button must hit the
    // wrapping Tip span (disabled controls swallow mouse events).
    "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background-color,color,border-color,opacity,transform] duration-150 ease-out-emphasized active:scale-97 disabled:pointer-events-none disabled:opacity-50",
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    extra,
  );
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  loading,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of the leading icon and disables the button. */
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      className={buttonClass(variant, size, className)}
    >
      {loading ? <Loader2 className="animate-spin" /> : null}
      {children}
    </button>
  );
}

/** Anchor styled as a button (external links, downloads, plain navigations). */
export function LinkButton({
  children,
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <a {...props} className={buttonClass(variant, size, className)}>
      {children}
    </a>
  );
}

/** Icon-only round button on the shared Tip tooltip (label = accessible name too). */
export function IconButton({
  label,
  danger,
  active,
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  danger?: boolean;
  /** Pressed state (view toggles, filters): accent-soft chip. */
  active?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <Tip label={label}>
      <button
        type="button"
        {...props}
        aria-label={label}
        aria-pressed={active}
        className={cx(
          "inline-flex shrink-0 items-center justify-center rounded-full transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40",
          size === "sm" ? "size-7 [&_svg]:size-3.5" : "size-8 [&_svg]:size-4",
          active
            ? "bg-accent-soft text-accent"
            : danger
              ? "text-fg-faint hover:bg-danger-soft hover:text-danger"
              : "text-fg-faint hover:bg-surface-2 hover:text-fg",
          className,
        )}
      />
    </Tip>
  );
}

// --- Identity ---

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
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-on-fill ${className}`}
    >
      {initials}
    </span>
  );
}

/** Initials disc for a roster entry (no account picture, or one that failed). */
export function Initials({
  name,
  className = "size-7 text-xs",
}: {
  name: [string, string];
  className?: string;
}) {
  const initials = `${name[0].charAt(0)}${name[1].charAt(0)}`.toUpperCase() || "?";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-semibold text-fg-muted ${className}`}
    >
      {initials}
    </span>
  );
}

/** Public GitHub avatar of an organization, with an icon fallback. */
export function OrgAvatar({ login, className = "size-5" }: { login: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Building2 className={`${className} text-fg-faint`} />;
  return (
    <img
      src={`https://github.com/${login}.png?size=64`}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-md ${className}`}
    />
  );
}

// --- Dates ---

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

// --- Floating layers: dialog, sheet, menu ---

function LayerClose({ onClose }: { onClose: () => void }) {
  return (
    <IconButton label="Close" onClick={onClose} className="-mr-1.5">
      <X />
    </IconButton>
  );
}

/**
 * Centered dialog for confirmations and one-field forms (≤ 480 px by
 * default). Long forms belong in a <Sheet>. Deliberately no close on
 * backdrop click: a stray click must not discard what the user typed.
 */
export function Modal({
  title,
  subtitle,
  size = "md",
  onClose,
  children,
  footer,
}: {
  title: string;
  /** Muted state line under the title. */
  subtitle?: ReactNode;
  size?: "sm" | "md" | "lg";
  onClose: () => void;
  children: ReactNode;
  /** Actions row, right-aligned, on its own hairline. */
  footer?: ReactNode;
}) {
  useScrollLock();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayer(panel, onClose);
  const width = { sm: "max-w-105", md: "max-w-130", lg: "max-w-190" }[size];
  return createPortal(
    <div
      // The portal escapes the DOM but not the React tree: without this, a
      // click inside the dialog bubbles up to the <tr onClick> that rendered
      // it and toggles the row behind the user's back.
      onClick={(e) => e.stopPropagation()}
      className={`layer-backdrop fixed inset-0 ${Z.modal} flex items-start justify-center overflow-y-auto bg-fg/30 p-4 backdrop-blur-[2px] sm:items-center`}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "dialog-panel mt-8 w-full rounded-sheet border border-line bg-surface shadow-overlay focus:outline-none sm:mt-0",
          width,
        )}
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-bold tracking-tight">
              {title}
            </h2>
            {subtitle ? <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p> : null}
          </div>
          <LayerClose onClose={onClose} />
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Right-hand drawer for anything longer than three fields (assignment form,
 * imports, histories). Header and footer stay put, the body scrolls.
 * Same closing rule as the dialog: Escape or the X, never the backdrop.
 */
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = "md",
  flush,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: "md" | "lg";
  /** Children own the padding (full-bleed sections separated by hairlines). */
  flush?: boolean;
}) {
  useScrollLock();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayer(panel, onClose);
  return createPortal(
    <div
      // Same as Modal: a click in the panel must not reach the row, card or
      // cell whose onClick opened the sheet.
      onClick={(e) => e.stopPropagation()}
      className={`layer-backdrop fixed inset-0 ${Z.modal} flex justify-end bg-fg/30 backdrop-blur-[2px]`}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "sheet-panel flex h-full w-full flex-col border-l border-line bg-surface shadow-sheet focus:outline-none",
          width === "lg" ? "sm:max-w-190" : "sm:max-w-150",
        )}
      >
        <div className="flex items-start gap-3 border-b border-line px-6 pb-4 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-bold tracking-tight">
              {title}
            </h2>
            {subtitle ? <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p> : null}
          </div>
          <LayerClose onClose={onClose} />
        </div>
        <div className={cx("min-h-0 flex-1 overflow-y-auto", !flush && "px-6 py-5")}>
          {children}
        </div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-6 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  /** Second, muted line under the label: what the item produces, in one go. */
  description?: string;
  icon?: IconType;
  onSelect?: () => void;
  /** Plain link item (external URLs, downloads). */
  href?: string;
  danger?: boolean;
  /**
   * Greys the item out and takes it out of the arrow order. It reflects the
   * state WHEN THE MENU WAS OPENED, not a busy state: selecting an item
   * closes the menu, so a `disabled` bound to a mutation's `isPending` can
   * never be seen. Report progress with a toast instead.
   */
  disabled?: boolean;
  /** Draws a hairline above this item. */
  separator?: boolean;
}

/** Height assumed for the panel when deciding to flip it upward. */
const MENU_FLIP_MARGIN = 280;

/** How long after opening a scroll is treated as the opening, not a dismissal. */
const MENU_SCROLL_GRACE = 200;

export interface MenuPlacement {
  top?: number;
  bottom?: number;
  left: number;
  /** The panel opens above the trigger. */
  up: boolean;
}

/**
 * Fixed coordinates of the menu panel from the trigger rectangle. The panel
 * drops under the trigger, and flips above it when the trigger sits low on a
 * short viewport (the sidebar account row). `align="end"` anchors the panel's
 * right edge on the trigger's right; the caller applies the translation.
 * Pure on purpose: this is the part worth unit-testing.
 */
export function menuPosition(
  rect: { top: number; bottom: number; left: number; right: number },
  viewport: { width: number; height: number },
  align: "start" | "end",
  panelHeight = MENU_FLIP_MARGIN,
): MenuPlacement {
  const up = rect.bottom + panelHeight > viewport.height && rect.top > viewport.height / 2;
  return {
    ...(up ? { bottom: viewport.height - rect.top + 6 } : { top: rect.bottom + 6 }),
    left: align === "end" ? rect.right : rect.left,
    up,
  };
}

/**
 * Overflow menu for tertiary actions. Positioned in a portal from the
 * trigger's rectangle (so it escapes overflow-hidden cards and tables) and
 * closes on outside click, Escape, page scroll or selection. A scroll inside
 * the panel, or within `MENU_SCROLL_GRACE` of the opening, is not a dismissal.
 *
 * Keyboard (WAI-ARIA menu button): Enter, Space or ArrowDown on the trigger
 * opens the menu on its first item, ArrowUp opens it on the last; arrows move
 * with wrap, Home/End jump to the ends, Escape closes and hands the focus back
 * to the trigger, Tab closes and lets the browser carry on from the trigger.
 */
export function Menu({
  items,
  label = "More actions",
  trigger,
  align = "end",
}: {
  items: MenuItem[];
  label?: string;
  /** Custom trigger; the default is a round ellipsis button. */
  trigger?: ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPlacement | null>(null);
  /** Index of the focused item in `items`; -1 when the menu was opened by mouse. */
  const [active, setActive] = useState(-1);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const menuId = useId();
  /**
   * When the menu opened, in ms. The opening click itself can make the page
   * scroll (the browser bringing the focused trigger into view on a tall
   * phone layout), and that scroll used to close the menu in the same frame.
   * Scrolls inside this grace period are the opening, not the user leaving.
   */
  const openedAt = useRef(0);

  /** Indexes of the items the keyboard may land on (disabled ones are skipped). */
  const reachable = useMemo(
    () => items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0),
    [items],
  );

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (restoreFocus) anchor.current?.querySelector<HTMLElement>("button, a")?.focus();
  }, []);

  useLayer(panel, () => close(true), { trap: false, enabled: open });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchor.current?.contains(t) || panel.current?.contains(t)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      // A scroll inside the panel is the user reading a long menu, and one in
      // the first MENU_SCROLL_GRACE ms is the opening click's own scroll.
      if (panel.current?.contains(e.target as Node)) return;
      if (Date.now() - openedAt.current < MENU_SCROLL_GRACE) return;
      close(false);
    };
    const onResize = () => close(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  // The panel is portalled, so the focus can only move once it is on screen.
  useEffect(() => {
    if (open && active >= 0) itemRefs.current[active]?.focus();
  }, [open, active]);

  /*
   * `menuPosition` anchors the panel on the trigger and knows nothing of the
   * panel's own width, so a right-aligned trigger near the left edge (the
   * overflow button of a page header on a phone) put half the panel off
   * screen. Measure once it is laid out and nudge it back inside. A layout
   * effect: doing it after paint would show the panel in the wrong place for
   * one frame.
   */
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    const margin = 8;
    const clamp = () => {
      if (!pos) return;
      el.style.marginLeft = "";
      // Computed from `pos` and the panel's width, never from its rectangle:
      // the opening animation owns `transform` for 160 ms and drops the
      // `translateX(-100%)` of a right-aligned panel while it plays, so a
      // measured rectangle is wrong exactly when this effect runs.
      const width = el.offsetWidth;
      const left = align === "end" ? pos.left - width : pos.left;
      const shift =
        left < margin
          ? margin - left
          : left + width > window.innerWidth - margin
            ? window.innerWidth - margin - (left + width)
            : 0;
      if (shift) el.style.marginLeft = `${shift}px`;
    };
    clamp();
    // The panel's width can land after the first measurement (a font, an icon
    // or, in dev, a class the stylesheet has not generated yet), and a stale
    // measurement is worse than none: re-clamp whenever it changes.
    const observer = new ResizeObserver(clamp);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, pos, align]);

  const openAt = (index: number) => {
    if (!anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    setPos(menuPosition(r, { width: window.innerWidth, height: window.innerHeight }, align));
    setActive(index);
    openedAt.current = Date.now();
    setOpen(true);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (open) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      // preventDefault also swallows the click the browser would synthesize.
      e.preventDefault();
      openAt(reachable[0] ?? -1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openAt(reachable[reachable.length - 1] ?? -1);
    }
  };

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      // Hand the focus back to the trigger first: the browser's own Tab then
      // continues from there instead of restarting at the top of the document.
      close(true);
      return;
    }
    if (reachable.length === 0) return;
    const at = reachable.indexOf(active);
    const go = (next: number) => {
      e.preventDefault();
      setActive(reachable[(next + reachable.length) % reachable.length] ?? -1);
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? reachable.length - 1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(reachable.length - 1);
  };

  const triggerProps = {
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
  };
  const triggerNode = trigger ? (
    // Clone so the ARIA state lands on the caller's real button.
    isValidElement<Record<string, unknown>>(trigger) ? (
      cloneElement(trigger, triggerProps)
    ) : (
      trigger
    )
  ) : (
    <IconButton label={label} {...triggerProps}>
      <Ellipsis />
    </IconButton>
  );

  return (
    <>
      <span
        ref={anchor}
        className="inline-flex"
        onKeyDown={onTriggerKeyDown}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close(false);
          else openAt(-1);
        }}
      >
        {triggerNode}
      </span>
      {open && pos
        ? createPortal(
            <div
              ref={panel}
              id={menuId}
              role="menu"
              aria-label={label}
              tabIndex={-1}
              onKeyDown={onPanelKeyDown}
              className={cx(
                "menu-panel fixed min-w-44 rounded-menu border border-line bg-surface p-1 shadow-popover focus:outline-none",
                Z.popover,
                // A fixed width, not a max: the panel is `position: fixed` with
                // only `left` set, so shrink-to-fit gives it whatever is left
                // of the viewport — about nothing for a trigger on the right
                // edge, which squeezed a description into one word per line.
                items.some((it) => it.description) && "w-80 max-w-[calc(100vw-2rem)]",
              )}
              style={
                {
                  top: pos.top,
                  bottom: pos.bottom,
                  left: pos.left,
                  // Not `transform`: `.menu-panel` animates that property on
                  // open, and an animation owns it entirely while it plays.
                  // The alignment offset travels as a custom property the
                  // keyframes compose in (style.css).
                  "--menu-x": align === "end" ? "-100%" : "0",
                  transformOrigin: `${pos.up ? "bottom" : "top"} ${align === "end" ? "right" : "left"}`,
                } as React.CSSProperties
              }
              onClick={(e) => e.stopPropagation()}
            >
              {items.map((it, i) => {
                const Icon = it.icon;
                const cls = cx(
                  "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-sm transition-colors",
                  it.disabled
                    ? "pointer-events-none opacity-40"
                    : it.danger
                      ? "text-danger hover:bg-danger-soft"
                      : "text-fg hover:bg-surface-2",
                );
                const body = (
                  <>
                    {Icon ? (
                      <Icon
                        className={cx(
                          "size-4 shrink-0",
                          it.danger ? "" : "text-fg-faint",
                          // Two-line item: the icon aligns with the label, not
                          // with the middle of the block.
                          it.description && "mt-0.5 self-start",
                        )}
                      />
                    ) : null}
                    <span className="min-w-0">
                      {it.label}
                      {it.description ? (
                        <span className="mt-0.5 block text-xs font-normal text-fg-muted">
                          {it.description}
                        </span>
                      ) : null}
                    </span>
                  </>
                );
                return (
                  <div key={i} role="none">
                    {it.separator ? <div className="my-1 border-t border-line" role="none" /> : null}
                    {it.href ? (
                      <a
                        ref={(el) => {
                          itemRefs.current[i] = el;
                        }}
                        role="menuitem"
                        tabIndex={-1}
                        href={it.href}
                        target={it.href.startsWith("http") ? "_blank" : undefined}
                        rel="noreferrer"
                        className={cls}
                        onClick={() => close(true)}
                      >
                        {body}
                      </a>
                    ) : (
                      <button
                        ref={(el) => {
                          itemRefs.current[i] = el;
                        }}
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        className={cls}
                        disabled={it.disabled}
                        aria-disabled={it.disabled}
                        onClick={() => {
                          // Focus first, so a layer opened by the item captures
                          // the trigger as the element to come back to.
                          close(true);
                          it.onSelect?.();
                        }}
                      >
                        {body}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// --- Feedback ---

/** Centered spinner for a panel whose data is still loading. */
export function Spinner({ label, className = "py-12" }: { label?: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label ?? "Loading"}
      className={`flex flex-col items-center justify-center gap-2 ${className}`}
    >
      <Loader2 className="size-5 animate-spin text-fg-faint" />
      {label ? <p className="text-sm text-fg-muted">{label}</p> : null}
    </div>
  );
}

/** Placeholder block for content still loading (lists, cards). */
export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-md bg-surface-3 ${className}`} />;
}

/** Indeterminate progress bar (unknown duration work). */
export function Progress({ label }: { label: string }) {
  return (
    <div className="space-y-1.5" role="status" aria-label={label}>
      <p className="text-sm text-fg-muted">{label}</p>
      <div className="h-1 overflow-hidden rounded-full bg-surface-3">
        <div className="progress-bar h-full w-1/3 rounded-full bg-accent" />
      </div>
    </div>
  );
}

/**
 * A key cap, for the places that teach a shortcut (the command palette and
 * its sidebar trigger). `font-sans` on purpose: the mono face is reserved for
 * SHAs, repository names and the rest of what a student copies, and a key is
 * none of those — it is a picture of a key, so it takes the hairline, the
 * recessed surface and the caption weight the rest of the chrome uses.
 */
export function Kbd({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-flex items-center rounded-key border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] font-medium text-fg-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * The modifier key of a shortcut, spelled the way the reader's own keyboard
 * spells it. `userAgentData` first because `navigator.platform` is deprecated
 * and lies on some browsers; both are read defensively, since neither exists
 * under jsdom and a missing key hint must not take a test down with it.
 */
export function modKey(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  const agent = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = agent.userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

/** GitHub brand mark (brand icons were removed from lucide). */
export function GithubIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export type Tone = "green" | "amber" | "red" | "zinc" | "accent";

const TONES: Record<Tone, string> = {
  green: "bg-success-soft text-success",
  amber: "bg-warning-soft text-warning",
  red: "bg-danger-soft text-danger",
  zinc: "bg-surface-3 text-fg-muted",
  accent: "bg-accent-soft text-accent",
};

/** Status pill. A status is a badge; a plain count is text. */
export function Badge({
  tone,
  icon: Icon,
  children,
  className = "",
}: {
  tone: Tone;
  icon?: IconType;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-5.5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {Icon ? <Icon className="size-3" /> : null}
      {children}
    </span>
  );
}

/** Inline notice: neutral information, a warning, a failure or a success. */
export function Alert({
  tone = "neutral",
  icon: Icon,
  title,
  children,
  action,
}: {
  tone?: "neutral" | "warning" | "danger" | "success";
  icon?: IconType;
  title?: string;
  children?: ReactNode;
  /** Right-aligned action (a button or a link). */
  action?: ReactNode;
}) {
  const styles = {
    neutral: "border-line bg-surface-2 text-fg",
    warning: "border-warning/30 bg-warning-soft text-fg",
    danger: "border-danger/30 bg-danger-soft text-fg",
    success: "border-success/30 bg-success-soft text-fg",
  }[tone];
  const iconColor = {
    neutral: "text-fg-muted",
    warning: "text-warning",
    danger: "text-danger",
    success: "text-success",
  }[tone];
  return (
    <div role="status" className={cx("flex flex-wrap items-start gap-3 rounded-card border px-4 py-3 text-sm", styles)}>
      {Icon ? <Icon className={cx("mt-0.5 size-4 shrink-0", iconColor)} /> : null}
      <div className="min-w-0 flex-1 space-y-0.5">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="text-fg-muted">{children}</div> : null}
      </div>
      {/* The action takes a line of its own under `sm`: a long label inline
          squeezes the body to one word per line on a phone. From `sm` up it
          goes back beside the text, vertically centred. */}
      {action ? (
        <div className="flex basis-full items-center sm:basis-auto sm:shrink-0 sm:self-center">
          {action}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A query that failed: what could not be loaded, what the server said, and
 * the one thing that helps — asking again. `onRetry` is optional: some
 * failures (a one-shot list inside a form) have nothing to retry from here.
 */
export function QueryError({
  title,
  error,
  onRetry,
  retrying,
  fallback,
}: {
  title: string;
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  /**
   * Shown when the server sent no message of its own. Teacher surfaces keep
   * the English default; student surfaces pass their own `t("error.server")`.
   */
  fallback?: string;
}) {
  const t = useT();
  return (
    <Alert
      tone="danger"
      icon={AlertTriangle}
      title={title}
      action={
        onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
            <RefreshCw /> {t("common.retry")}
          </Button>
        ) : undefined
      }
    >
      {apiErrorMessage(error, fallback ?? "The server did not answer.")}
    </Alert>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className = "py-14",
}: {
  icon: IconType;
  title: string;
  children?: ReactNode;
  /** The one thing to do from here. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center gap-2 px-4 text-center", className)}>
      <div className="mb-1 rounded-full bg-surface-2 p-3">
        <Icon className="size-6 text-fg-muted" />
      </div>
      <p className="font-semibold">{title}</p>
      {children ? <p className="max-w-sm text-sm text-fg-muted">{children}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

// --- Surfaces and page structure ---

export function Card({
  children,
  className = "",
  interactive,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  /** Clickable surface: hairline darkens on hover, no movement. */
  interactive?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cx(
        "rounded-card border border-line bg-surface",
        interactive && "cursor-pointer transition-colors duration-150 hover:border-line-strong hover:bg-surface-2/40",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Title row of a page: one h1, an optional line under it, the actions right. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className = "",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1.5 text-[13px] text-fg-muted">{eyebrow}</div> : null}
        <h1 className="text-[28px] font-bold leading-tight tracking-[-0.02em]">{title}</h1>
        {description ? <div className="mt-1.5 text-sm text-fg-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Heading of a section inside a page or a card (h2 at 16 px). */
export function SectionHeading({
  icon: Icon,
  title,
  count,
  description,
  help,
  actions,
  className = "",
}: {
  icon?: IconType;
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  help?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      <div className="flex min-w-0 items-center gap-2">
        {Icon ? <Icon className="size-4 text-fg-faint" /> : null}
        <h2 className="text-base font-bold tracking-tight">{title}</h2>
        {count != null ? <span className="text-sm tabular-nums text-fg-faint">{count}</span> : null}
        {help ? <HelpIcon topic={help} /> : null}
      </div>
      {description ? <p className="basis-full text-sm text-fg-muted sm:basis-auto">{description}</p> : null}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Key figure: a small label over a large tabular number. */
export function Stat({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: IconType;
}) {
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        {Icon ? <Icon className="size-3.5 text-fg-faint" /> : null}
        {label}
      </p>
      <p className="mt-1 text-[22px] font-bold leading-none tabular-nums tracking-tight">{value}</p>
      {hint ? <p className="mt-1.5 text-xs text-fg-faint">{hint}</p> : null}
    </div>
  );
}

/** Width of the fade drawn over a scrollable edge of a tab strip. */
const TAB_FADE = "36px";

/**
 * Which edges of a horizontal scroller still hide content. One pixel of
 * tolerance absorbs the fractional scroll positions a zoomed or
 * high-density viewport produces. Pure: this is the part worth testing.
 */
export function scrollEdges(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): { left: boolean; right: boolean } {
  return {
    left: scrollLeft > 1,
    right: scrollLeft + clientWidth < scrollWidth - 1,
  };
}

/**
 * Text tabs with an ink underline; counts sit in `fg-faint`.
 * Roving tabindex: only the selected tab is in the Tab order, ArrowLeft and
 * ArrowRight move and select with wrap, Home and End jump to the ends.
 * Give `idPrefix` to wire the tabs to their panels: each tab then carries
 * `id="<prefix>-tab-<value>"` and `aria-controls="<prefix>-panel-<value>"`,
 * and the panel is expected to carry the matching id.
 *
 * On a narrow viewport the strip scrolls: the hidden side is faded out so the
 * fourth tab announces itself instead of just ending at the screen edge, and
 * scroll snapping stops a drag between two tabs.
 */
export function Tabs<V extends string>({
  value,
  onChange,
  items,
  className = "",
  idPrefix,
  label,
}: {
  value: V;
  onChange: (v: V) => void;
  items: { value: V; label: string; count?: number; icon?: IconType }[];
  className?: string;
  idPrefix?: string;
  /** Accessible name of the tablist when the surrounding heading is not enough. */
  label?: string;
}) {
  const refs = useRef<Partial<Record<V, HTMLButtonElement | null>>>({});
  const strip = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const selected = items.findIndex((it) => it.value === value);
  /**
   * Which tab holds the roving tabindex. A `value` matching no item (a hand
   * edited `?tab=` in the URL) used to leave every tab at `tabIndex={-1}`,
   * which took the whole strip out of the Tab order; the first tab stands in.
   */
  const roving = selected >= 0 ? selected : 0;
  // The fade is measured from the rendered strip, so it has to be recomputed
  // whenever the labels or the counts change, not only their number.
  const shape = items.map((it) => `${it.value}\u0000${it.label}\u0000${it.count ?? ""}`).join("|");
  // Layout effect: measuring after paint would show one unfaded frame.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const update = () =>
      setEdges((prev) => {
        const next = scrollEdges(el.scrollLeft, el.scrollWidth, el.clientWidth);
        // Same edges, same object: a fresh one would re-render on every scroll.
        return prev.left === next.left && prev.right === next.right ? prev : next;
      });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [shape]);
  // A mask, not an overlay: it fades whatever the strip holds without laying a
  // canvas-coloured rectangle over it, which would be wrong in dark mode.
  const mask =
    edges.left || edges.right
      ? `linear-gradient(to right, transparent 0, #000 ${edges.left ? TAB_FADE : "0px"}, #000 calc(100% - ${edges.right ? TAB_FADE : "0px"}), transparent 100%)`
      : undefined;
  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key) || items.length === 0) return;
    e.preventDefault();
    const i = roving;
    const next =
      e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : items.length - 1;
    const target = items[(next + items.length) % items.length];
    if (!target) return;
    onChange(target.value);
    refs.current[target.value]?.focus();
  };
  return (
    // The hairline lives on the wrapper, so the mask fades the tabs without
    // eating the border that separates them from the panel below.
    <div className={cx("border-b border-line", className)}>
      <div
        ref={strip}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex snap-x snap-proximity gap-1 overflow-x-auto"
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      >
        {items.map((it, i) => {
          const Icon = it.icon;
          const active = it.value === value;
          return (
            <button
              key={it.value}
              ref={(el) => {
                refs.current[it.value] = el;
              }}
              type="button"
              role="tab"
              id={idPrefix ? `${idPrefix}-tab-${it.value}` : undefined}
              aria-controls={idPrefix ? `${idPrefix}-panel-${it.value}` : undefined}
              aria-selected={active}
              tabIndex={i === roving ? 0 : -1}
              onClick={() => onChange(it.value)}
              className={cx(
                "relative -mb-px inline-flex h-10 shrink-0 snap-start items-center gap-1.5 px-3 text-sm font-medium transition-colors",
                active ? "text-fg" : "text-fg-muted hover:text-fg",
                active && "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-fg",
              )}
            >
              {Icon ? <Icon className="size-4" /> : null}
              {it.label}
              {it.count != null ? (
                <span className={cx("text-xs tabular-nums", active ? "text-fg-muted" : "text-fg-faint")}>
                  {it.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Form controls ---

/**
 * Field chrome, with no width and no height of its own. Tailwind resolves
 * conflicting utilities by their order in the generated stylesheet, not by
 * their order in the class attribute, so a `w-16` or an `h-8` written next to
 * this string was never guaranteed to win. Size comes from `inputSize` and
 * width from the caller, which both compose instead of fighting.
 */
export const inputClass =
  "rounded-field border border-line-strong bg-surface px-3 text-sm text-fg transition-colors placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50 disabled:hover:border-line-strong";

/** Control heights, aligned on the button scale of DESIGN.md (sm 28, md 34). */
export type InputSize = "sm" | "md";
export const inputSize: Record<InputSize, string> = {
  sm: "h-7",
  md: "h-8.5",
};

/**
 * Label above a control; used by Field, Select and Textarea.
 *
 * The <label> covers the text only. A <label> wrapping the help "?" button
 * makes that BUTTON its labelled control, which leaves the real input with no
 * accessible name and turns a click on the label into a click on help; so the
 * row is a div and the label points at the control through `htmlFor`.
 */
export function FieldLabel({
  children,
  htmlFor,
  help,
  hint,
}: {
  children: ReactNode;
  /** Id of the control this labels; omit for a label with no control. */
  htmlFor?: string;
  help?: string;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1 text-[13px] font-medium text-fg">
      <label htmlFor={htmlFor}>{children}</label>
      {help ? <HelpIcon topic={help} /> : null}
      {hint ? <span className="ml-auto font-normal text-fg-faint">{hint}</span> : null}
    </div>
  );
}

export function Field({
  label,
  help,
  hint,
  fullWidth,
  size = "md",
  width = "w-52",
  className = "",
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
  label: string;
  help?: string;
  /** Right-aligned note on the label line. */
  hint?: ReactNode;
  /** Stretch label and input to the parent width (grid cells). */
  fullWidth?: boolean;
  /** Control height: `sm` 28 px for dense rows, `md` 34 px by default. */
  size?: InputSize;
  /**
   * Width utility, on the wrapper so the label shares it. It lives here and
   * not in `className` because two width utilities on the same element are
   * resolved by the stylesheet order, not by the caller's intent.
   */
  width?: string;
}) {
  const auto = useId();
  const id = props.id ?? auto;
  return (
    <div className={cx("flex flex-col gap-1.5", fullWidth ? "w-full" : width)}>
      <FieldLabel htmlFor={id} help={help} hint={hint}>
        {label}
      </FieldLabel>
      <input {...props} id={id} className={cx(inputClass, inputSize[size], "w-full", className)} />
    </div>
  );
}

/** Native select with the field chrome and a chevron. */
export function Select({
  label,
  help,
  size = "md",
  width,
  className = "",
  children,
  ...props
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  label?: string;
  help?: string;
  /** Control height: `sm` 28 px for dense rows, `md` 34 px by default. */
  size?: InputSize;
  /** Width utility on the wrapper; without it the select sizes to its parent. */
  width?: string;
}) {
  const auto = useId();
  const id = props.id ?? auto;
  const control = (
    <span className={cx("relative block", width)}>
      <select
        {...props}
        id={id}
        className={cx(inputClass, inputSize[size], "w-full appearance-none pr-8", className)}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-faint" />
    </span>
  );
  if (!label) return control;
  // The width sits on the control; the label column takes it from there.
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={id} help={help}>
        {label}
      </FieldLabel>
      {control}
    </div>
  );
}

export function Textarea({
  label,
  help,
  className = "",
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; help?: string }) {
  // No `size` prop here on purpose: a textarea's height is its content, not
  // one of the two control heights.
  const auto = useId();
  const id = props.id ?? auto;
  const control = (
    <textarea
      {...props}
      id={id}
      className={cx(inputClass, "min-h-24 w-full py-2 leading-relaxed", className)}
    />
  );
  if (!label) return control;
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={id} help={help}>
        {label}
      </FieldLabel>
      {control}
    </div>
  );
}

/** Pill search box; keeps its own width so toolbars stay aligned. */
export function SearchInput({
  className = "w-56",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cx("relative block", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-faint" />
      <input
        type="search"
        {...props}
        className={cx(inputClass, inputSize.md, "w-full rounded-full pl-9 pr-3")}
      />
    </label>
  );
}

/** Checkbox with the accent tick, label on the right. */
export function Checkbox({
  label,
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cx("inline-flex cursor-pointer items-center gap-2.5 text-sm", props.disabled && "opacity-50", className)}>
      <span className="relative inline-flex size-4 shrink-0">
        <input type="checkbox" {...props} className="peer size-4 appearance-none rounded-[5px] border border-line-strong bg-surface transition-colors checked:border-accent checked:bg-accent" />
        <Check className="pointer-events-none absolute inset-0 m-auto size-3 text-on-fill opacity-0 peer-checked:opacity-100" strokeWidth={3} />
      </span>
      {label}
    </label>
  );
}

/** On/off switch (settings rows). Accent when on: it is a state, not an action. */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-150 disabled:opacity-50",
        checked ? "bg-success" : "bg-line-strong",
      )}
    >
      <span
        className={cx(
          "absolute left-0.5 size-5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-150 ease-out-emphasized",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

/**
 * Segmented control for 2–3 mutually exclusive choices: the selected chip is
 * raised (surface + hairline) — selection is structure, never color, the
 * accent stays reserved for primary actions. Native radios underneath
 * (sr-only) keep it a keyboard-accessible radiogroup.
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  disabled,
  size = "md",
}: {
  /** Groups the native radios (one form can hold several groups). */
  name: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="radiogroup"
      className={cx(
        "inline-flex shrink-0 gap-0.5 rounded-full bg-surface-3 p-0.75",
        disabled && "opacity-60",
      )}
    >
      {options.map((o) => (
        <label
          key={o.value}
          className={cx(
            "inline-flex items-center justify-center rounded-full px-3 font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent/50",
            size === "sm" ? "h-6 text-xs" : "h-7 text-[13px]",
            value === o.value
              ? "bg-surface text-fg ring-1 ring-line-strong/70"
              : cx("text-fg-muted", !disabled && "cursor-pointer hover:text-fg"),
          )}
        >
          <input
            type="radio"
            name={name}
            className="sr-only"
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            disabled={disabled}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/**
 * Settings row: label + a description of the CURRENT choice on the left
 * (one dynamic line, not one per option), the control on the right.
 */
export function SettingRow({
  title,
  desc,
  help,
  children,
  className = "",
}: {
  title: ReactNode;
  desc?: ReactNode;
  help?: string;
  children?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    // The row wraps rather than squeezing: the text keeps a 14 rem floor, so a
    // wide control (segmented, select) drops to its own line on a phone while a
    // switch, which costs 40 px, stays on the label's line at any width.
    <div
      className={cx(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-56">
        <span id={id} className="flex items-center gap-1 text-sm font-medium text-fg">
          {title}
          {help ? <HelpIcon topic={help} /> : null}
        </span>
        {desc ? <p className="mt-0.5 text-[13px] text-fg-muted">{desc}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
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
    <IconButton size="sm" label={label} onClick={() => shift(delta)} className={className}>
      {delta < 0 ? <ChevronLeft /> : <ChevronRight />}
    </IconButton>
  );

  return (
    <div className="flex justify-center gap-8" onMouseLeave={() => setHover("")}>
      {[0, 1].map((k) => {
        const y = view.y + Math.floor((view.m + k) / 12);
        const m = (view.m + k) % 12;
        return (
          <div key={k} className={k === 1 ? "hidden sm:block" : ""}>
            <div className="mb-1 flex items-center justify-between">
              {k === 0 ? nav(-1, "Previous month") : <span className="size-7" />}
              <span className="text-sm font-semibold">
                {MONTH_NAMES[m]} {y}
              </span>
              {/* Right arrow lives on the last visible month (first on mobile). */}
              {k === 0 ? nav(1, "Next month", "sm:invisible") : nav(1, "Next month")}
            </div>
            <div className="grid grid-cols-7 text-center">
              {WEEKDAYS.map((d) => (
                <span key={d} className="pb-1 text-xs font-medium text-fg-faint">
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
                    className={cx(
                      "h-8 w-8 text-[13px] tabular-nums transition-colors",
                      (mode === "range" && day === start) || day === end
                        ? cx(
                            "bg-accent font-semibold text-on-fill",
                            mode === "single" || !bandEnd || start === bandEnd
                              ? "rounded-full"
                              : day === start
                                ? "rounded-l-full"
                                : "rounded-r-full",
                          )
                        : bandEnd !== "" && day > start && day < bandEnd && mode === "range"
                          ? "bg-accent-soft text-fg"
                          : day === bandEnd && picking
                            ? "rounded-r-full bg-accent/70 text-on-fill"
                            : cx(
                                "rounded-full hover:bg-surface-3",
                                day === today && "font-bold text-accent",
                              ),
                    )}
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
