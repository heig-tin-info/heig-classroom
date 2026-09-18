# Design system: HEIG Classroom (web)

Character: calm and precise, a tool a teacher trusts between two lectures and
a student opens the night before a deadline. Nothing shouts; the one red
element on a screen is the thing to click.

Every value below carries its reason. A value outside this file is either an
extension (add it here, with its why, in the same change) or a mistake.

## Color

Warm neutrals: the product sits next to GitHub and code editors, which are
cool and gray. A paper-warm canvas separates it from them and softens the
HEIG red, which turns harsh on a pure white or a cool gray.

Semantic tokens only in components (`bg-surface`, `text-fg-muted`, …); the
raw values live in `src/style.css` and swap in dark mode without any
`dark:` variant in the markup.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `canvas` | `#f6f5f2` | `#131211` | page background |
| `surface` | `#ffffff` | `#1b1a18` | cards, sheets, inputs |
| `surface-2` | `#f3f1ed` | `#232220` | recessed panels, hover rows |
| `surface-3` | `#eae7e1` | `#2c2a27` | segmented tracks, skeletons |
| `line` | `#e7e4de` | `#2a2825` | hairlines (the separation language) |
| `line-strong` | `#d3cfc7` | `#3a3733` | input borders, focused hairlines |
| `fg` | `#1a1917` | `#ecebe7` | text |
| `fg-muted` | `#67635b` | `#a39e94` | secondary text, ≥ 4.5:1 on surface |
| `fg-faint` | `#9a958b` | `#6e6961` | captions, disabled, icons at rest |
| `accent` | `#b41f24` | `#e0484e` | HEIG red (brand constraint): primary action, "now" marker, focus ring |
| `accent-hover` | `#9a1b1f` | `#ea5c61` | |
| `accent-soft` | `#fbebeb` | `rgb(224 72 78 / 0.14)` | selected nav item, accent chips |
| `success` / `success-soft` | `#1f7a4d` / `#e7f4ec` | `#4cc38a` / `rgb(76 195 138 / 0.14)` | semantic only |
| `warning` / `warning-soft` | `#a85c12` / `#fdf1e2` | `#f0a04b` / `rgb(240 160 75 / 0.14)` | semantic only |
| `danger` / `danger-soft` | `#c2242a` / `#fbe9e9` | `#f26d72` / `rgb(242 109 114 / 0.14)` | destructive actions, failures |

Rule: strip the accent and every screen must still read. Hierarchy comes
from size, weight and position, never from red.

## Typography

- Family: **Manrope** (variable, self-hosted through `@fontsource-variable`).
  Geometric with distinctive `a`, `g` and `t`: it has a voice at 28 px and
  stays quiet and legible at 13 px. One family; the contrast lives in the
  size jump and the weight jump, not in a second face.
- Mono: **JetBrains Mono** for SHAs, repository names, milestone keys and
  anything a student will copy.
- Scale (px): 12 caption · 13 dense UI (tables, chips) · 14 body · 16 section
  title · 20 sheet title · 28 page title. Page title / body = 2×, and the
  title is 700 with `-0.02em` tracking; body is 400, labels 500.
- Numbers in tables and countdowns are tabular (`tabular-nums`).

## Spacing

- Base 4 px; scale 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48.
- Rhythm: tight inside a group (4–8), comfortable inside a card (16–20),
  generous between sections (32) and between the page header and its body
  (24). A screen that is all 16 px gaps has made no decision.
- Content column: 1120 px max, 24 px side gutter (16 on phones).

## Shape and elevation

- Radii: controls (buttons, chips, segmented, avatars) are **pills**;
  fields 12 px; cards 16 px; sheets and dialogs 20 px; menus 14 px.
  Pills on everything you press, soft squares on everything that holds.
- Separation language: **1 px hairlines** (`line`), one surface level below
  for recessed panels (`surface-2`). No shadows on anything in the page
  flow. Shadows exist only on floating layers (menu, popover, sheet, dialog,
  toast), because those genuinely sit above the page.
- Focus: 2 px accent ring at 2 px offset, on every interactive element.

## Motion

- 120 ms for micro feedback (hover, press), 200 ms for panels and menus,
  260 ms for sheets. Easing `cubic-bezier(0.2, 0, 0, 1)`. Presses scale to
  0.97. Honors `prefers-reduced-motion`.

## Components

- Button: `primary` (accent fill, white text, one per screen), `secondary`
  (surface, hairline), `ghost` (no chrome), `danger` (danger fill, never
  primary-styled elsewhere). Sizes `sm` 28 px, `md` 34 px, `lg` 40 px.
- Icon button: round, ghost; `danger` turns red on hover only.
- Badge: pill, soft background, 12 px, tones green / amber / red / zinc /
  accent. Status is a badge; a count is plain text.
- Card: `surface` + hairline + 16 px radius; padding 16–20.
- Field: label 13 px 500 above, input 34 px, 12 px radius, `line-strong`
  border, accent ring on focus.
- Segmented: `surface-3` pill track, selected chip raised to `surface`.
- Switch: `success` when on (a state, not an action, so not the accent),
  `line-strong` when off.
- Tabs: text tabs with a 2 px ink (`fg`) underline, counts in `fg-faint`; red
  stays for actions.
- Sheet: right drawer, 560 px, for every form longer than three fields.
  Dialog: centered, ≤ 480 px, for confirmations and one-field forms.
  A sheet never opens another sheet; a dialog may open over a sheet.
- Menu: overflow for tertiary actions; destructive items last, separated.
- Toast: bottom-right, `surface` + hairline + overlay shadow.
- Empty state: icon in a `surface-2` circle, title, one line, one action.

## Voice

Sentence case everywhere. Buttons start with a verb ("Create assignment",
"Publish"). Status words are lowercase in badges. Teacher surfaces are in
English; student and settings surfaces go through `t()` in English and
French.
