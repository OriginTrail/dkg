# Node UI design system

The rules behind the node UI's look and behaviour. The values live in code; this file explains what each one is for, so the next screen uses them the same way.

- **Tokens:** `src/ui/styles/00-theme.css` (colours per theme, then the shape and size scale)
- **Components:** `src/ui/components/ds/` (`Button`, `RetryButton`, `Toggle`, `Badge`, `Count`, `LayerBadge`, `ContextGraphChip`) plus `AgentChip` and `AgentDot`
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
| Borders | `--border-subtle`, `--border-default`, `--border-strong`, `--border-prominent`, `--border-control` | Default for outlines; strong for hover and selected; prominent only where 3:1 against any surface is needed. Drag and resize markers (panel handles, the tab drop marker) use prominent, never a signal, role or focus colour. |
| Text | `--text-primary`, `--text-secondary`, `--text-tertiary` | Primary for what you read first, secondary for body text, tertiary for metadata. `--text-ghost` is decoration only, never readable text. |
| Memory layers | `--layer-working`, `--layer-shared`, `--layer-verified`, each with `-text`, `-bg`, `-border` | Reserved for the three memory layers: slate for Working, OriginTrail cyan for Shared, OriginTrail purple for Verifiable. Nothing else uses these hues. The canvas (graph-viz) reads the same values from `layer-colors.ts`. |
| Signals | `--text-success`, `--text-warning`, `--text-danger` (+ `--accent-green/amber/red` for non-text) | State only: done, needs attention, failed. Amber means "needs your action" (pending requests). Red means an error, never a count. |
| Actions | `--accent-primary` / `--text-on-primary`, `--accent-vm` / `--text-on-vm` | Primary button is white on black in dark mode. Purple fills exactly one kind of button: Publish to Verifiable Memory. |
| Role and access | `--role`, `--role-text`, `--role-bg`, `--role-border` | Facts about you and the graph (curator, participant; public, curated, private). The role you hold is a tinted badge; access is an outline. Blue means this and nothing else: not links, not focus, not info notices (use a neutral surface). |
| Notifications | `--notify`, `--text-on-notify` | The unread count on the bell, and nothing else. A brand purple kept apart from `--layer-verified` and `--accent-vm`, so it doesn't read as Verifiable Memory. |
| Links | `--text-link`, `--link-underline` | Links are text colour with an underline. Blue is not a link colour. |
| Focus | `--focus-ring` | Keyboard focus only, always as a 2px ring. Not a link colour, not a layer. |
| Data | `--data-1`, `--data-2`, `--data-3`, `--data-4`, `--data-5`, `--data-6`, `--data-7`, `--data-8` | Charts and Context Graph identity colours. Use in this fixed order; never cycle within one chart. Separation between neighbours is validated in both themes. |
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
| `--fs-heading` | 18 | Page titles, through `PageHeader` |
| `--fs-title` | 16 | Card and section titles |
| `--fs-body` | 14 | Reading text |
| `--fs-control` | 13 | Buttons, tabs, inputs, menus |
| `--fs-label` | 12 | Badges, table headers, metadata |
| `--fs-micro` | 11 | Small badges and counts; the floor, no text is smaller |

Every font size is one of these tokens, in CSS and inline styles alike. Agent dots size their initials from the dot, and never below the 11px floor. Canvas renderers that take a number say so in a comment.

Type sizes are whole pixels. Every size is one of these tokens; weights are 400, 500, 600 and 700. Uppercase text uses `--ls-caps`, and other text has no tracking. Large numbers use `--fs-display`. Sentence case everywhere, including buttons, tabs and badges. Names keep their capitals: Edge, Core (only the role: Core node, Edge node), Context Graph, Working Memory, Shared Working Memory, Verifiable Memory, Knowledge Asset, Publisher Conviction. Uppercase is for small section kickers and for card and chart titles.

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

### Spacing

Padding, margins and gaps use `--space-2`, `--space-4`, `--space-6`, `--space-8`, `--space-12`, `--space-16`, `--space-20`, `--space-24` and `--space-32`. 10 and 14 only appear inside the nested padding tokens and older rules, and a test stops that number growing.

### Card padding

| Token | px | Use |
|---|---|---|
| `--pad-card` | 16 | Cards and their header and body |
| `--pad-compact` | 12 | Small cards in a dense grid: `<StatTile label value sub />`, chart tiles |
| `--pad-nested` | 10 / 14 | Anything inside a card |
| `--pad-nested-sm` | 8 / 10 | Small nested rows and notes |

`ds-card` sets the corner, not the padding, because a card with a header or a table pads its parts instead: use `padding: 0` on the card and `--pad-card` on the parts. Never write a card's padding as a number.

### Heights

| Token | px | Use |
|---|---|---|
| `--h-badge-sm` | 18 | Small badges in dense rows and tables |
| `--h-badge-md` | 22 | Default badges |
| `--h-control-sm` | 24 | Compact controls: toolbars, log filters, sidebar actions, entity chips |
| `--h-control-md` | 32 | Default buttons, inputs and selects |
| `--h-control-lg` | 40 | The main call to action on an empty state or dialog |
| `--h-row` | 28 | Sidebar rows |

Controls placed side by side share a height.

Two parts of larger components sit off this scale on purpose: a tab's close mark is 20, and the round attach and send buttons inside the chat composer are 28. Round is only for those two; every other clickable thing is a rectangle.

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

Sizes `sm` 24 (11px text), `md` 32 (default, 12px text), `lg` 40. `icon` makes it square; an icon-only button always has an `aria-label`. Text that acts like a button is a `ghost` button, not a bare `<button>`. A button keeps at least 8px from the text above or below it.

### Icons

One set, one icon per job:

- **Lucide** (`lucide-react`) for actions and things: `X` closes, `RefreshCw` refreshes and retries, on every Refresh and Retry button, `Copy` copies, `ChevronRight` and `ChevronDown` expand, `BadgePercent` means a discount.
- **`LayerGlyph`** for memory layers. Nothing else uses those shapes.
- **`StatusGlyph`** for success, warning, danger and pending, including inside a sentence.

Sizes: 12 in small buttons, badges and labels, 14 in controls, rows, buttons and headers, 16 for standalone icons such as empty states. The layer glyph is the one exception: it drops to 10 inside a small badge. Icons take the text colour. An icon-only button always has a name.

No emoji or Unicode symbols as icons: they change from one platform to the next and can't take a size or colour. `test/icons.test.ts` enforces this. Text arrows in a sentence or link (`→`, `←`, `↗`) are typography and stay. Subgraph marks are the exception: they are text from the project profile, so their defaults (`⊚`, `⊘`, `•`) stay text.

A control's plus or arrow is an icon, not a typed character. A link that leaves the app ends in `<ExternalMark />`. Arrows inside a sentence stay as text.

### Toggle

`<Toggle checked busy aria-label>`: an on/off setting that takes effect straight away. On is the primary action colour, not green: it isn't a success. Use a checkbox when the choice is applied by a later button press. Checkboxes and radios use `accent-color: var(--text-primary)`.

### Labels: Badge, LayerBadge, Count

A badge states a fact (status, role, type, layer). It is never the click target.

- `<Badge tone>`: `success`, `warning`, `danger` and `pending` draw as a status (icon and text, no box). Pending is a neutral clock for work under way; amber is only for something that needs attention. Badge draws the icon: pass `icon` for a chip with its own glyph, or `icon={null}` for none. Use `<Badge>`, not raw classes, or the status has no icon. `neutral` (default), `muted`, `role` and `kind` draw as a tag (6px rectangle) and keep their colours (`kind` is for entity types: a neutral tag with the kind's colour as a dot). `size="sm"` in dense rows. `dot` adds a leading status dot.
- Status words: where nOS and the node UI show the same state, they use the same word: `Done`, `Failed`, `Ready` (`Ready to connect` stays), `Partial`, `Pending`, `Blocked`. `In progress` is the one exception: nOS says `Running`, which reads wrong on a task. Words only one product has are free. `Partial` is also the word for an agent with one capability down.
- The header status says only what the node reports: `Connecting` before the first status, `Connected` with the peer count (green), `No peers` (warning), and `Unavailable` (red) after three failed status checks in a row. Settings shows the same status. `/api/status` has no sync state, so the header does not say Synced.
- `<LayerBadge layer="wm|swm|vm">`: the one way to show which memory layer something is in (open circle Working, two circles Shared, filled hexagon Verifiable). Layers look the same as in nOS: same colours, glyphs, full border and 12px text. `LayerGlyph` draws the glyph on its own.
- `<Count value tone>`: numbers on tabs, sections and buttons. `attention` (amber) only when the number needs the user's action; `quiet` inside tabs and chips. The bell's unread count is the one exception: a solid `--notify` disc.
- The notification count sits on the bell's corner, never over the glyph, and the bell brightens while anything is unread.

### Navigation

- **Underline tabs** (`.ds-tab`) say where you are: 12px medium, tertiary text, the active tab in primary text with a 2px underline. Main bars 36px, sub-bars inside a view 32px. Memory layer tabs underline in their layer colour.
- **Segmented control** (`.ds-seg` + `.ds-seg-item` with `aria-pressed`) switches what a panel shows (Agents / Network / Sessions; table / graph). Not for navigation between places.
- **Filter chips** (`.ds-filter` with `aria-pressed`) are things you set: a 6px rectangle, never a pill.

- **The right panel** expands over the centre area for longer agent work; going to another place brings it back. Network shows who you're connected to; Observability's Network tab shows how.
- **Breadcrumbs** (`<Breadcrumbs items />`) lead back from deep views: a document, agent, memory layer, Knowledge Asset or PCA. Top-level pages have none, and there are no separate back buttons.

### Things you open

A leading mark says "this opens":

- **Context Graph:** `<ContextGraphChip>`, a monogram tile in the graph's data colour plus the name, in a pill.
- **Agent:** `<AgentChip size>` (24 / 28 / 40) with a circle of initials, and `<AgentDot>` / `<AgentDotStack>` for avatars alone. On an agent's own page, `<AgentTitle>` shows the avatar beside the page title, with no pill and no link. Agents are drawn the same way in the graph canvas.

### Small screens

- Under 860px the side panels float over the page: both start closed, one opens at a time, and a tap outside closes it.
- The header keeps OriginTrail in view: the full wordmark on wide screens, the mark beside DKG under 860px. Under 600px, Connected shows as its icon and the peer count; other statuses keep their word.
- Tables go inside `.ds-table-scroll` so they scroll within their card. Wide tables add `.ds-table-pin` to keep the first column in view.
- A view that must stack when side panels leave it little room uses `.v10-center-content[data-narrow]`, set below 560px of content width.

### Inputs

`.ds-input` for text fields, selects and text areas: 6px corners, 32px tall (`.ds-sm` 24px) to match the buttons beside them, 12px text, one focus ring. A field with `aria-invalid` gets a `--accent-red` border, and the message beside it says what's wrong. A combobox stays neutral until something is picked, because unfinished isn't wrong. The chat composer is a card, not an input.

## Navigation and tabs

The centre of the app works like browser tabs:

- **Places** are the node's fixed screens (Dashboard, Memory stack, Observability, Publisher Conviction, Settings). They live in the sidebar: Dashboard and Memory stack at the top, the rest in the Node group. Between them, New and Join sit above two collapsible lists, My Context Graphs and Public Context Graphs. The header holds status, notifications, theme and panel toggles only, no navigation.
- **Things you open** (a Context Graph, an agent, a PCA) open as tabs next to the current one.
- Every tab has a web address (`src/ui/lib/tab-routes.ts`): `/`, `/observability`, `/settings`, `/conviction`, `/graph/<id>`, `/agent/<graph>/<slug>`, `/pca/<n>`. Back, forward, refresh and bookmarks land on the same tab.
- Open tabs, their order, the active tab and recently closed tabs are saved in the browser (`stores/tabs.ts`) and restored on refresh.
- Tabs can be dragged or moved with Ctrl+Shift+←/→, closed with ×, middle-click or Delete, and reopened from the ⌄ menu. Dashboard is pinned first.

## Other tokens

Every token in `00-theme.css` is listed in this file, and `test/design-docs.test.ts` fails when one isn't.

| Group | Tokens | Use |
|---|---|---|
| Layer colours | `--layer-shared-bg`, `--layer-shared-border`, `--layer-shared-text`, `--layer-verified-bg`, `--layer-verified-border`, `--layer-verified-text`, `--layer-working-bg`, `--layer-working-border`, `--layer-working-text` | Fills, outlines and text for the memory layers |
| Signal variants | `--accent-amber`, `--accent-red`, `--danger-bg-strong`, `--danger-border`, `--danger-stripe`, `--success-bg-strong`, `--success-border`, `--text-danger-hover`, `--text-on-accent`, `--warning-bg-strong`, `--warning-border` | Stronger washes, outlines and text for the signals |
| Layout and scale | `--accent-vm-hover`, `--font-mono`, `--font-sans`, `--fs-layer`, `--header-h`, `--tab-h` | Fixed shell heights and the remaining scale steps |

## Changing the system

- **A value:** edit the token. Everything using it updates.
- **A rule:** change this file, the token or component, and the reference page in one PR. The design owner in `.github/CODEOWNERS` reviews it.
- **Something new:** add it to `src/ui/components/ds/`, not to one page, and describe it here.
- **Retiring a class or token:** remove it in the PR that replaces it, with no deprecation period. Nothing outside this package reads these names, but its e2e tests do, so change their selectors in the same PR.
- **Layers and status words:** the layer badge stays the same in nOS and here, so the layers are recognisable across both products, and shared states use the same status word (see Labels). Neither product leads, and nothing keeps the two repos in step automatically, so a change in either needs a matching PR in the other. The WM, SWM and VM colours are the only colours the two UIs share. Other colours, type and spacing don't need to match nOS and shouldn't be forced to.

### Names kept for now

A class or token that has to outlive its replacement is listed here with the reason, and `test/retired-names.test.ts` allows it. Remove the line when the name goes.

None today.

## Checks

`test/design-tokens.test.ts` runs with the normal test suite and fails when the node UI has:

- a hard-coded colour (hex, `rgb()`, `hsl()`) in a stylesheet other than `00-theme.css`, or anywhere in component code, including `var()` fallbacks, gradients and shadows;
- a hard-coded corner size (`border-radius` / `borderRadius` in px) instead of a `--radius-*` token. `0` and `50%` (circles) are allowed.

There are no exceptions. If no token fits, add one (see below). Canvas palettes (`*-colors.ts`) are the only code allowed literal colours, because graph-viz can't read CSS variables.
- `test/icons.test.ts`: one icon set, and the refresh icon on Refresh and Retry buttons.
- `test/a11y-rules.test.ts`: names, keyboard access, dialog names and focus rings.
- `test/feedback-states.test.ts`: loading copy, empty states, the disabled look and form errors.
- `test/data-format.test.ts`: shared formats and table scrolling.
- `test/layout-tokens.test.ts`: layers, breakpoints, motion and line height.
- `test/retired-names.test.ts`: stylesheet classes no markup uses, tokens nothing reads, and e2e selectors for classes that are gone.

## Adding to the system

1. Check the reference page first: most needs are covered by an existing token or component.
2. A new colour or size is a new token in `00-theme.css`, with a value for both themes and a line in this file saying what job it does.
3. A new component goes in `components/ds/` with its CSS in `27-ds-components.css`, a section on the reference page, and a row in the page's state matrix (`design-system-states.tsx`) if it's interactive.
4. Put the shared classes on the element (`ds-btn ds-primary ds-sm`, `ds-tab`, `ds-seg-item`, `ds-filter`, `ds-card`, `ds-card-nested`, `ds-input ds-sm`, or render `<Button>`) and keep the screen's own class only for layout. `27-ds-components.css` holds the shared rules and never lists screen classes; a screen that needs a variation refines it in its own stylesheet (`test/button-classes.test.ts` and `test/ds-classes.test.ts` check both directions).

## Data display

Read formats from `lib/format.ts`, so a value looks the same on every screen.

| Value | Use | Shows |
| --- | --- | --- |
| Address, hash, peer ID | `truncateAddress(value, head, tail)` | `0x3489…E47D`, with the full value in a tooltip |
| Date and time in full | `formatDateTime(value)` | `Nov 5, 2026, 2:03 PM`, for tooltips and detail rows |
| Time in a dense row | `formatTime` (`hooks.ts`) | Time today, weekday this week, date after that |
| Count | `formatNumber(value)` | The reader's own digit grouping |
| Node role | `formatNodeRole(role)` | `Core`, `Edge` |
| Percentage from basis points | `formatBps(bps)` | `25%`, `12.5%` |
| File size | `formatBytes(bytes)` (`hooks.ts`) | `1.2 MB` |
| TRAC and ETH | `formatTrac`, `formatEth` | Token amounts with their tooltip |

A missing value is `—`. Chart axes and ISO dates on the subgraph timeline set their own format.

Tables use `data-table` inside `ds-table-scroll`, so a wide table scrolls inside its card, and add `ds-table-pin` when the first column names the row. Figures use tabular numbers so they line up.

Every table header looks the same: `--fs-label`, weight 500, uppercase with `--ls-caps`, in `--text-tertiary`, so the data reads first. The shared rule in `27-ds-components.css` sets it; a table's own rule sets padding and borders only. A table that isn't a `data-table` puts `ds-table-head` on its header cells.

## Layout and overlays

**Pages.** A page is a `ds-page` that starts with `<PageHeader title description badge />`. The header holds the page's only `h1`, at `--fs-heading` weight 600, with a `--fs-body` description in `--text-secondary`. The content panel sets the gutter with `--page-gutter`, so a page adds no padding of its own. `--page-max` caps the width. A page of text and forms adds `ds-page-narrow` (`--page-max-narrow`), so its actions stay close to the words they belong to. A view that fills the panel edge to edge cancels the gutter with a negative margin of the same token.

**Layers.** Each layer has a token, and anything above 10 uses one. Numbers up to 10 only order things inside one component.

| Token | Value | For |
| --- | --- | --- |
| `--z-raised` | 20 | Floats inside a view, such as the node panel |
| `--z-banner` | 30 | The token prompt |
| `--z-panel` | 40 | Side panels floating on small screens |
| `--z-header` | 100 | The header |
| `--z-popover` | 200 | Menus, popovers and the notification pane |
| `--z-modal` | 1000 | Dialogs and drawers |
| `--z-floating` | 1100 | Menus that can open over a dialog |
| `--z-skip` | 10000 | The skip link |

**Overlays.** A dialog or drawer sits on `--scrim`, uses `--radius-overlay` and `--shadow-popover`, and takes `useModalDismiss`. A menu closes on Escape and on a click outside.

**Tooltips.** Use the native `title` for extra detail, such as a full address behind a shortened one. Nothing that needs reading lives only in a tooltip, because touch and keyboard users can't reach it, and a tooltip is never a control's name.

**Breakpoints.** Use 600, 720, 860 and 920. The Context Graph tab bar has its own fitting steps at 1180, 1320 and 1500.

**Motion.** `--motion-fast` (.12s) for hover and press, `--motion-base` (.15s) for things that appear or move, `--motion-slow` (.3s) for larger changes.

**Line height.** `--lh-tight` for headings and chips, `--lh-snug` for dense rows, `--lh-body` for reading text, `--lh-loose` for long notes. A single-line control can use `1`.

## Feedback states

Every view that waits on data shows one of four states, and says which.

| State | Use | Rule |
| --- | --- | --- |
| Loading | `<Loading label="Loading peers…" />`, `block` to fill a view | Name what's loading and end with `…`. `EmptyState busy` when a sentence of context helps. |
| Empty | `<EmptyState title description actions />`, `compact inline` inside a card | Centre it when it fills a view or pane; align it left inside a card or sidebar. Say what will appear, or what to do next. One line of text is enough inside a list. |
| Error | `EmptyState tone="danger"` for a view, `role="alert"` on `v10-modal-error` inside a form, `aria-invalid` on a field | Say what failed and offer a way forward. Retry is `<RetryButton size>` (small by default, `md` beside a default-size button) and sits outside the message, below it or beside it, never inside the sentence or box. Never leave a view loading after a failure. |
| Disabled | `disabled` on the control | `--opacity-disabled`, the one disabled look. Say why nearby when the reason isn't obvious. |

## Accessibility

The target is WCAG 2.2 AA. `test/a11y-rules.test.ts` checks the first four rules below from the code.

- **Names:** every control has a name. An icon-only button has an `aria-label`, and a form control has a `<label>` or an `aria-label`. A placeholder or `title` isn't a name.
- **Keyboard:** everything clickable works from the keyboard. Use a `<button>` first. A row holding other controls puts a `ds-row-open` button on its title, and a table row uses `pressable()`.
- **Focus:** keyboard focus always shows the 2px `--focus-ring`. A control revealed on hover is also revealed on focus.
- **Dialogs:** every dialog has a name and uses `useModalDismiss`, which moves focus in, keeps it there, closes on Escape and returns focus on close.
- **Targets:** at least 24 by 24, the small control height. The exceptions are a tab's close mark, which is documented above, and text links with clear space around them.
- **Agent initials:** black or white, whichever reads better on the agent's colour (`agentInitialsColor`). One of the two always clears 4.5:1, in the UI and on graph nodes.
- **Motion:** `prefers-reduced-motion` turns animation and transitions off everywhere.
- **Skip link:** a "Skip to content" button at the start of the page moves focus to `#main-content`.
