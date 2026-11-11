# Node UI design system

The rules behind the node UI's look and behaviour. The values live in code; this file explains what each one is for, so the next screen uses them the same way.

- **Tokens:** `src/ui/styles/00-theme.css` (colours per theme, then the shape and size scale)
- **Components:** `src/ui/components/ds/` (`Button`, `Badge`, `Count`, `LayerBadge`, `ContextGraphChip`) plus `AgentChip` and `AgentDot`
- **Component CSS:** `src/ui/styles/27-ds-components.css`, loaded last
- **Reference page (development only):** run `pnpm dev:ui` and open <http://127.0.0.1:5173/ui/design-system.html>. It renders every token and component live in both themes. `vite build` only bundles `index.html`, so the page is not part of the released UI.
- **Checks:** `test/design-tokens.test.ts`, `test/class-has-css.test.ts` and `test/design-docs.test.ts` (see [Checks](#checks))

## Principles

1. **Dark first.** Most operators use dark mode. Design and review in dark, then check light. Every colour token has a value for both.
2. **One hue, one job.** A colour means one thing everywhere. If something needs to stand out and has no job of its own, use contrast and weight, not a new colour.
3. **The shape says what it is.** A layer is a pill, a value or role is a 6px tag, a status is an icon and text with no box, things you click are rectangles, things you open carry a mark (tile or avatar).
4. **Use the scale.** Corners, heights and type sizes come from the tokens. A value that isn't on the scale is either a new rule (add it here and to the tokens) or a mistake.
5. **Make the complex readable.** Show the state that matters (which layer, who wrote it, does it need me) before the details.

## Colour

All colours are CSS variables. Never write a hex value in a component: use the token for the job. If no token fits, add one to both themes in `00-theme.css` and describe it here.

| Job | Tokens | Rule |
|---|---|---|
| Surfaces | `--bg-root` → `--bg-panel` → `--bg-surface` → `--bg-elevated` → `--bg-hover` → `--bg-active` | Each step is one level closer to the user. Don't skip levels for emphasis. |
| Borders | `--border-subtle`, `--border-default`, `--border-strong`, `--border-prominent`, `--border-control` | Default for outlines; strong for hover and selected; prominent only where 3:1 against any surface is needed. |
| Text | `--text-primary`, `--text-secondary`, `--text-tertiary` | Primary for what you read first, secondary for body text, tertiary for metadata. `--text-ghost` is decoration only, never readable text. |
| Memory layers | `--layer-working`, `--layer-shared`, `--layer-verified`, each with `-text`, `-bg`, `-border` | Reserved for the three memory layers: slate for Working, OriginTrail cyan for Shared, OriginTrail purple for Verifiable. Nothing else uses these hues. The canvas (graph-viz) reads the same values from `layer-colors.ts`. |
| Signals | `--text-success`, `--text-warning`, `--text-danger` (+ `--accent-green/amber/red` for non-text) | State only: done, needs attention, failed. Amber means "needs your action" (unread, pending requests). Red means an error, never a count. |
| Actions | `--accent-primary` / `--text-on-primary`, `--accent-vm` / `--text-on-vm` | Primary button is white on black in dark mode. Purple fills exactly one kind of button: Publish to Verifiable Memory. |
| Role and access | `--role`, `--role-text`, `--role-bg`, `--role-border` | Facts about you and the graph (curator, participant; public, curated, private). The role you hold is a tinted badge; access is an outline. |
| Links | `--text-link`, `--link-underline` | Links are text colour with an underline. Blue is not a link colour. |
| Focus | `--focus-ring` | Keyboard focus only, always as a 2px ring. Not a link colour, not a layer. |
| Data | `--data-1`, `--data-2`, `--data-3`, `--data-4`, `--data-5`, `--data-6`, `--data-7`, `--data-8` | Charts and context graph identity colours. Use in this fixed order; never cycle within one chart. Separation between neighbours is validated in both themes. |
| Signal tints | `--success-bg`, `--warning-bg`, `--danger-bg` (+ `-bg-strong`, `-border`) | Washes of the signal accents for notices, result cards and highlighted rows. Text on them uses the matching `--text-*` signal. Mixed from the accents, so they follow the theme. |
| Neutral tints | `--tint-faint`, `--tint-subtle`, `--tint-strong` | Hover rows, wells, tracks and inline code. A wash of the text colour, so they read in both themes (white-alpha disappears in light mode). |
| Elevation | `--shadow-xs`, `--shadow-sm`, `--shadow-menu`, `--shadow-popover`, `--shadow-lift`, `--shadow-modal`, `--shadow-drawer`; `--scrim`, `--scrim-strong`, `--shade` | One shadow per kind of surface: sm for hovered cards, menu for dropdowns and floating panels, popover for popovers, lift for raised graph cards, modal for dialogs, drawer for side sheets. Scrim dims the page behind a modal or drawer; shade darkens an expanded row or inset well. |
| Identity fallback | `--identity-fallback`, `--text-on-identity` | The colour an agent, cell or sub-graph shows before its own identity colour is known, and text on identity fills. |
| Log viewer | `--log-bg`, `--log-text`, `--log-meta`, `--log-timestamp`, `--log-module`, `--log-error`, `--log-error-bg`, `--log-warn` | The terminal well on Observability, which stays dark in both themes. Nowhere else. |

**Canvas colours.** graph-viz draws on a canvas and can't read CSS variables. Graph views take a plain `GraphPalette` for an explicit theme (`graphPalette(theme)` in `graph-palette.ts`, or `useGraphPalette()` in a component) and pass it to the option builders; `test/graph-palette.test.ts` keeps its values in step with the tokens.

**Contrast.** Readable text clears 4.5:1 on the surface it sits on, in both themes; non-text marks (icons, layer bars, borders that carry meaning) clear 3:1. `browser-regressions/shell/badge-contrast.spec.ts` checks the main pairs and every badge and count on every surface, reading colours from the browser (`pnpm --dir packages/node-ui test:e2e:shell`).

## Type

Instrument Sans for the interface, JetBrains Mono for identifiers (DIDs, UALs, hashes), queries and code.

| Token | Size | Use |
|---|---|---|
| `--fs-display` | 24 | Page totals, hero numbers |
| `--fs-heading` | 18 | View titles |
| `--fs-title` | 16 | Card and section titles |
| `--fs-body` | 14 | Reading text |
| `--fs-control` | 13 | Buttons, tabs, inputs, menus |
| `--fs-label` | 12 | Badges, table headers, metadata |
| `--fs-micro` | 11 | Small badges and counts; the floor, no text is smaller |

Every font size is one of these tokens, in CSS and inline styles alike. Agent dots size their initials from the dot, and never below the 11px floor. Canvas renderers that take a number say so in a comment.

Type sizes are whole pixels, here and in nOS. Sentence case everywhere, including buttons, tabs and badges. Names keep their capitals: Working Memory, Shared Working Memory, Verifiable Memory, Knowledge Asset, Publisher Conviction. Uppercase is only for small section kickers.

## Shape and size

### Corners

| Token | px | Use |
|---|---|---|
| `--radius-hair` | 2 | Thin bars, tracks, swatches, scrollbars, inline code |
| `--radius-xs` | 4 | Menu rows, segments inside a segmented control |
| `--radius-control` | 6 | Buttons, inputs, selects, filter chips |
| `--radius-nested` | 8 | Anything inside a card (stat cells, notes, legends, tables); menus and popovers |
| `--radius-card` | 10 | Cards and panels |
| `--radius-overlay` | 12 | Dialogs and overlays |
| `--radius-pill` | full | Layer badges, counts, entity and agent chips |

`50%` is fine for things that are circles (avatars, dots). Use the `.ds-overlay`, `.ds-card` and `.ds-card-nested` classes for new surfaces.

### Heights

| Token | px | Use |
|---|---|---|
| `--h-badge-sm` | 18 | Small badges in dense rows and tables |
| `--h-badge-md` | 22 | Default badges |
| `--h-control-sm` | 24 | Compact controls: toolbars, log filters, sidebar actions, entity chips |
| `--h-control-md` | 32 | Default buttons, inputs and selects |
| `--h-control-lg` | 40 | The main call to action on an empty state or dialog |

Controls placed side by side share a height.

## Components

### Button

`<Button variant size icon>`, the only button. Existing markup can use the classes it renders directly: `ds-btn` plus `ds-primary` / `ds-ghost` / `ds-danger` / `ds-swm` / `ds-vm`, and `ds-sm` / `ds-lg` / `ds-icon`.

| Variant | Use |
|---|---|
| `primary` | The single main action in a view. At most one per view. |
| `secondary` | Default. |
| `ghost` | Low emphasis: toolbars, dismiss, icon buttons. |
| `danger` | Destructive. Red outline, red tint on hover, never a red fill. |
| `swm` | Share to Shared Working Memory (cyan tint). |
| `vm` | Publish to Verifiable Memory (the one purple fill). |

Sizes `sm` 24, `md` 32 (default), `lg` 40. `icon` makes it square; an icon-only button always has an `aria-label`.

### Labels: Badge, LayerBadge, Count

A badge states a fact (status, role, type, layer). It is never the click target.

- `<Badge tone>`: `success`, `warning`, `danger` and `pending` draw as a status (icon and text, no box, as in nOS). Pending is a neutral clock for work under way; amber is only for something that needs attention. Badge draws the icon: pass `icon` for a chip with its own glyph, or `icon={null}` for none. Use `<Badge>`, not raw classes, or the status has no icon. `neutral` (default), `muted`, `role` and `kind` draw as a tag (6px rectangle, as in nOS) and keep their colours (`kind` is for entity types: a neutral tag with the kind's colour as a dot). `size="sm"` in dense rows. `dot` adds a leading status dot.
- Status words match nOS: `Done`, `In progress`, `Failed`, `Ready` (`Ready to connect` stays), `Partial`, `Pending`, `Blocked`. `Partial` is also the word for an agent with one capability down.
- The header status says only what the node reports: `Connecting` before the first status, `Connected` with the peer count (green), `No peers` (warning), and `Unavailable` (red) after three failed status checks in a row. Settings shows the same status. `/api/status` has no sync state, so the header does not say Synced.
- `<LayerBadge layer="wm|swm|vm">`: the one way to show which memory layer something is in (open circle Working, two circles Shared, filled hexagon Verifiable). Layers look the same as in nOS, which is the source of truth: same colours, glyphs, full border and 12px text. `LayerGlyph` draws the glyph on its own.
- `<Count value tone>`: numbers on tabs, sections and buttons. `attention` (amber) only when the number needs the user's action; `quiet` inside tabs and chips.
- The notification count sits on the bell's corner, never over the glyph, and the bell brightens while anything is unread.

### Navigation

- **Underline tabs** (`.ds-tab`) say where you are: 12px medium, tertiary text, the active tab in primary text with a 2px underline. Main bars 36px, sub-bars inside a view 32px. Memory layer tabs underline in their layer colour.
- **Segmented control** (`.ds-seg` + `.ds-seg-item` with `aria-pressed`) switches what a panel shows (Agents / Network / Sessions; table / graph). Not for navigation between places.
- **Filter chips** (`.ds-filter` with `aria-pressed`) are things you set: a 6px rectangle, never a pill.

### Things you open

A leading mark says "this opens":

- **Context graph:** `<ContextGraphChip>`, a monogram tile in the graph's data colour plus the name, in a pill.
- **Agent:** `<AgentChip size>` (24 / 28 / 40) with a circle of initials, and `<AgentDot>` / `<AgentDotStack>` for avatars alone. Agents are drawn the same way in the graph canvas.

### Small screens

- Under 860px the side panels float over the page: both start closed, one opens at a time, and a tap outside closes it.
- The header keeps OriginTrail in view: the full wordmark on wide screens, the mark beside DKG under 860px. Under 600px, Connected shows as its icon and the peer count; other statuses keep their word.
- Tables go inside `.ds-table-scroll` so they scroll within their card. Wide tables add `.ds-table-pin` to keep the first column in view.
- A view that must stack when side panels leave it little room uses `.v10-center-content[data-narrow]`, set below 560px of content width.

### Inputs

`.ds-input` for text fields, selects and text areas: 6px corners, 32px tall (`.ds-sm` 24px) to match the buttons beside them, 12px text, one focus ring. The chat composer is a card, not an input.

## Navigation and tabs

The centre of the app works like browser tabs:

- **Places** are the node's fixed screens (Dashboard, Observability, Publisher Conviction, Settings). They live in the sidebar: Dashboard at the top, the rest in the Node group. The header holds status, notifications, theme and panel toggles only, no navigation.
- **Things you open** (a context graph, an agent, a PCA) open as tabs next to the current one.
- Every tab has a web address (`src/ui/lib/tab-routes.ts`): `/`, `/observability`, `/settings`, `/conviction`, `/graph/<id>`, `/agent/<graph>/<slug>`, `/pca/<n>`. Back, forward, refresh and bookmarks land on the same tab.
- Open tabs, their order, the active tab and recently closed tabs are saved in the browser (`stores/tabs.ts`) and restored on refresh.
- Tabs can be dragged or moved with Ctrl+Shift+←/→, closed with ×, middle-click or Delete, and reopened from the ⌄ menu. Dashboard is pinned first.

## Other tokens

Every token in `00-theme.css` is listed in this file, and `test/design-docs.test.ts` fails when one isn't.

| Group | Tokens | Use |
|---|---|---|
| Layer colours | `--layer-shared-bg`, `--layer-shared-border`, `--layer-shared-text`, `--layer-verified-bg`, `--layer-verified-border`, `--layer-verified-text`, `--layer-working-bg`, `--layer-working-border`, `--layer-working-text` | Fills, outlines and text for the memory layers |
| Signal variants | `--accent-amber`, `--accent-blue`, `--accent-red`, `--danger-bg-strong`, `--danger-border`, `--danger-stripe`, `--success-bg-strong`, `--success-border`, `--text-danger-hover`, `--text-info`, `--text-on-accent`, `--warning-bg-strong`, `--warning-border` | Stronger washes, outlines and text for the signals |
| Layout and scale | `--accent-vm-hover`, `--font-mono`, `--font-sans`, `--fs-layer`, `--header-h`, `--tab-h`, `--toolbar-h` | Fixed shell heights and the remaining scale steps |

## Changing the system

- **A value:** edit the token. Everything using it updates.
- **A rule:** change this file, the token or component, and the reference page in one PR. The design owner in `.github/CODEOWNERS` reviews it.
- **Something new:** add it to `src/ui/components/ds/`, not to one page, and describe it here.
- **Layers and status words:** nOS is the source of truth, and nothing keeps the two repos in step automatically. A change there needs a matching PR here.

## Checks

`test/design-tokens.test.ts` runs with the normal test suite and fails when the node UI has:

- a hard-coded colour (hex, `rgb()`, `hsl()`) in a stylesheet other than `00-theme.css`, or anywhere in component code, including `var()` fallbacks, gradients and shadows;
- a hard-coded corner size (`border-radius` / `borderRadius` in px) instead of a `--radius-*` token. `0` and `50%` (circles) are allowed.

There are no exceptions. If no token fits, add one (see below). Canvas palettes (`*-colors.ts`) are the only code allowed literal colours, because graph-viz can't read CSS variables.

## Adding to the system

1. Check the reference page first: most needs are covered by an existing token or component.
2. A new colour or size is a new token in `00-theme.css`, with a value for both themes and a line in this file saying what job it does.
3. A new component goes in `components/ds/` with its CSS in `27-ds-components.css`, and a section on the reference page.
4. Put the shared classes on the element (`ds-btn ds-primary ds-sm`, `ds-tab`, `ds-seg-item`, `ds-filter`, `ds-card`, `ds-card-nested`, `ds-input ds-sm`, or render `<Button>`) and keep the screen's own class only for layout. `27-ds-components.css` holds the shared rules and never lists screen classes; a screen that needs a variation refines it in its own stylesheet (`test/button-classes.test.ts` and `test/ds-classes.test.ts` check both directions).
