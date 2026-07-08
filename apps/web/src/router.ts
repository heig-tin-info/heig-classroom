import { useCallback, useEffect, useState } from "react";

/**
 * Minimal history-backed router: every in-app navigation pushes a real URL,
 * so the browser (and mouse) back/forward buttons work, and deep links
 * survive a reload (the server falls back to index.html for non-API GETs).
 */
export type Route =
  | { view: "home" }
  | { view: "settings" }
  | { view: "classroom"; id: string }
  | { view: "assignment"; classroomId: string; assignmentId: string };

export function routeToPath(r: Route): string {
  switch (r.view) {
    case "home":
      return "/";
    case "settings":
      return "/settings";
    case "classroom":
      return `/classrooms/${r.id}`;
    case "assignment":
      return `/classrooms/${r.classroomId}/assignments/${r.assignmentId}`;
  }
}

export function parsePath(path: string): Route {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "settings") return { view: "settings" };
  if (parts[0] === "classrooms" && parts[1]) {
    if (parts[2] === "assignments" && parts[3]) {
      return { view: "assignment", classroomId: parts[1], assignmentId: parts[3] };
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
