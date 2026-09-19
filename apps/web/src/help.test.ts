import { describe, expect, it } from "vitest";

import { helpTopics } from "./help";

/*
 * The help sources are the list: `helpTopics` reads `src/help/*.md` and pulls
 * each title out of the file itself, so that adding a topic is adding a file.
 * The command palette is its only caller, and a topic it cannot name is a
 * topic nobody can reach from the palette.
 */

const titles = (locale: string) => helpTopics(locale).map((t) => t.title);

describe("helpTopics", () => {
  it("names every topic once, whatever number of translations it has", () => {
    const topics = helpTopics("en").map((t) => t.topic);
    expect(new Set(topics).size).toBe(topics.length);
    // The sources that exist today; a new one is expected to show up here.
    expect(topics).toContain("roster");
    expect(topics).toContain("timeline");
    expect(topics).toContain("new-classroom");
  });

  it("reads the title from the first heading of the source", () => {
    const timeline = helpTopics("en").find((t) => t.topic === "timeline");
    expect(timeline?.title).toBe("Timeline");
  });

  it("reads the French heading from the French source", () => {
    expect(helpTopics("fr").find((t) => t.topic === "timeline")?.title).toBe("Frise chronologique");
    expect(helpTopics("fr").find((t) => t.topic === "new-classroom")?.title).toBe(
      "Nouvelle classe",
    );
  });

  it("falls back to the English source for a language nobody translated to", () => {
    expect(helpTopics("de").find((t) => t.topic === "timeline")?.title).toBe("Timeline");
  });

  it("sorts by title, which is the only order the reader can see", () => {
    for (const locale of ["en", "fr"]) {
      const sorted = [...titles(locale)].sort((a, b) => a.localeCompare(b, locale));
      expect(titles(locale)).toEqual(sorted);
    }
  });

  it("gives the same topics in both languages", () => {
    const topicSet = (locale: string) => new Set(helpTopics(locale).map((t) => t.topic));
    expect(topicSet("fr")).toEqual(topicSet("en"));
  });
});

/*
 * A topic belongs to a role's palette when that role can reach the `HelpIcon`
 * that opens it. Outside the teacher UI that is `student-home` (StudentHome)
 * and `notifications` (SettingsPage); every other source is hosted by a
 * teacher screen, and a student offered "Import roster" is offered the
 * documentation of a page they will never see.
 */
describe("helpTopics outside the teacher UI", () => {
  it("gives a student exactly the topics a student screen can open", () => {
    expect(helpTopics("en", false).map((t) => t.topic).sort()).toEqual([
      "notifications",
      "student-home",
    ]);
  });

  it("keeps the teacher documentation out of it", () => {
    const topics = helpTopics("en", false).map((t) => t.topic);
    for (const teacherOnly of ["import-roster", "roster", "new-classroom", "scheduled-tasks"]) {
      expect(topics).not.toContain(teacherOnly);
    }
  });

  it("titles and sorts the student topics like any other", () => {
    const fr = helpTopics("fr", false);
    expect(fr.map((t) => t.title)).toEqual(
      [...fr.map((t) => t.title)].sort((a, b) => a.localeCompare(b, "fr")),
    );
    expect(fr.every((t) => t.title !== "")).toBe(true);
  });

  it("gives the teacher every source, and defaults to that", () => {
    const all = helpTopics("en").map((t) => t.topic);
    expect(helpTopics("en", true).map((t) => t.topic)).toEqual(all);
    expect(all.length).toBeGreaterThan(helpTopics("en", false).length);
    expect(all).toContain("import-roster");
  });
});
