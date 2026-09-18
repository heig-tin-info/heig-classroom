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
| `fg-muted` | `#67635b` | `#a39e94` | secondary text, ≥ 4.5:1 on surface and surface-2 |
| `fg-faint` | `#8f8a80` | `#6e6961` | captions, disabled, icons at rest; ≥ 3:1 on canvas |
| `accent` | `#b41f24` | `#e85f64` | HEIG red (brand constraint): primary action, "now" marker, focus ring |
| `accent-hover` | `#9a1b1f` | `#f0787c` | |
| `accent-soft` | `#fbebeb` | `rgb(232 95 100 / 0.10)` | selected nav item, accent chips |
| `on-fill` | `#ffffff` | `#131211` | ink laid on a saturated fill (accent, danger, success) |
| `success` / `success-soft` | `#1f7a4d` / `#e7f4ec` | `#4cc38a` / `rgb(76 195 138 / 0.14)` | semantic only |
| `warning` / `warning-soft` | `#a35810` / `#fdf1e2` | `#f0a04b` / `rgb(240 160 75 / 0.14)` | semantic only |
| `danger` / `danger-soft` | `#c2242a` / `#fbe9e9` | `#f26d72` / `rgb(242 109 114 / 0.14)` | destructive actions, failures |

Rule: strip the accent and every screen must still read. Hierarchy comes
from size, weight and position, never from red.

`on-fill` exists because one red cannot do both jobs in dark mode: a red
light enough to read as text on `#1b1a18` (≥ 4.5:1) is too light to carry
white text (≥ 4.5:1 would need a luminance it cannot have at the same time).
So the fill keeps the bright dark-mode red and the ink turns near-black.
Components never write `text-white` on `bg-accent`, `bg-danger` or
`bg-success`: they write `text-on-fill`, which swaps by itself.

### Measured contrast (WCAG 2.1 relative luminance)

Every pair the design promises, computed on the values above (translucent
`-soft` backgrounds composited over `surface`). Text pairs are held to 4.5:1, non-text ones (focus ring) to 3:1. `fg-faint` is decorative,
but an icon button at rest is the only meaning it carries alone, so it is
held to 3:1 on `canvas` and `surface`.

| Pair | Light before | Light after | Dark before | Dark after |
| --- | --- | --- | --- | --- |
| `fg-muted` on `surface` | 5.98 | 5.98 | 6.52 | 6.52 |
| `fg-muted` on `surface-2` | 5.30 | 5.30 | 5.96 | 5.96 |
| `fg-faint` on `surface` | 2.98 ✗ | **3.43** | 3.19 | 3.19 |
| `fg-faint` on `canvas` | 2.73 ✗ | **3.15** | 3.44 | 3.44 |
| `success` on `success-soft` | 4.70 | 4.70 | 6.10 | 6.10 |
| `warning` on `warning-soft` | 4.48 ✗ | **4.76** | 6.27 | 6.27 |
| `danger` on `danger-soft` | 5.01 | 5.01 | 4.88 | 4.88 |
| `accent` on `accent-soft` | 5.75 | 5.75 | 3.75 ✗ | **4.58** |
| `accent` on `surface` | 6.64 | 6.64 | 4.31 ✗ | **5.18** |
| `on-fill` on `accent` | 6.64 | 6.64 | 4.03 ✗ (white) | **5.57** |
| `on-fill` on `accent-hover` | 8.23 | 8.23 | 3.39 ✗ (white) | **6.85** |
| `on-fill` on `danger` | 5.87 | 5.87 | 2.91 ✗ (white) | **6.42** |
| focus ring on `surface` / `canvas` | 6.64 / 6.09 | 6.64 / 6.09 | 4.31 / 4.64 | 5.18 / 5.57 |

Two pairs stay below their target, on purpose:

- `line-strong` on `surface` (1.55 light, 1.47 dark). Field borders and the
  switch track are hairlines; taking them to 3:1 would turn the whole
  interface into a wireframe and contradict the separation language above.
  The controls stay identifiable by their fill, their label and a focus ring
  at 5:1 or better.
- the white switch knob on the `success` track in dark mode (2.22). The state
  is carried by the track colour and the knob position, not by the knob edge.

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
- A navigation list is capped, not scrolled: the sidebar shows twelve
  classrooms and a "Show all (N)" row, always including the one being read.
  Thirty names in a column is a wall, and it pushes the account row off.

## Shape and elevation

- Radii: controls (buttons, chips, segmented, avatars) are **pills**;
  fields 12 px; cards 16 px; sheets and dialogs 20 px; menus 14 px.
  Pills on everything you press, soft squares on everything that holds.
- Separation language: **1 px hairlines** (`line`), one surface level below
  for recessed panels (`surface-2`). No shadows on anything in the page
  flow. Shadows exist only on floating layers (menu, popover, sheet, dialog,
  toast), because those genuinely sit above the page.
- Focus: 2 px accent ring at 2 px offset, on every interactive element. It is
  declared once in `style.css` on `:focus-visible`; no component restyles it.

## Keyboard and focus

A floating layer is not finished until it behaves. `useLayer` in `ui.tsx`
holds the contract for `Modal`, `Sheet`, the confirm dialog, the mobile
drawer and the help drawer:

- open: focus moves into the panel (an `autoFocus` inside wins, otherwise the
  first focusable element, otherwise the panel itself, which carries
  `tabIndex={-1}`);
- while open: Tab and Shift+Tab cycle inside the panel, and only the topmost
  layer answers Escape, so the help drawer opened from a dialog closes alone;
- close: focus goes back to the element that opened the layer;
- naming: `role="dialog"`, `aria-modal="true"` and `aria-labelledby` pointing
  at the panel's own title.
- the backdrop never closes a layer: a stray click must not discard what the
  user typed. Escape and the X do.

`Menu` follows the WAI-ARIA menu button pattern: `aria-haspopup="menu"` and
`aria-expanded` on the trigger (cloned onto a custom one), Enter / Space /
ArrowDown open on the first item and ArrowUp on the last, arrows wrap,
Home/End jump, Escape and Tab close and hand the focus back to the trigger.
Items are `role="menuitem"` with `tabIndex={-1}`.

`Tabs` uses a roving tabindex: one tab in the Tab order, ArrowLeft/ArrowRight
move and select with wrap, Home/End jump.

`Tip` never takes the focus (portal, `pointer-events-none`, `aria-hidden`)
and Escape dismisses it.

Toasts sit in one `aria-live="polite"` region, each one a `role="status"`
with a keyboard-reachable dismiss button.

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
- Alert: hairline + soft tone fill, an icon, a title and one paragraph. Its
  `action` slot holds one button, beside the text from `sm` up and on a line
  of its own below it: a long label inline squeezes the body to one word per
  line on a phone. Nothing goes in an Alert body that belongs in `action`.
- QueryError: the standard failed-query alert (`Alert tone="danger"` +
  `apiErrorMessage` + a secondary Retry). Every query error state uses it, so
  a failure reads the same everywhere and there is one place to change it.
  Queries retry once and never on a 4xx (`main.tsx`), so the error state
  arrives in about a second: three retries read as a hang, not as a failure.
- Field: label 13 px 500 above, 12 px radius, `line-strong` border, accent
  ring on focus. Two heights, from the button scale: `sm` 28 px for a control
  inside a table row, `md` 34 px everywhere else (`inputSize` in ui.tsx).
  Width is a prop, never a class beside `inputClass`: Tailwind settles two
  width or height utilities on one element by their order in the generated
  stylesheet, not by the order they were written in.
- Segmented: `surface-3` pill track, selected chip raised to `surface`.
- Switch: `success` when on (a state, not an action, so not the accent),
  `line-strong` when off.
- Tabs: text tabs with a 2 px ink (`fg`) underline, counts in `fg-faint`; red
  stays for actions. When the strip is wider than the screen it scrolls, the
  hidden side is faded out over 36 px (a mask, so it works on either theme)
  and the tabs snap: a fourth tab must never simply stop at the screen edge.
- Settings row: label and the description of the current choice on the left,
  the control on the right. The row wraps rather than squeezing — the text
  keeps a 14 rem floor, so a segmented control or a select drops to its own
  line on a phone while a switch stays on the label's line at any width.
- Sheet: right drawer, 560 px, for every form longer than three fields.
  Dialog: centered, ≤ 480 px, for confirmations and one-field forms.
  A sheet never opens another sheet; a dialog may open over a sheet.
- Menu: overflow for tertiary actions; destructive items last, separated. It
  closes on a page scroll, but not on the scroll its own opening click causes
  (200 ms of grace) nor on one inside the panel.
- Toast: bottom-right, `surface` + hairline + overlay shadow.
- Empty state: icon in a `surface-2` circle, title, one line, one action.

## Voice

Sentence case everywhere. Buttons start with a verb ("Create assignment",
"Publish"). Status words are lowercase in badges. Teacher surfaces are in
English; student and settings surfaces go through `t()` in English and
French.
