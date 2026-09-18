---
name: hgc-ui
description: How to design, build and review any screen of the HEIG Classroom web app (apps/web). Use before touching a React component, adding a page, restyling, or reviewing a UI diff. Enforces apps/web/DESIGN.md, the state checklist, the one-primary-action rule, and the visual check through the browser mock.
---

# HEIG Classroom UI

The visual contract is `apps/web/DESIGN.md`. Read it first; every value on a
screen (color, size, radius, spacing, motion) comes from it. A value outside
it is either an extension (add it to DESIGN.md with its reason, in the same
change) or a mistake.

## Decide before you draw

Before writing styled markup for a new surface, write four lines in your
working notes, one per axis, and make sure none of them is "the default":

- Type: where does the contrast live (size jump, weight jump)?
- Color: what is the single accent use on this screen?
- Space: tight inside groups, generous between sections; which is which here?
- Finish: hairlines and surfaces, never shadows in the page flow.

If you cannot say what the ONE primary action of the screen is, the problem
is the flow, not the styling. Stop and ask.

## Rules that are not negotiable

1. Semantic tokens only: `bg-surface`, `text-fg-muted`, `border-line`,
   `bg-accent-soft`… Never `zinc-*`, never hex, never `dark:` variants (the
   tokens swap by themselves under `html.dark`).
2. Primitives from `src/ui.tsx` before anything hand-rolled: `Button`,
   `IconButton`, `Card`, `Badge`, `Alert`, `Field`/`Select`/`Textarea`,
   `Segmented`, `Switch`, `Tabs`, `Menu`, `Modal`, `Sheet`, `PageHeader`,
   `SectionHeading`, `Stat`, `EmptyState`, `Skeleton`, table styles `T`.
   A new variant is an extension of the primitive, not a one-off class list.
3. Action tiers per screen: one `primary` button (two at most), two or three
   `secondary`, everything else in a `Menu` or as an `IconButton`.
   Destructive actions use `variant="danger"` and go through `useConfirm()`
   from `src/confirm.tsx`; `window.confirm` is banned.
4. Long forms (more than three fields) open in a `Sheet`; confirmations and
   one-field forms in a `Modal`. A sheet never opens another sheet.
5. Every async surface renders its five states: loading (`Skeleton` or
   `Spinner`), empty (`EmptyState` with the one action), error (`Alert
   tone="danger"` with a retry), partial (some rows without data show `—`),
   and success. Check them in the mock before calling the work done.
6. Tables: at most seven visible columns, one dominant identity column
   (bold), numbers right-aligned and tabular, status as a `Badge`, actions in
   the last column, `—` for empty cells, hover on clickable rows.
7. Teacher surfaces are English; student and settings surfaces go through
   `t()` with both `en` and `fr` entries in `src/i18n.tsx` (a missing French
   key is a compile error, keep it that way).
8. Logic stays where it is. A UI change never alters an API call, a query
   key, a mutation payload or a domain rule; those live in the server and in
   `packages/domain`.

## Verify visually, every time

The browser mock serves every page without a backend:

```bash
pnpm --filter @hgc/web dev:mock          # http://localhost:5173
# persona: ?as=teacher | ?as=student | ?as=admin ; ?unlinked=1 for a student without GitHub
```

Take screenshots at 1440×900 and 390×844, light and dark, of every page you
touched and of every floating layer you opened (sheet, dialog, menu). Read
them. A change that was not looked at is not finished. The screenshot
script lives in `apps/web/scripts/` (see `docs/development/`).

## Review checklist (for a UI diff)

- Squint test: is the primary action obvious with the accent stripped?
- Any raw color, `dark:` variant or shadow in the page flow? Reject.
- Any new modal holding a form longer than three fields? Should be a sheet.
- Any row of three or more icon buttons? Should be a menu.
- Any `window.confirm`? Reject.
- Any state missing (loading / empty / error) on a new query? Reject.
- Any student-facing string without a French entry? Compile error, reject.
- Keyboard: Escape closes layers, focus returns to the trigger, menus
  navigate with arrows, tabs with arrows.
- Did the author attach or describe the screenshots they looked at?

## When DESIGN.md is wrong

It happens. Change the file and the screens it affects in the same commit,
say why in the commit message, and list the screens you re-checked.
