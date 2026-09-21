import { useCallback, useEffect, useState } from "react";

/**
 * Minimal history-backed router: every in-app navigation pushes a real URL,
 * so the browser (and mouse) back/forward buttons work, and deep links
 * survive a reload (the server falls back to index.html for non-API GETs).
 */
export type Route =
  | { view: "home" }
  | { view: "settings" }
  | { view: "admin" }
  | { view: "classroom"; id: string }
  | { view: "assignment"; classroomId: string; assignmentId: string }
  | { view: "assignment-groups"; classroomId: string; assignmentId: string };

export function routeToPath(r: Route): string {
  switch (r.view) {
    case "home":
      return "/";
    case "settings":
      return "/settings";
    case "admin":
      return "/admin";
    case "classroom":
      return `/classrooms/${r.id}`;
    case "assignment":
      return `/classrooms/${r.classroomId}/assignments/${r.assignmentId}`;
    case "assignment-groups":
      return `/classrooms/${r.classroomId}/assignments/${r.assignmentId}/groups`;
  }
}

export function parsePath(path: string): Route {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "settings") return { view: "settings" };
  if (parts[0] === "admin") return { view: "admin" };
  if (parts[0] === "classrooms" && parts[1]) {
    if (parts[2] === "assignments" && parts[3]) {
      // The group-formation screen is a page of its own under the assignment,
      // not a tab: it is a different job (forming teams) with its own toolbar.
      const view = parts[4] === "groups" ? "assignment-groups" : "assignment";
      return { view, classroomId: parts[1], assignmentId: parts[3] };
    }
    return { view: "classroom", id: parts[1] };
  }
  return { view: "home" };
}

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((r: Route) => {
    const path = routeToPath(r);
    if (path !== window.location.pathname) {
      window.history.pushState(null, "", path);
    }
    setRoute(r);
  }, []);
  return [route, navigate];
}

/**
 * One query-string parameter as state (tabs inside a page). Reading survives
 * a reload; writing replaces the entry so Back still leaves the page.
 *
 * It still listens to `popstate`: Back and Forward move between pages that
 * carry a `?tab=` of their own, and without this the value stayed on whatever
 * the previous page had selected.
 */
export function useSearchParam(name: string, fallback: string): [string, (v: string) => void] {
  const read = useCallback(
    () => new URLSearchParams(window.location.search).get(name) ?? fallback,
    [name, fallback],
  );
  const [value, setValue] = useState(read);
  useEffect(() => {
    const onPop = () => setValue(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [read]);
  const set = useCallback(
    (v: string) => {
      const params = new URLSearchParams(window.location.search);
      if (v === fallback) params.delete(name);
      else params.set(name, v);
      const q = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : ""));
      setValue(v);
    },
    [name, fallback],
  );
  return [value, set];
}
