import { CircleHelp, X } from "lucide-react";
import { createContext, useContext, useId, useRef, useState, type ReactNode } from "react";

import { useI18n } from "./i18n";
import { Markdown } from "./markdown";
import { humanize, Tip, useLayer, Z } from "./ui";

/**
 * Contextual help: small "?" icons on the main components open a drawer on
 * the right with the description of that component. Content lives in
 * editable Markdown files under `src/help/*.md`, loaded at build time; a
 * `<topic>.<locale>.md` variant overrides the English default when present.
 * The drawer is hidden unless summoned and closes on any outside click, on
 * Escape or on its own close button. While open it is a modal dialog: the
 * focus moves into it, Tab cycles inside it, and closing it gives the focus
 * back to the "?" icon that summoned it — including when it slides over a
 * dialog, which stays open underneath.
 */
const SOURCES = import.meta.glob("./help/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function helpSource(topic: string, locale: string): string | null {
  return (
    SOURCES[`./help/${topic}.${locale}.md`] ?? SOURCES[`./help/${topic}.md`] ?? null
  );
}

const HelpContext = createContext<{ open: (key: string) => void }>({ open: () => {} });

/**
 * The help drawer, for a surface that opens a topic without a "?" icon of its
 * own (the command palette). Outside a provider it is a no-op, like the icon.
 */
export function useHelp(): { open: (topic: string) => void } {
  return useContext(HelpContext);
}

/** `./help/<topic>.md` and `./help/<topic>.<locale>.md` both name `<topic>`. */
const SOURCE_PATH = /^\.\/help\/([^.]+)(?:\.[a-z]{2})?\.md$/;

/** First `# ` heading of a Markdown source, which is how every topic opens. */
function firstHeading(source: string): string | null {
  const m = /^#\s+(.+)$/m.exec(source);
  return m ? m[1]!.trim() : null;
}

/**
 * The topics a reader without the teacher UI can reach. The rule: a topic
 * belongs to a role's palette when that role can reach the `HelpIcon` that
 * opens it. These two are the only ones hosted by a student surface —
 * `student-home` on `StudentHome`, `notifications` on `SettingsPage`; every
 * other source lives on `AssignmentForm`, `ClassroomView`, `TeacherHome`,
 * `AssignmentsCard`, `AssignmentDetail`, `RosterImport`, `ScheduledTasks` or
 * `Timeline`, which a student never opens.
 *
 * Adding a `HelpIcon` to a student screen means adding its topic here, or the
 * palette will keep the page's own help out of the one search field that was
 * supposed to reach everything.
 */
const STUDENT_TOPICS = ["student-home", "notifications"];

/**
 * Every help topic with its title, for the command palette. The title is read
 * from the source itself rather than kept in a second list beside it: a topic
 * added as a file would otherwise be a topic the palette never offers.
 * Sorted by title, because that is the only order the reader can see.
 *
 * `teacherUi` filters the list down to `STUDENT_TOPICS`: the "?" icons never
 * leaked the teacher documentation because they live on teacher screens, and
 * the palette must not be the one surface that does.
 */
export function helpTopics(
  locale: string,
  teacherUi = true,
): { topic: string; title: string }[] {
  const topics = new Set<string>();
  for (const path of Object.keys(SOURCES)) {
    const m = SOURCE_PATH.exec(path);
    if (m?.[1] && (teacherUi || STUDENT_TOPICS.includes(m[1]))) topics.add(m[1]);
  }
  return [...topics]
    .map((topic) => {
      // `helpSource` already falls back to the English file; the humanized
      // slug is the last resort, for a source with no heading at all.
      const source = helpSource(topic, locale);
      return { topic, title: (source && firstHeading(source)) || humanize(topic) };
    })
    .sort((a, b) => a.title.localeCompare(b.title, locale));
}

export function HelpIcon({ topic, className = "" }: { topic: string; className?: string }) {
  const { open } = useContext(HelpContext);
  return (
    <Tip label="Help">
      <button
        type="button"
        aria-label="Help"
        onClick={(e) => {
          e.stopPropagation();
          open(topic);
        }}
        className={`rounded-full p-0.5 text-fg-faint transition-colors hover:text-accent ${className}`}
      >
        <CircleHelp className="size-3.5" />
      </button>
    </Tip>
  );
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n();
  const [topic, setTopic] = useState<string | null>(null);
  const source = topic ? helpSource(topic, locale) : null;
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayer(panel, () => setTopic(null), { enabled: topic != null });

  return (
    <HelpContext.Provider value={{ open: setTopic }}>
      {children}
      {/* Transparent overlay to capture the outside click while open. Above
          the dialogs (z-50): help opened from a dialog must not slide UNDER
          its backdrop — and closing the help must not close the dialog. */}
      {topic ? <div className={`fixed inset-0 ${Z.helpBackdrop}`} onClick={() => setTopic(null)} /> : null}
      <div
        ref={panel}
        className={`fixed inset-y-0 right-0 ${Z.help} w-85 max-w-full transform border-l border-line bg-surface shadow-sheet transition-transform duration-200 ease-out-emphasized focus:outline-none ${
          source ? "translate-x-0" : "translate-x-full"
        }`}
        {...(source
          ? { role: "dialog" as const, "aria-modal": true, "aria-labelledby": titleId }
          : // Closed: the panel is still in the DOM for the slide animation, so
            // it must be neither a dialog nor reachable.
            { "aria-hidden": true })}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {source ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-line px-5 py-4">
              <CircleHelp className="size-4 text-accent" />
              <h2 id={titleId} className="text-[15px] font-bold tracking-tight">
                {t("help.title")}
              </h2>
              <span className="flex-1" />
              <button
                type="button"
                aria-label="Close help"
                onClick={() => setTopic(null)}
                className="rounded-full p-1.5 text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="space-y-3 overflow-y-auto px-5 py-4 text-sm leading-relaxed text-fg-muted">
              <Markdown source={source} />
            </div>
          </div>
        ) : null}
      </div>
    </HelpContext.Provider>
  );
}
