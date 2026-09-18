import { CircleHelp, X } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { useI18n } from "./i18n";
import { Markdown } from "./markdown";
import { Tip, Z } from "./ui";

/**
 * Contextual help: small "?" icons on the main components open a drawer on
 * the right with the description of that component. Content lives in
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
          the dialogs (z-50): help opened from a dialog must not slide UNDER
          its backdrop — and closing the help must not close the dialog. */}
      {topic ? <div className={`fixed inset-0 ${Z.helpBackdrop}`} onClick={() => setTopic(null)} /> : null}
      <div
        className={`fixed inset-y-0 right-0 ${Z.help} w-[340px] max-w-full transform border-l border-line bg-surface shadow-sheet transition-transform duration-200 ease-out-emphasized ${
          source ? "translate-x-0" : "translate-x-full"
        }`}
        role="complementary"
        aria-label={t("help.title")}
        onClick={(e) => e.stopPropagation()}
      >
        {source ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-line px-5 py-4">
              <CircleHelp className="size-4 text-accent" />
              <h2 className="text-[15px] font-bold tracking-tight">{t("help.title")}</h2>
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
