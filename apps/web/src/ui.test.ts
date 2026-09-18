import { describe, expect, it } from "vitest";

import { buttonClass, formatDateTimeAs, localDateKey, menuPosition } from "./ui";

// Fixed local date-time: the formatters work on local getters, so building the
// date from local parts keeps the test free of any timezone assumption.
const noon = new Date(2026, 8, 7, 14, 5).toISOString(); // 2026-09-07 14:05 local
const morning = new Date(2026, 8, 7, 9, 5).toISOString();

describe("formatDateTimeAs", () => {
  it("writes the ISO format by default", () => {
    expect(formatDateTimeAs(noon, "iso")).toBe("2026-09-07 14:05");
  });

  it("writes the European format with dots", () => {
    expect(formatDateTimeAs(noon, "eu")).toBe("07.09.2026 14:05");
  });

  it("writes the UK format with slashes", () => {
    expect(formatDateTimeAs(noon, "uk")).toBe("07/09/2026 14:05");
  });

  it("writes the US format month-first, on a 12-hour clock", () => {
    expect(formatDateTimeAs(noon, "us")).toBe("09/07/2026 2:05 PM");
    expect(formatDateTimeAs(morning, "us")).toBe("09/07/2026 9:05 AM");
  });

  it("writes midnight as 12 AM in the US format", () => {
    expect(formatDateTimeAs(new Date(2026, 8, 7, 0, 30).toISOString(), "us")).toBe(
      "09/07/2026 12:30 AM",
    );
  });
});

describe("localDateKey", () => {
  it("pads the month and the day", () => {
    expect(localDateKey(new Date(2026, 0, 3))).toBe("2026-01-03");
  });

  it("stays on the local day, not the UTC one", () => {
    expect(localDateKey(new Date(2026, 11, 31, 23, 30))).toBe("2026-12-31");
  });

  it("orders as plain strings", () => {
    const days = [new Date(2026, 8, 10), new Date(2026, 8, 2), new Date(2025, 11, 31)].map((d) =>
      localDateKey(d),
    );
    expect([...days].sort()).toEqual(["2025-12-31", "2026-09-02", "2026-09-10"]);
  });
});

describe("buttonClass", () => {
  it("composes the variant, the size and the shared chrome", () => {
    const cls = buttonClass("primary", "md");
    expect(cls).toContain("bg-accent");
    expect(cls).toContain("text-on-fill");
    expect(cls).toContain("h-[34px]");
    expect(cls).toContain("rounded-full");
  });

  it("defaults to the primary variant at the md size", () => {
    expect(buttonClass()).toBe(buttonClass("primary", "md"));
  });

  it("keeps the variants apart", () => {
    expect(buttonClass("secondary")).toContain("border-line-strong");
    expect(buttonClass("secondary")).not.toContain("bg-accent");
    expect(buttonClass("danger")).toContain("bg-danger");
    expect(buttonClass("ghost")).toContain("text-fg-muted");
    expect(buttonClass("subtle")).toContain("bg-surface-3");
  });

  it("keeps the sizes apart", () => {
    expect(buttonClass("primary", "sm")).toContain("h-7");
    expect(buttonClass("primary", "lg")).toContain("h-10");
  });

  it("appends the extra classes last, so they win", () => {
    expect(buttonClass("primary", "md", "w-full")).toMatch(/w-full$/);
  });

  it("drops an empty extra instead of leaving a trailing space", () => {
    expect(buttonClass("primary", "md", "")).toBe(buttonClass("primary", "md", "").trim());
  });
});

describe("menuPosition", () => {
  const viewport = { width: 1440, height: 900 };
  const rect = (top: number, height = 32, left = 600, width = 32) => ({
    top,
    bottom: top + height,
    left,
    right: left + width,
  });

  it("drops under the trigger when there is room below", () => {
    const p = menuPosition(rect(100), viewport, "end");
    expect(p.up).toBe(false);
    expect(p.top).toBe(138); // bottom + 6
    expect(p.bottom).toBeUndefined();
  });

  it("flips above a trigger sitting low on the viewport", () => {
    const p = menuPosition(rect(820), viewport, "start");
    expect(p.up).toBe(true);
    expect(p.bottom).toBe(86); // height - top + 6
    expect(p.top).toBeUndefined();
  });

  it("stays downward for a trigger in the upper half, however tall the panel", () => {
    // A tall panel on a short viewport: the flip would put the menu off the
    // top, so the trigger must be past the middle for the flip to happen.
    const p = menuPosition(rect(200), { width: 1440, height: 420 }, "end");
    expect(p.up).toBe(false);
  });

  it("anchors on the right edge for align=end and on the left for align=start", () => {
    expect(menuPosition(rect(100, 32, 600, 40), viewport, "end").left).toBe(640);
    expect(menuPosition(rect(100, 32, 600, 40), viewport, "start").left).toBe(600);
  });

  it("takes the assumed panel height into account", () => {
    const low = rect(600);
    expect(menuPosition(low, viewport, "end", 100).up).toBe(false);
    expect(menuPosition(low, viewport, "end", 400).up).toBe(true);
  });
});
