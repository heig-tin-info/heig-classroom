import { useCallback, useEffect, useRef, type MouseEvent } from "react";

import { parsePath, type Route } from "../router";

/**
 * A rendered journal page (issue #45).
 *
 * The HTML comes from the server, already rendered and safe by construction:
 * the ingestion escapes raw HTML instead of passing it through, so there is no
 * sanitiser here and no markdown library in this bundle at all. That is the
 * whole point of rendering at ingestion — a student downloads a page, not a
 * parser.
 *
 * The only behaviour this component adds is click interception. Links between
 * pages are RELATIVE in the stored HTML (so the same page reads correctly under
 * any classroom, and on github.com), which means the browser has already
 * resolved them into a real pathname by the time we see the click: the router
 * only has to parse it. External links carry `target="_blank"` from the
 * renderer and are left alone, as are in-page anchors, which the browser
 * scrolls to on its own.
 */
export function JournalBody({
  html,
  navigate,
  className = "",
}: {
  html: string;
  navigate: (r: Route) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      // Let the browser have the clicks that mean "not here": a new tab, a
      // download, a middle click.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement).closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#") || anchor.target === "_blank") return;
      if (anchor.origin !== window.location.origin) return;
      const route = parsePath(anchor.pathname);
      if (route.view !== "journal") return; // an asset, a handout: let it open
      event.preventDefault();
      navigate(route);
    },
    [navigate],
  );

  // A deep link carrying an anchor (`…/020-pointers.md#the-stack`) arrives
  // before the body exists, so the browser has nothing to scroll to: do it once
  // the page is in the DOM.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    ref.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: "start" });
  }, [html]);

  return (
    <div
      ref={ref}
      className={`md-body ${className}`}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
