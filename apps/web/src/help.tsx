import { CircleHelp, X } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";

/**
 * Contextual help: small "?" icons on the main components open a collapsible
 * drawer on the right with the description of that component. The drawer is
 * hidden unless summoned.
 */
interface HelpEntry {
  title: string;
  body: ReactNode;
}

const HELP: Record<string, HelpEntry> = {
  classrooms: {
    title: "My classrooms",
    body: (
      <>
        <p>
          A classroom binds a GitHub organization to a student roster. Switch between the card
          view, a sortable list and the timeline with the buttons on the right; the search field
          filters as you type (fuzzy match on name and organization).
        </p>
        <p>
          Click a card to open the classroom; click the organization name to open it on GitHub.
          Hovering the student badges shows who is enrolled and who has already claimed their
          seat.
        </p>
      </>
    ),
  },
  "new-classroom": {
    title: "New classroom",
    body: (
      <>
        <p>
          Pick one of the organizations where the GitHub App is already installed, or type
          another organization name. The organization must exist on GitHub; you will be able to
          install the App from the classroom page afterwards.
        </p>
      </>
    ),
  },
  timeline: {
    title: "Timeline",
    body: (
      <>
        <p>
          Each row is a classroom, each bar an assignment spanning from its start date to its
          deadline. The red line marks now. Click a bar to open the assignment. Draft
          assignments are hollow, published ones filled, locked ones dimmed.
        </p>
      </>
    ),
  },
  assignments: {
    title: "Assignments",
    body: (
      <>
        <p>
          An assignment distributes a source repository to every student as an individual
          private repository. Publish it to let students accept; the deadline locks
          repositories (or pushes a deadline marker) automatically, with a grace period for
          runs still in flight.
        </p>
      </>
    ),
  },
  roster: {
    title: "Roster",
    body: (
      <>
        <p>
          The class list. Students claim their seat automatically at their first sign-in with a
          matching e-mail. The envelope icon opens your mail client. Rows can be edited, the
          GitHub link revoked, or the student removed with the icons on the right.
        </p>
      </>
    ),
  },
  "import-roster": {
    title: "Import roster",
    body: (
      <>
        <p>
          Drop an Excel or CSV export. Name, first name and e-mail columns are detected
          permissively (French headers work). You can also add students one by one or paste
          CSV lines.
        </p>
      </>
    ),
  },
  "assignment-detail": {
    title: "Assignment view",
    body: (
      <>
        <p>
          One row per enrolled student: acceptance, last commit, CI checks and the indicative
          grade extracted from the GRADE annotation. Click the history icon for every captured
          run. The table is sortable and the search field filters students.
        </p>
        <p>
          When the source repository moves ahead, a banner offers to open sync pull requests on
          all student repositories; students merge them at their own pace.
        </p>
      </>
    ),
  },
  "scheduled-tasks": {
    title: "Scheduled tasks",
    body: (
      <>
        <p>
          Background reconciliation with GitHub. Webhooks handle everything in real time; these
          tasks are the safety net that catches lost deliveries. Intervals are editable, tasks
          can be paused, and Run now triggers one immediately.
        </p>
      </>
    ),
  },
  notifications: {
    title: "Notifications",
    body: (
      <>
        <p>
          Real-time toasts appear at the bottom left when something happens in your classrooms:
          a student joins, accepts an assignment, pushes, a grade is captured. Toggle each kind
          here; the setting is stored in this browser.
        </p>
      </>
    ),
  },
};

const HelpContext = createContext<{ open: (key: string) => void }>({ open: () => {} });

export function HelpIcon({ topic, className = "" }: { topic: string; className?: string }) {
  const { open } = useContext(HelpContext);
  if (!HELP[topic]) return null;
  return (
    <button
      aria-label="Help"
      title="Help"
      onClick={(e) => {
        e.stopPropagation();
        open(topic);
      }}
      className={`rounded-full p-0.5 text-zinc-300 transition-colors hover:text-accent dark:text-zinc-600 dark:hover:text-accent ${className}`}
    >
      <CircleHelp className="size-3.5" />
    </button>
  );
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const [topic, setTopic] = useState<string | null>(null);
  const entry = topic ? HELP[topic] : null;
  return (
    <HelpContext.Provider value={{ open: setTopic }}>
      {children}
      {/* Right drawer, collapsed (absent) unless a topic is open. */}
      <div
        className={`fixed inset-y-0 right-0 z-40 w-80 transform bg-white shadow-[-8px_0_32px_rgb(0_0_0/0.12)] transition-transform duration-200 dark:bg-zinc-900 dark:shadow-[-8px_0_32px_rgb(0_0_0/0.5)] ${
          entry ? "translate-x-0" : "translate-x-full"
        }`}
        role="complementary"
        aria-label="Help"
      >
        {entry ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <CircleHelp className="size-4 text-accent" />
              <h2 className="font-medium">{entry.title}</h2>
              <span className="flex-1" />
              <button
                aria-label="Close help"
                onClick={() => setTopic(null)}
                className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="space-y-3 overflow-y-auto px-4 py-4 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
              {entry.body}
            </div>
          </div>
        ) : null}
      </div>
    </HelpContext.Provider>
  );
}
