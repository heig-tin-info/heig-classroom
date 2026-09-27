import { describe, expect, it } from "vitest";

import {
  buildNav,
  homePage,
  isIndexFile,
  isPageFile,
  navSortKey,
  placePage,
  prettifyName,
  relativeHref,
  resolveRelative,
  stripOrderPrefix,
} from "./journalTree.js";

describe("file classification", () => {
  it("takes markdown files as pages, whatever the case", () => {
    expect(isPageFile("010-intro.md")).toBe(true);
    expect(isPageFile("NOTES.MD")).toBe(true);
    expect(isPageFile("images/a.png")).toBe(false);
    expect(isPageFile("Makefile")).toBe(false);
  });

  it("recognises both landing-page conventions", () => {
    expect(isIndexFile("README.md")).toBe(true);
    expect(isIndexFile("010-basics/readme.md")).toBe(true);
    expect(isIndexFile("010-basics/index.md")).toBe(true);
    expect(isIndexFile("010-basics/020-pointers.md")).toBe(false);
  });
});

describe("titles", () => {
  it("strips the ordering prefix in its usual spellings", () => {
    expect(stripOrderPrefix("010-pointers")).toBe("pointers");
    expect(stripOrderPrefix("01_pointers")).toBe("pointers");
    expect(stripOrderPrefix("1. pointers")).toBe("pointers");
    expect(stripOrderPrefix("pointers")).toBe("pointers");
  });

  it("keeps a number that is part of the name", () => {
    expect(prettifyName("010-lab-2-report.md")).toBe("Lab 2 report");
  });

  it("opens up dashes and capitalises", () => {
    expect(prettifyName("010-basics/020-what-is-a-pointer.md")).toBe("What is a pointer");
  });

  it("never returns an empty title", () => {
    expect(prettifyName("010-.md")).toBe("010-");
  });
});

describe("navSortKey", () => {
  it("puts the landing page of a directory first", () => {
    expect(navSortKey("010-basics/README.md") < navSortKey("010-basics/010-a.md")).toBe(true);
  });

  it("sorts on the raw name, so the numeric prefix decides", () => {
    expect(navSortKey("020-zebra.md") > navSortKey("010-yak.md")).toBe(true);
  });

  it("holds no character a Postgres text column would refuse", () => {
    // A NUL byte is rejected outright by `text`, and this value is stored.
    for (const p of ["README.md", "010-a.md", "a/index.md"]) {
      expect(navSortKey(p)).not.toMatch(/[\u0000-\u001f]/);
    }
  });
});

describe("placePage", () => {
  it("places a page and its fallback title", () => {
    expect(placePage("010-basics/020-pointers.md")).toEqual({
      path: "010-basics/020-pointers.md",
      parentPath: "010-basics",
      sortKey: "1:020-pointers.md",
      fallbackTitle: "Pointers",
      index: false,
    });
  });

  it("strips the journal root from the exposed path", () => {
    expect(placePage("docs/010-intro.md", "docs")?.path).toBe("010-intro.md");
    expect(placePage("docs/010-intro.md", "docs/")?.path).toBe("010-intro.md");
  });

  it("ignores what is outside the root, and what is not a page", () => {
    expect(placePage("elsewhere/010-intro.md", "docs")).toBeNull();
    expect(placePage("docs/images/a.png", "docs")).toBeNull();
    expect(placePage("docs/", "docs")).toBeNull();
  });
});

describe("resolveRelative", () => {
  it("resolves against the page's own directory", () => {
    expect(resolveRelative("010-basics/020-pointers.md", "images/p.svg")).toBe(
      "010-basics/images/p.svg",
    );
    expect(resolveRelative("010-basics/020-pointers.md", "./images/p.svg")).toBe(
      "010-basics/images/p.svg",
    );
  });

  it("climbs with ../ and stops at the root", () => {
    expect(resolveRelative("010-basics/020-pointers.md", "../020-tooling/010-make.md")).toBe(
      "020-tooling/010-make.md",
    );
    expect(resolveRelative("010-basics/020-pointers.md", "../../etc/passwd")).toBeNull();
    expect(resolveRelative("README.md", "../secrets.md")).toBeNull();
  });

  it("refuses anything that is not a plain relative path", () => {
    expect(resolveRelative("README.md", "https://example.org/a.png")).toBeNull();
    expect(resolveRelative("README.md", "javascript:alert(1)")).toBeNull();
    expect(resolveRelative("README.md", "//example.org/a.png")).toBeNull();
    expect(resolveRelative("README.md", "/etc/passwd")).toBeNull();
    expect(resolveRelative("README.md", "#anchor")).toBeNull();
    expect(resolveRelative("README.md", "C:\\secrets")).toBeNull();
    expect(resolveRelative("README.md", "")).toBeNull();
  });
});

describe("buildNav", () => {
  const page = (path: string, title: string) => ({
    path,
    parentPath: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    sortKey: navSortKey(path),
    title,
  });

  const pages = [
    page("README.md", "The course"),
    page("020-tooling/README.md", "Tooling"),
    page("020-tooling/010-make.md", "Make"),
    page("010-basics/020-pointers.md", "Pointers"),
    page("010-basics/010-variables.md", "Variables"),
    page("010-basics/README.md", "Basics"),
    page("005-foreword.md", "Foreword"),
  ];

  it("nests pages under their directory, prefixes deciding the order", () => {
    const nav = buildNav(pages);
    expect(nav.map((n) => n.title)).toEqual(["Foreword", "Basics", "Tooling"]);
    expect(nav[1]!.children.map((n) => n.title)).toEqual(["Variables", "Pointers"]);
  });

  it("names a section after its landing page and opens it", () => {
    const basics = buildNav(pages)[1]!;
    expect(basics.pagePath).toBe("010-basics/README.md");
    expect(basics.path).toBe("010-basics");
  });

  it("keeps the root landing page out of the tree", () => {
    expect(buildNav(pages).some((n) => n.pagePath === "README.md")).toBe(false);
    expect(homePage(pages)?.title).toBe("The course");
  });

  it("makes a section that has no landing page open nothing", () => {
    const nav = buildNav([page("030-annexes/010-tables.md", "Tables")]);
    expect(nav).toEqual([
      {
        path: "030-annexes",
        title: "Annexes",
        pagePath: null,
        children: [
          { path: "030-annexes/010-tables.md", title: "Tables", pagePath: "030-annexes/010-tables.md", children: [] },
        ],
      },
    ]);
  });

  it("nests deeper than one level", () => {
    const nav = buildNav([
      page("010-a/README.md", "A"),
      page("010-a/010-b/README.md", "B"),
      page("010-a/010-b/010-c.md", "C"),
    ]);
    expect(nav[0]!.children[0]!.children[0]!.title).toBe("C");
  });

  it("has no home page when the root has no landing page", () => {
    expect(homePage([page("010-intro.md", "Intro")])).toBeUndefined();
  });
});

describe("relativeHref", () => {
  it("links a sibling", () => {
    expect(relativeHref("010-basics/010-a.md", "010-basics/020-b.md")).toBe("./020-b.md");
  });

  it("climbs out of a directory", () => {
    expect(relativeHref("010-basics/020-pointers.md", "020-tooling/010-make.md")).toBe(
      "../020-tooling/010-make.md",
    );
  });

  it("descends from the root", () => {
    expect(relativeHref("README.md", "010-basics/010-a.md")).toBe("./010-basics/010-a.md");
  });

  it("climbs twice", () => {
    expect(relativeHref("a/b/c.md", "x.md")).toBe("../../x.md");
  });

  it("resolves the way a browser would", () => {
    const base = "https://app.test/classrooms/7/journal/";
    for (const [from, to] of [
      ["010-basics/020-pointers.md", "020-tooling/010-make.md"],
      ["README.md", "010-basics/010-a.md"],
      ["a/b/c.md", "x.md"],
      ["a/b/c.md", "a/b/d.md"],
    ] as const) {
      const resolved = new URL(relativeHref(from, to), base + from);
      expect(resolved.pathname).toBe(`/classrooms/7/journal/${to}`);
    }
  });
});
