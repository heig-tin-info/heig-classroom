import { ChevronRight, EyeOff } from "lucide-react";
import { useState } from "react";

import type { JournalNavNode } from "@hgc/contracts";

import { cx } from "../ui";

/**
 * The navigation of a journal: the repository's own tree, one level of
 * indentation per directory.
 *
 * This is the ONE accent use of the journal screen — the page being read wears
 * `accent-soft` and `text-accent`, exactly like the current classroom in the
 * sidebar. Everything else is `fg` and `fg-muted`, so the squint test passes:
 * strip the red and the current page is still the one that is not indented
 * away and still the only row with a filled background.
 *
 * A section with no landing page (`pagePath: null`) is a heading that opens
 * nothing: it toggles its children instead of navigating, because a row that
 * looks clickable and does nothing is worse than a row that says what it does.
 */
export function JournalNav({
  nodes,
  current,
  hiddenPaths,
  onOpen,
  depth = 0,
}: {
  nodes: JournalNavNode[];
  current: string;
  /** Pages the students do not see (staff only); empty for a student. */
  hiddenPaths: ReadonlySet<string>;
  onOpen: (pagePath: string) => void;
  depth?: number;
}) {
  return (
    <ul className={cx("space-y-0.5", depth > 0 && "mt-0.5 ml-3 border-l border-line pl-2")}>
      {nodes.map((node) => (
        <JournalNavItem
          key={node.path}
          node={node}
          current={current}
          hiddenPaths={hiddenPaths}
          onOpen={onOpen}
          depth={depth}
        />
      ))}
    </ul>
  );
}

function JournalNavItem({
  node,
  current,
  hiddenPaths,
  onOpen,
  depth,
}: {
  node: JournalNavNode;
  current: string;
  hiddenPaths: ReadonlySet<string>;
  onOpen: (pagePath: string) => void;
  depth: number;
}) {
  const holdsCurrent = current.startsWith(`${node.path}/`) || current === node.pagePath;
  const [open, setOpen] = useState(holdsCurrent || depth === 0);
  const active = node.pagePath !== null && node.pagePath === current;
  const hidden = node.pagePath !== null && hiddenPaths.has(node.pagePath);
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <div className="flex items-center gap-0.5">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? `Collapse ${node.title}` : `Expand ${node.title}`}
            className="shrink-0 rounded-full p-1 text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <ChevronRight className={cx("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        {node.pagePath !== null ? (
          <button
            type="button"
            onClick={() => onOpen(node.pagePath!)}
            aria-current={active ? "page" : undefined}
            className={cx(
              "flex min-w-0 flex-1 items-center gap-1.5 rounded-full px-2.5 py-1 text-left text-[13px] transition-colors",
              active
                ? "bg-accent-soft font-medium text-accent"
                : "text-fg-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{node.title}</span>
            {hidden ? <EyeOff className="size-3.5 shrink-0 text-fg-faint" aria-hidden /> : null}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="min-w-0 flex-1 truncate px-2.5 py-1 text-left text-[13px] font-medium text-fg"
          >
            {node.title}
          </button>
        )}
      </div>
      {hasChildren && open ? (
        <JournalNav
          nodes={node.children}
          current={current}
          hiddenPaths={hiddenPaths}
          onOpen={onOpen}
          depth={depth + 1}
        />
      ) : null}
    </li>
  );
}
