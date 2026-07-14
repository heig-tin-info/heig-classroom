import { CircleHelp, X } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { useI18n } from "./i18n";
import { Markdown } from "./markdown";
import { Tip, Z } from "./ui";

/**
 * Contextual help: small "?" icons on the main components open a collapsible
 * drawer on the right with the description of that component. Content lives in
 * editable Markdown files under `src/help/*.md`, loaded at build time; a
 * `<topic>.<locale>.md` variant overrides the English default when present.
 * The drawer is hidden unless summoned and closes on any outside click.
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

export function HelpIcon({ topic, className = "" }: { topic: string; className?: string }) {
  const { open } = useContext(HelpContext);
  return (
    <Tip label="Help">
      <button
        aria-label="Help"
        onClick={(e) => {
          e.stopPropagation();
          open(topic);
        }}
        className={`rounded-full p-0.5 text-zinc-300 transition-colors hover:text-accent dark:text-zinc-600 dark:hover:text-accent ${className}`}
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

  // Any outside click (or Escape) collapses the drawer.
  useEffect(() => {
    if (!topic) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTopic(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [topic]);

  return (
    <HelpContext.Provider value={{ open: setTopic }}>
      {children}
      {/* Transparent overlay to capture the outside click while open. Above
          the modals (z-50): help opened from a dialog must not slide UNDER
          its backdrop — and closing the help must not close the dialog. */}
      {topic ? <div className={`fixed inset-0 ${Z.helpBackdrop}`} onClick={() => setTopic(null)} /> : null}
      <div
        className={`fixed inset-y-0 right-0 ${Z.help} w-80 transform bg-white shadow-[-8px_0_32px_rgb(0_0_0/0.12)] transition-transform duration-200 dark:bg-zinc-900 dark:shadow-[-8px_0_32px_rgb(0_0_0/0.5)] ${
          source ? "translate-x-0" : "translate-x-full"
        }`}
        role="complementary"
        aria-label={t("help.title")}
        onClick={(e) => e.stopPropagation()}
      >
        {source ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <CircleHelp className="size-4 text-accent" />
              <h2 className="font-medium">{t("help.title")}</h2>
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
              <Markdown source={source} />
            </div>
          </div>
        ) : null}
      </div>
    </HelpContext.Provider>
  );
}
