import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useSearchParam } from "./router";

/*
 * `useSearchParam` backs the in-page tabs. The contract it has to keep: a
 * reload lands on the same tab, and Back still leaves the page instead of
 * walking through every tab the reader looked at (hence replaceState).
 *
 * The pure parts of the router (parsePath / routeToPath) stay in
 * router.test.ts, which runs in the node project without a DOM.
 */

const goTo = (url: string) => window.history.replaceState(null, "", url);

describe("useSearchParam", () => {
  it("reads the parameter from the URL", () => {
    goTo("/classrooms/c1?tab=students");
    const { result } = renderHook(() => useSearchParam("tab", "assignments"));
    expect(result.current[0]).toBe("students");
  });

  it("falls back when the parameter is absent", () => {
    goTo("/classrooms/c1");
    const { result } = renderHook(() => useSearchParam("tab", "assignments"));
    expect(result.current[0]).toBe("assignments");
  });

  it("writes the parameter without pushing a history entry", () => {
    goTo("/classrooms/c1");
    const before = window.history.length;
    const { result } = renderHook(() => useSearchParam("tab", "assignments"));
    act(() => result.current[1]("staff"));
    expect(result.current[0]).toBe("staff");
    expect(window.location.pathname).toBe("/classrooms/c1");
    expect(window.location.search).toBe("?tab=staff");
    // Back must leave the classroom, not undo a tab click.
    expect(window.history.length).toBe(before);
  });

  it("clears the parameter when the value goes back to the fallback", () => {
    goTo("/classrooms/c1?tab=staff");
    const { result } = renderHook(() => useSearchParam("tab", "assignments"));
    act(() => result.current[1]("assignments"));
    expect(result.current[0]).toBe("assignments");
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/classrooms/c1");
  });

  it("follows Back and Forward", () => {
    goTo("/classrooms/c1?tab=students");
    const { result } = renderHook(() => useSearchParam("tab", "assignments"));
    expect(result.current[0]).toBe("students");
    // The browser has already changed the URL by the time popstate fires; the
    // hook used to ignore it and keep showing the previous tab.
    act(() => {
      window.history.replaceState(null, "", "/classrooms/c1?tab=staff");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[0]).toBe("staff");
    act(() => {
      window.history.replaceState(null, "", "/classrooms/c1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[0]).toBe("assignments");
  });

  it("leaves the other parameters of the URL alone", () => {
    goTo("/classrooms/c1?tab=staff&q=rochat");
    const { result } = renderHook(() => useSearchParam("tab", "assignments"));
    act(() => result.current[1]("students"));
    expect(new URLSearchParams(window.location.search).get("q")).toBe("rochat");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("students");
    act(() => result.current[1]("assignments"));
    expect(new URLSearchParams(window.location.search).get("q")).toBe("rochat");
    expect(new URLSearchParams(window.location.search).has("tab")).toBe(false);
  });
});
