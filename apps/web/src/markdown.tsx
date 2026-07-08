import type { ReactNode } from "react";

/**
 * Minimal Markdown renderer for the help panels: headings, paragraphs, bullet
 * lists, bold, inline code and links. Small and dependency-free (the same
 * reasoning as the hand-rolled timeline); the input is trusted content we
 * author, not user input. Rendered to React elements, never raw HTML.
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      nodes.push(<strong key={`${keyBase}-${i}`}>{m[2]}</strong>);
    } else if (m[4] !== undefined) {
      nodes.push(
        <code
          key={`${keyBase}-${i}`}
          className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800"
        >
          {m[4]}
        </code>,
      );
    } else if (m[6] !== undefined) {
      nodes.push(
        <a
          key={`${keyBase}-${i}`}
          href={m[7]}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          {m[6]}
        </a>,
      );
    }
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ source }: { source: string }) {
  const blocks = source.trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, bi) => {
        const trimmed = block.trim();
        if (trimmed.startsWith("## ")) {
          return (
            <h3 key={bi} className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {inline(trimmed.slice(3), `h${bi}`)}
            </h3>
          );
        }
        if (trimmed.startsWith("# ")) {
          // The drawer already shows the title; skip a leading h1.
          return null;
        }
        if (/^[-*] /.test(trimmed)) {
          const items = trimmed.split("\n").map((l) => l.replace(/^[-*] /, ""));
          return (
            <ul key={bi} className="list-disc space-y-1 pl-5">
              {items.map((it, ii) => (
                <li key={ii}>{inline(it, `l${bi}-${ii}`)}</li>
              ))}
            </ul>
          );
        }
        return <p key={bi}>{inline(trimmed.replace(/\n/g, " "), `p${bi}`)}</p>;
      })}
    </>
  );
}
