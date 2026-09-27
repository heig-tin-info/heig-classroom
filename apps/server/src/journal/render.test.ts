import { describe, expect, it } from "vitest";

import { renderPage, splitFrontMatter, type RenderContext } from "./render.js";

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  pagePath: "010-basics/020-pointers.md",
  fallbackTitle: "Pointers",
  asset: (p) => (p === "010-basics/images/p.svg" ? `/assets/${p}` : null),
  page: (p) => (p === "020-tooling/010-make.md" ? `/journal/${p}` : null),
  ...over,
});

describe("splitFrontMatter", () => {
  it("takes the mapping off the top", () => {
    const r = splitFrontMatter("---\ntitle: Pointers\ndraft: true\n---\nBody\n");
    expect(r.frontMatter).toEqual({ title: "Pointers", draft: true });
    expect(r.body).toBe("Body\n");
    expect(r.warnings).toEqual([]);
  });

  it("leaves a page without front matter alone", () => {
    const r = splitFrontMatter("# Title\n\n---\n\nA horizontal rule is not front matter.\n");
    expect(r.frontMatter).toEqual({});
    expect(r.body.startsWith("# Title")).toBe(true);
  });

  it("reports broken YAML and keeps the body", () => {
    const r = splitFrontMatter("---\ntitle: [unclosed\n---\nBody\n");
    expect(r.warnings).toHaveLength(1);
    expect(r.body).toBe("Body\n");
  });

  it("reports a block that is not a mapping", () => {
    const r = splitFrontMatter("---\n- a\n- b\n---\nBody\n");
    expect(r.frontMatter).toEqual({});
    expect(r.warnings[0]).toMatch(/not a list of keys/);
  });
});

describe("title", () => {
  it("prefers the front matter", () => {
    const p = renderPage("---\ntitle: From the front matter\n---\n# From the heading\n", ctx());
    expect(p.title).toBe("From the front matter");
  });

  it("falls back to the first h1, then to the file name", () => {
    expect(renderPage("# From the heading\n", ctx()).title).toBe("From the heading");
    expect(renderPage("Just a paragraph.\n", ctx()).title).toBe("Pointers");
  });

  it("keeps the h1 in the body: the page owns its own title", () => {
    expect(renderPage("# Pointers\n", ctx()).html).toContain("<h1");
  });
});

describe("visibility", () => {
  it("reads draft in the spellings a teacher may use", () => {
    expect(renderPage("---\ndraft: true\n---\n", ctx()).draft).toBe(true);
    expect(renderPage("---\ndraft: yes\n---\n", ctx()).draft).toBe(true);
    expect(renderPage("---\ndraft: false\n---\n", ctx()).draft).toBe(false);
    expect(renderPage("Nothing\n", ctx()).draft).toBe(false);
  });

  it("reads visible_from as a date", () => {
    const p = renderPage("---\nvisible_from: 2026-10-01T08:00:00Z\n---\n", ctx());
    expect(p.visibleFrom?.toISOString()).toBe("2026-10-01T08:00:00.000Z");
  });

  it("keeps a page visible when its date is unusable, and says so", () => {
    const p = renderPage("---\nvisible_from: next monday\n---\n", ctx());
    expect(p.visibleFrom).toBeNull();
    expect(p.warnings.join()).toMatch(/not a date/);
  });
});

describe("raw HTML", () => {
  it("shows a script as text instead of running it", () => {
    const p = renderPage("<script>alert(1)</script>\n", ctx());
    expect(p.html).not.toContain("<script");
    expect(p.html).toContain("&lt;script&gt;");
    expect(p.warnings).toHaveLength(1);
  });

  it("escapes an inline tag too, and warns once for the page", () => {
    const p = renderPage("A <b>bold</b> and an <i>italic</i> tag.\n", ctx());
    expect(p.html).not.toContain("<b>");
    expect(p.html).toContain("&lt;b&gt;");
    expect(p.warnings).toHaveLength(1);
  });

  it("leaves a smuggled img no way in", () => {
    const p = renderPage('<img src=x onerror="alert(1)">\n', ctx());
    expect(p.html).not.toContain("<img");
    expect(p.html).toContain("&lt;img");
  });
});

describe("links", () => {
  it("rewrites a relative page link to its in-app route", () => {
    const p = renderPage("[Make](../020-tooling/010-make.md)\n", ctx());
    expect(p.html).toContain('href="/journal/020-tooling/010-make.md"');
  });

  it("keeps the fragment of a page link", () => {
    const p = renderPage("[Make](../020-tooling/010-make.md#install)\n", ctx());
    expect(p.html).toContain('href="/journal/020-tooling/010-make.md#install"');
  });

  it("opens an external link in a new tab without a referrer", () => {
    const p = renderPage("[HEIG](https://heig-vd.ch)\n", ctx());
    expect(p.html).toContain('target="_blank"');
    expect(p.html).toContain('rel="noreferrer"');
  });

  it("keeps an in-page anchor", () => {
    expect(renderPage("[top](#pointers)\n", ctx()).html).toContain('href="#pointers"');
  });

  it("drops a javascript: link and keeps its text", () => {
    const p = renderPage("[click](javascript:alert(1))\n", ctx());
    expect(p.html).not.toContain("javascript:");
    expect(p.html).toContain("click");
  });

  it("drops a link that resolves nowhere, and reports it", () => {
    const p = renderPage("[gone](./030-missing.md)\n", ctx());
    expect(p.html).not.toContain("<a ");
    expect(p.html).toContain("gone");
    expect(p.warnings.join()).toMatch(/not in the journal/);
  });
});

describe("images", () => {
  it("serves a committed image through the platform", () => {
    const p = renderPage("![A pointer](images/p.svg)\n", ctx());
    expect(p.html).toContain('src="/assets/010-basics/images/p.svg"');
    expect(p.html).toContain('alt="A pointer"');
    expect(p.html).toContain('loading="lazy"');
  });

  it("drops an external image and tells the author to commit it", () => {
    const p = renderPage("![remote](https://example.org/p.png)\n", ctx());
    expect(p.html).not.toContain("<img");
    expect(p.html).toContain("remote");
    expect(p.warnings.join()).toMatch(/commit it instead/);
  });
});

describe("code", () => {
  it("highlights a fence and names its language", () => {
    const p = renderPage("```c\nint x = 1; // a\n```\n", ctx());
    expect(p.html).toContain('class="language-c"');
    expect(p.html).toContain('<span class="tok-kw">int</span>');
    expect(p.html).toContain('<span class="tok-com">// a</span>');
  });

  it("escapes a fence with no language", () => {
    const p = renderPage("```\n<not html>\n```\n", ctx());
    expect(p.html).toContain("&lt;not html&gt;");
    expect(p.warnings).toEqual([]);
  });

  it("leaves a dollar inside code alone", () => {
    const p = renderPage("Run `echo $HOME` first.\n", ctx());
    expect(p.html).toContain("$HOME");
  });
});

describe("math", () => {
  it("renders an inline formula", () => {
    const p = renderPage("The value $x^2$ grows.\n", ctx());
    expect(p.html).toContain("katex");
    expect(p.warnings).toEqual([]);
  });

  it("renders a display formula", () => {
    const p = renderPage("$$\n\\int_0^1 x\\,dx\n$$\n", ctx());
    expect(p.html).toContain("katex-display");
  });

  it("reports a broken formula and keeps its source readable", () => {
    const p = renderPage("$\\frac{1}{$\n", ctx());
    expect(p.warnings.join()).toMatch(/Formula/);
    expect(p.html).toContain("md-math-error");
  });

  it("does not let a formula smuggle a link in", () => {
    // KaTeX runs with `trust: false`, so `\\href` renders as red text. The TeX
    // source does survive inside the MathML annotation, as escaped text: what
    // must not exist is an anchor or an attribute carrying it.
    const p = renderPage("$\\href{javascript:alert(1)}{x}$\n", ctx());
    expect(p.html).not.toContain("<a ");
    expect(p.html).not.toMatch(/href="javascript:/);
  });
});

describe("table of contents", () => {
  it("lists the headings with stable anchors", () => {
    const p = renderPage("# Pointers\n\n## What is it\n\n## Why\n", ctx());
    expect(p.toc).toEqual([
      { id: "pointers", depth: 1, text: "Pointers" },
      { id: "what-is-it", depth: 2, text: "What is it" },
      { id: "why", depth: 2, text: "Why" },
    ]);
    expect(p.html).toContain('<h2 id="what-is-it">');
  });

  it("disambiguates two headings that read the same", () => {
    const p = renderPage("## Notes\n\n## Notes\n", ctx());
    expect(p.toc.map((t) => t.id)).toEqual(["notes", "notes-2"]);
  });

  it("folds accents and keeps the displayed text intact", () => {
    const p = renderPage("## Référence à l'opérateur\n", ctx());
    expect(p.toc[0]!.id).toBe("reference-a-l-operateur");
    expect(p.toc[0]!.text).toBe("Référence à l'opérateur");
  });

  it("takes the plain text of a heading that has markup", () => {
    const p = renderPage("## The `malloc` **call**\n", ctx());
    expect(p.toc[0]!.text).toBe("The malloc call");
  });
});

describe("gfm", () => {
  it("renders a table", () => {
    const p = renderPage("| a | b |\n| --- | --- |\n| 1 | 2 |\n", ctx());
    expect(p.html).toContain("<table>");
  });

  it("escapes text in a table cell", () => {
    const p = renderPage("| a |\n| --- |\n| <script> |\n", ctx());
    expect(p.html).not.toContain("<script>");
  });
});
