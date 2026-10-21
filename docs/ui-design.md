---
title: "Visual design system"
description: "Exact color, type, spacing, geometry and component rules for TREX pages and any later dashboard. Match this; do not invent a second look."
doc_type: guide
status: current
read_when: "Before building or restyling any page, screen, or dashboard so the result stays consistent with the landing page."
edit_policy: "Update when the landing styles change on purpose. Do not drift the tokens to match a one-off screen."
updated: 2026-10-11
related:
  - docs/product/what-we-are-building.md
---

# Visual design system

The landing page in `landing/` is the reference implementation. A later dashboard uses the same tokens, type, hairlines and geometry. Marketing pages keep the diagonal side gutters. Inside the product, drop only the gutters. Everything else stays.

## Feel

Quiet, flat, and geometric. White does the work. One blue is the only accent. Hairlines separate regions. Dotted fields hold diagrams and sample UI. Nothing is decorated for its own sake: no drop shadows, no gradients except the two named washes below, no second accent color, no filled icon set.

Weight stays light. Body copy is weight 300. Buttons and UI labels are weight 400. Only the display face and a few names go to 500. Nothing is bold 700.

## Color

| Token | Hex | Use |
|---|---|---|
| Ink | `#1e1e1e` | Headlines, body that must be read, logo, diagram hub |
| Muted | `#7f7f7f` | Supporting copy, nav, captions, secondary labels |
| Faint | `#c8c8c8` | The last word of a large statement, when it should recede |
| Quote | `#4a4a4a` | Large statement text (not full ink, not muted) |
| Line | `#ededed` | Section rules, header rule, grid rules, row rules |
| Line strong | `#c9d0da` | Card borders, chips, choice buttons, chevron rings |
| Card line | `#e6e9ee` | Receipt and floating card borders |
| Blue | `#0077ff` | Primary button, links inside evidence, numbers, active state, focus |
| Blue hover | `#006ae6` | Primary button hover only |
| Blue soft | `#f0f6ff` | Small status pill behind blue text |
| Gray button | `#e8e9eb` | Secondary button. Hover `#dedfe1` |
| Painted sky | `#8db2e6` → `#e6effa` | Product stage backdrop: light brushed sky, cream clouds, marigold meadows on both edges. Source `landing/art/painted-sky.svg`, baked to `landing/public/painted-sky.jpg` (1800px, JPEG q65) and used as a CSS background. Never render the SVG live: its filters cause scroll jank. Fallback fill `#b9d0f0` |
| Evidence wash | `#f4f8ff` → `#fff` | Radial ellipse, center to 68%, behind a centered section |
| Dot | `#d5d8de` | The 0.7px dots on a field |
| Field | `#f7f8fa` | Background under those dots |
| Footer | `#1e1e1e` | Closing band |
| Footer muted | `#b9b9b9` | Footer body |
| Footer faint | `#9d9d9d` | Footer meta, legal, link row |
| Dark button | `#2e2e2e` | Secondary button on the footer. Hover `#3a3a3a` |
| Window lights | `#f6635c`, `#f5bd4f`, `#63c454` | The three dots on a product window only |

Selection is `rgba(0, 119, 255, 0.18)` with the selected text in `#0077ff`.

Focus is a `2px` solid blue outline, `3px` offset, on links, buttons and summaries.

Do not introduce green, red, yellow, or mint as brand colors. The only greens are the outgoing chat bubble (`#d9fdd3` on `#f6f3ee`) and the third window light. A held or blocked state is blue, not red.

## Type

Two families.

- **Display.** OPTILawrence, the file `landing/public/OPTILawrence.ttf.woff`, weight 400. Use it for the logo, the hero title, section titles, large statements, and big numbers — every place that shares the hero header’s face. `letter-spacing: -0.015em`. `text-wrap: balance`. Line-height `1.11` on titles, `1.08` on the largest centered title, `1.2`–`1.25` on the large statement. Fallback: Iowan Old Style, Palatino, Georgia.
- **UI.** Outfit, weights 300, 400 and 500. Body is 300. Labels, nav and buttons are 400. Names, numbers in a list, and the active chip are 500. `text-wrap: pretty`. Fallback: system sans.
- **Hindi.** Noto Sans Devanagari, weight 500, same muted color as English support copy. Never a second color.

| Role | Size | Weight | Line-height | Color |
|---|---|---|---|---|
| Logo | 32px (26px under 640px) | display | 1 | ink |
| Hero title | 26 / 38 / 52px | display | 1.11 | ink |
| Large statement | 26 / 32 / 44px | display | 1.25, then 1.2 | `#4a4a4a` |
| Section title | 30px, 44px from 960px | display | 1.11 | ink |
| Centered title | 30px, 52px from 960px | display | 1.08 | ink |
| Step title | 22px | display | 1.11 | ink |
| Band title | 24px | display | 1.11 | ink |
| Footer title | 28px | display | 1.11 | white |
| Hero support | 18 / 20 / 22px | 300 | 1.45 | muted |
| Section support | 16px | 300 | 1.55 | muted |
| Body | 16px | 400 | 1.5 | ink |
| Nav | 15px | 400 | normal | muted, ink on hover |
| Button | 15px, large 16px | 400 | 1 | — |
| List number | 13px | 500 | — | blue, Outfit not display |
| Eyebrow pill | 11px | 500 | — | muted, tracking `0.08em`, uppercase |
| Blue kicker | 12px | 500 | — | blue, tracking `0.1em`, uppercase |
| Caption | 12px | 300 | — | muted |
| Chip | 12.5px | 400 | — | ink |
| Stat number | 28px | display, 400 | — | ink |

Uppercase is only for the eyebrow pill, the blue kicker, the small footer label, and the short labels on diagram nodes. Sentences stay in sentence case.

## Frame

Breakpoints: under 640px, from 640px, from 960px.

**Marketing page.** The viewport background is the diagonal rule. The content is a white sheet, max-width `1400px`, centered, at least `100vh`.

Diagonal rule, on the page background, not on the sheet:

```css
repeating-linear-gradient(
  -45deg,
  #ededed 0px,
  #ededed 1px,
  transparent 1px,
  transparent 11px
)
```

Gutter (so the rules show on both sides): `16px` under 640px, `40px` from 640px. On a very wide screen the sheet stops at 1400px and the rules fill the rest.

**Dashboard.** No diagonal gutter. The app is white edge to edge, same ink, same lines, same type. The sidebar and the top bar are the header, restated: white, `1px` line `#ededed`, height about `68px` for the top bar. Active nav item is blue text or a blue soft pill. Do not add a dark sidebar.

## Spacing

Section padding: `64px 24px`, then `80px 40px` from 640px, then `96px 48px` from 960px. A section starts with `border-top: 1px solid #ededed`.

Hero padding-top: `88px`, then `112px` from 640px. Side padding matches the section.

Gaps that recur: `8px` between header buttons, `10px` between hero buttons, `16px` inside cards, `28px` under an eyebrow, `36px` between a split heading and the grid under it, `48px` between the two columns of a split from 960px.

Content widths: hero copy `860px`, hero support `680px`, large statement `920px`, section support beside a title `460px`, receipt `720px`, questions `760px`, product stage `1120px` (padding `40px 16px 0`, `72px 72px 0` from 960px).

## Radius

| Thing | Radius |
|---|---|
| Header button | 9px |
| Large button | 10px |
| Card, receipt, step grid, stat, band | 12px |
| Product stage (painted sky) | 24px on the top corners |
| Product window | 28px on the top corners |
| Pill, chip, eyebrow | 999px |
| Chevron circle | 50% |
| Avatar | 50% |
| Diagram hub | 14px |
| Blue node label | 8px |
| Choice chip | 8px |
| Chat bubble | 12px, with the tail corner at 4px |

## Geometry

**Dotted field.** Used under diagrams, step previews, and stat rows.

```css
background-color: #f7f8fa;
background-image: radial-gradient(#d5d8de 0.7px, transparent 0.7px);
background-size: 12px 12px; /* 14px on a wide stat row */
```

**Four-square mark.** An 18px blue mark of four 7px squares with a 4px gap, sitting at the start of a large statement. It is the only ornament, and a page gets it once.

**Grid of cells.** A bordered `12px` grid. Cells share hairlines, they do not each grow their own card shadow. One column, then two from 640px, then four from 960px when there are four steps. The rule between cells is `1px solid #ededed`.

**Numbered list.** `01` `02` `03` in blue Outfit 13px / 500, then the sentence in ink 16px. On two columns, a vertical hairline separates the columns and a horizontal hairline separates the rows.

**Diagram.** White pills with a `1px` ink border, a blue label above each pill (`8px` radius, white text), a `1px` blue wire with a small arrow between pills, a dashed blue drop, and a `54px` ink hub. All of this sits on a dotted field inside a `12px` frame.

**Product window.** A wash behind it (`#f4f8fe` to `#e8effa`, top to bottom). The window is white, top radius `28px`, border `1px solid rgba(157, 157, 157, 0.2)`. The bar has three 10px lights, a centered gray URL chip (`#f6f7f8`, 11px, weight 300, radius 8px), and an optional blue-soft status pill.

## Components

**Header.** Sticky, white, bottom rule `#ededed`, min-height `68px`, padding `12px 16px` then `16px 24px`. Logo at the left. Nav absolutely centered from 960px, gap `28px`, hidden below that. Actions at the right, gap `8px`. Under 640px, hide the secondary button and shrink the logo to 26px.

**Buttons.** No border, no shadow, weight 400, line-height 1. Default: height 36px, padding `8px 16px`, radius 9px, 15px. Large: height 40px, padding `9px 20px`, radius 10px, 16px. Primary is blue with white text. Secondary is gray with ink text. Disabled is gray with muted text and `cursor: not-allowed`. On a dark footer, secondary is `#2e2e2e` with white text. One primary per cluster.

**Eyebrow.** Pill, border `#c9d0da`, padding `5px 10px`, sits above a split section, margin-bottom `28px`.

**Kicker.** Blue, uppercase, tracking `0.1em`, 12px, centered, above a centered title. One kicker per page at most.

**Split.** From 960px, title column `1.15fr` and support column `0.85fr`, gap `48px`, aligned to the end of the text. Below that, stacked with gap `20px`.

**Card on a dotted field.** White, border `#c9d0da`, radius 12px, padding 12px. Title 13px / 500. Meta 12px / 300 muted.

**Receipt.** White, border `#e6e9ee`, radius 12px, max-width 720px. Question row: muted 14px / 300, a 7px blue dot, padding `14px 18px`, bottom rule. Answer: 16px, padding 18px. Source chips underneath.

**Chip.** Pill, border `#c9d0da`, padding `5px 10px`, 12.5px, gap 8px. A source named inside a sentence is blue / 500, not a chip.

**Accordion.** Rows separated by `#ededed`. Summary is 18px / 500, padding `18px 0`, with a 28px circle (border `#c9d0da`) and a 6px chevron. Open rotates the chevron. The answer is muted 15px / 300, max-width 46rem, margin-bottom 18px. The first row of a promise list may start open. Question lists start closed.

**Stat.** On a dotted field, white card, radius 12px, padding `14px 16px`. The figure is display 28px. The label is muted 13px / 300.

**Footer.** `#1e1e1e`, padding `56px 24px 0` then `64px 40px 0`. Title in display, support in `#b9b9b9`. A right-hand label is 11px uppercase tracking `0.1em` in `#9d9d9d`, with a white link under it. The legal row is 13px `#9d9d9d`, with links gap `18px`. Under that, the wordmark is display, `clamp(120px, 26vw, 320px)`, line-height `0.78`, tracking `-0.045em`, filled with a 5px dot grid of `rgba(120, 160, 210, 0.72)` clipped to the letters, and cropped by `overflow: hidden` on the footer so the baseline is cut.

## Motion

Ease: `cubic-bezier(0.23, 1, 0.32, 1)`. The chevron turns in `0.2s`. Page anchor scroll may be smooth. If the user prefers reduced motion, scroll is instant and the chevron does not animate. Do not fade or slide sections in on load.

## Dashboard, same system

Build the inside of the product from these parts. Do not restyle them.

- **Shell.** White canvas. Top bar as the header. A left rail, about 240px, with a right hairline `#ededed`. Rail labels are Outfit 13–15px, muted. The active item is ink or blue. Group labels, if needed, use the blue kicker style at 11px, not a new style.
- **Page title.** Display, 30px, line-height 1.11, ink. One support line under it, 16px / 300, muted, max-width about 46rem.
- **Primary action.** One blue button, top right of the page title row. Secondary actions are gray buttons.
- **Panels.** Radius 12px, border `#ededed` or `#e6e9ee`, no shadow. Separate panels with whitespace (24–36px), not with cards nested in cards.
- **Tables and lists.** Hairline rows `#ededed`. Header text muted 13px / 500. Cell text 14–16px. A status is a chip or blue text, not a colored badge palette.
- **Numbers.** Display face for the figure, Outfit muted for the label, as the stat card. A number that is evidence names its source in blue, the way the receipt does.
- **Empty and diagram areas.** The dotted field. Do not use illustrations.
- **Hold, limit, approval.** Blue. A blocked row can take a `3px` blue inset on the left, the same mark as a guarded message. Do not turn warnings red.
- **Density.** A dashboard may be tighter than the marketing page: 16–24px panel padding, 8px between rows. It may not be louder. Same type sizes, same one blue, same flat surface.

## Do not

- A second accent, a gradient mesh, a shadow under every card, or a dark theme.
- All-caps sentences, or an eyebrow on every section. The pill and the kicker are rare.
- Bold body text. Emphasis inside a sentence is weight 500, or blue when it is a source.
- Icons as decoration. A mark earns its place: the four-square, the blue dot, the chevron, the file outline, the window lights.
- Copy that explains the layout. The type and the lines do that.
