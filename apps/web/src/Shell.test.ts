import { describe, expect, it } from "vitest";

import { cappedClassrooms } from "./Shell";

/**
 * The folded sidebar list. Thirty classrooms turn the navigation into a wall
 * of names, but the classroom the teacher is reading must never be the one
 * the cap hides: it is the page they are on.
 */
const rooms = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` }));

describe("cappedClassrooms", () => {
  it("returns the list untouched when it fits under the cap", () => {
    expect(cappedClassrooms(rooms(5), null, 12)).toHaveLength(5);
    expect(cappedClassrooms(rooms(12), null, 12)).toHaveLength(12);
  });

  it("keeps the first `cap` entries of a longer list", () => {
    const shown = cappedClassrooms(rooms(30), null, 12);
    expect(shown.map((r) => r.id)).toEqual(rooms(12).map((r) => r.id));
  });

  it("appends the current classroom when the cap would hide it", () => {
    const shown = cappedClassrooms(rooms(30), "c20", 12);
    expect(shown).toHaveLength(13);
    expect(shown[shown.length - 1]?.id).toBe("c20");
  });

  it("does not duplicate a current classroom already in the head", () => {
    const shown = cappedClassrooms(rooms(30), "c3", 12);
    expect(shown).toHaveLength(12);
    expect(shown.filter((r) => r.id === "c3")).toHaveLength(1);
  });

  it("ignores a current id that is not in the list", () => {
    expect(cappedClassrooms(rooms(30), "nope", 12)).toHaveLength(12);
  });
});
