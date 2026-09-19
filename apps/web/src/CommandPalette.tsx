import { Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  buildCommands,
  capClassrooms,
  filterCommands,
  groupCommands,
  type Command,
  type CommandContext,
} from "./commands";
import { cx, Kbd, useLayer, useScrollLock, Z } from "./ui";

/*
 * Ctrl/⌘+K: one field that reaches every page, every classroom, the theme,
 * the language and every help topic. Four decisions, per DESIGN.md:
 *
 * - Type: the 16 px search row over the 14 px rows over the 11 px group
 *   labels — the reader's eye lands on what they are typing, then on the list.
 * - Color: the active row is the single accent use of the screen, the same
 *   `accent-soft` chip a selected sidebar item wears.
 * - Space: 2 px between rows inside a group (the sidebar's own `space-y-0.5`),
 *   12 px above each group label.
 * - Finish: hairlines between the three bands (search, list, footer); the
 *   panel floats, so it is the one thing here allowed a shadow.
 */

export function CommandPalette({
  open,
  onClose,
  ...ctx
}: { open: boolean; onClose: () => void } & CommandContext) {
  const { t } = ctx;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (index: number) => `${uid}-option-${index}`;

  // Escape, the Tab trap and the focus restore, from the shared contract.
  useLayer(panel, onClose, { enabled: open });
  // The panel is anchored at 12 dvh of a viewport that must not move under
  // it. Unconditional: the component is mounted only while open, and the hook
  // has to run before the `if (!open)` below to keep the hook order stable.
  useScrollLock();

  // Rebuilt on every render rather than memoized: a few dozen objects, each
  // closing over the current context, against a dependency array that would
  // have to list every field of that context to stay honest.
  const groups = groupCommands(capClassrooms(filterCommands(query, buildCommands(ctx)), query));
  // The list the arrows walk is the one the eye walks: the groups in their
  // fixed order, not the score order the filter returned.
  const flat = groups.flatMap((g) => g.commands);
  const position = new Map(flat.map((c, i) => [c.id, i]));

  // Most screen readers ignore an `aria-live` region that arrives with its
  // text already in it, and the whole region is inserted in the same commit as
  // its first count. Mounting it empty and filling it one paint later makes
  // that first count a change the reader is told about.
  const [announced, setAnnounced] = useState("");
  const count = t(flat.length === 1 ? "palette.result" : "palette.results", { n: flat.length });
  useEffect(() => setAnnounced(count), [count]);

  // Keeps the active row in view when the arrows leave the visible slice.
  // `scrollIntoView` is not implemented under jsdom, hence the optional call.
  useEffect(() => {
    document.getElementById(`${uid}-option-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, uid]);

  if (!open) return null;

  const run = (command: Command) => {
    command.run();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = flat.length;
    // Every branch prevents the default: the arrows must not move the caret
    // inside the field, and Enter must not submit anything.
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (n) setActive((i) => (i + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActive((i) => (i - 1 + n) % n);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, n - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const command = flat[active];
      if (command) run(command);
    }
  };

  return createPortal(
    <div
      // A navigation layer, not a form layer: it holds nothing the user wrote
      // beyond a query they can retype in a second, so insisting on Escape
      // here would be friction for nothing.
      onClick={onClose}
      className={`layer-backdrop fixed inset-0 ${Z.modal} flex items-start justify-center bg-fg/30 p-4 pt-[12vh] backdrop-blur-[2px]`}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title")}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="dialog-panel w-full max-w-155 rounded-sheet border border-line bg-surface shadow-overlay focus:outline-none"
      >
        <div className="flex h-13 items-center gap-2.5 border-b border-line px-4">
          <Search className="size-4 shrink-0 text-fg-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // One more letter changes the list under the finger already on
              // Enter; the selection goes back to the best match rather than
              // staying on a row that now means something else.
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.title")}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={flat.length ? optionId(active) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            // No field chrome: the whole top band IS the field, and a second
            // border inside a bordered panel is noise. The focus ring goes
            // with it — the panel is the focus indicator here, and the caret
            // is in this input from the moment the palette opens until it
            // closes (the rows never take the focus).
            className="min-w-0 flex-1 bg-transparent text-base text-fg placeholder:text-fg-faint focus:outline-none"
          />
        </div>

        {/* `dvh` and not `vh`: a soft keyboard shrinks the dynamic viewport, and
            a cap read from the static one would put the last rows under it. */}
        <div className="max-h-[60dvh] overflow-y-auto p-2">
          <div id={listId} role="listbox" aria-label={t("palette.title")}>
            {groups.map((group) => {
              const headingId = `${uid}-group-${group.group}`;
              return (
                <div key={group.group} role="group" aria-labelledby={headingId}>
                  {/* Exactly the sidebar's section label: the palette lists
                      the same things and must not invent a second voice. */}
                  <p
                    id={headingId}
                    className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-fg-faint"
                  >
                    {t(`palette.group.${group.group}`)}
                  </p>
                  <div className="space-y-0.5">
                    {group.commands.map((command) => {
                      const index = position.get(command.id) ?? 0;
                      const isActive = index === active;
                      const Icon = command.icon;
                      return (
                        <div
                          key={command.id}
                          id={optionId(index)}
                          role="option"
                          aria-selected={isActive}
                          // Virtual focus: the rows are not in the Tab order,
                          // `aria-activedescendant` on the input carries the
                          // selection instead.
                          // `mousemove` and not `mouseenter`: an arrow key can
                          // scroll a row under a motionless cursor, and the
                          // mouse would then steal back a selection the reader
                          // moved with the keyboard.
                          onMouseMove={() => setActive(index)}
                          onClick={() => run(command)}
                          className={cx(
                            "flex cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-sm",
                            isActive
                              ? "bg-accent-soft font-semibold text-accent"
                              : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                          )}
                        >
                          <Icon className="size-4 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{command.label}</span>
                          {command.hint ? (
                            // The hint inherits the accent on the active row,
                            // so the row reads as one object and not as a
                            // label with a leftover caption. Hidden on a
                            // phone: the identity of the row must never lose
                            // width to its caption, and the org login is a
                            // desktop refinement.
                            <span
                              className={cx(
                                "hidden shrink-0 text-xs sm:inline",
                                !isActive && "text-fg-faint",
                              )}
                            >
                              {command.hint}
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {flat.length === 0 ? (
            // Deliberately not an <EmptyState>: its circle, title and action
            // are a page-sized apparatus, and there is no action to offer —
            // the way out is one backspace away.
            <p className="py-8 text-center text-[13px] text-fg-muted">
              {t("palette.noResult", { query })}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-[11px] text-fg-faint">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t("palette.hint.move")}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd>
            {t("palette.hint.run")}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd>
            {t("palette.hint.close")}
          </span>
        </div>

        {/* The count is the only feedback a screen reader gets while typing:
            the rows come and go without any of them being focused. */}
        <div aria-live="polite" className="sr-only">
          {announced}
        </div>
      </div>
    </div>,
    document.body,
  );
}
