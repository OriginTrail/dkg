# Node UI — E2E Test Plan

Working reference for the SDET work on `packages/node-ui`. Built from a manual
walkthrough of the live UI (running against a real DKG daemon) plus a
source-side inventory of every Shell, View, Page, and Modal component.

Run target: `pnpm --filter @origintrail-official/dkg-node-ui test:e2e`
Stack: Playwright + chromium, conventions in [SDET_AGENT.md](SDET_AGENT.md).

## Test infrastructure (live daemon mode)

E2E does **not** use mocks. Each run goes through this lifecycle:

1. **globalSetup** ([e2e/setup/global-setup.ts](../../packages/node-ui/e2e/setup/global-setup.ts))
   - Spawns the DKG daemon in a fresh temp `DKG_HOME` (`dkg start -f` via the
     built CLI at `packages/cli/dist/cli.js`).
   - Waits for `/api/status` to respond on port 9200.
   - Reads the auto-generated bearer token from `auth.token`.
   - Seeds one context graph (`qa-cg`, name `QA Context Graph`) and imports
     one small text file → Working Memory assertion `qa-seed-doc`.
   - Persists the daemon + seed state to `e2e/setup/.daemon-state.json`.
2. **fixtures/base.ts** loads that state and:
   - Injects `__DKG_TOKEN__` into every page via `addInitScript` so the UI's
     mock-detector picks live API mode.
   - Exposes `daemon` and `seed` fixtures to spec authors.
3. **Specs run serially** (workers=1) — the daemon is a singleton on a fixed
   port, so parallel workers would race on shared backend state.
4. **globalTeardown** stops the daemon and removes the temp home.

Prereq: the CLI must be built (`pnpm --filter @origintrail-official/dkg
build`). The harness spawns the built daemon, not source.

## Status legend

- ✅ covered — at least one assertion in an existing spec
- 🟡 partial — surface is touched, key interactions missing
- ❌ missing — no test exists; needs new spec or extension

## Surface map

| Surface | Source | POM | Spec | Status |
|---|---|---|---|---|
| AppShell layout | `Shell/Header.tsx` + `Panel*.tsx` | `app-shell.po.ts` | `shell-layout.spec.ts` | ✅ |
| Header | `Shell/Header.tsx` | `header.po.ts` | `header.spec.ts` | 🟡 |
| Left panel | `Shell/PanelLeft.tsx` | `left-panel.po.ts` | `left-navigation.spec.ts` | 🟡 |
| Center panel | `Shell/PanelCenter.tsx` | `center-panel.po.ts` | `tab-management.spec.ts` | ✅ |
| Right panel | `Shell/PanelRight.tsx` | `right-panel.po.ts` | `agent-panel.spec.ts` | 🟡 |
| Bottom panel | `Shell/PanelBottom.tsx` | `bottom-panel.po.ts` | `bottom-panel.spec.ts` | ✅ |
| Dashboard | `views/DashboardView.tsx` | `dashboard.po.ts` | `dashboard.spec.ts` | ✅ |
| Memory Stack | `views/MemoryStackView.tsx` | — | `memory-layers.spec.ts` | 🟡 |
| Project | `views/ProjectView.tsx` | `project-view.po.ts` | `project-view.spec.ts` | 🟡 |
| Memory Layer | `views/MemoryLayerView.tsx` | `memory-layer.po.ts` | `memory-layers.spec.ts` | 🟡 |
| Settings | `pages/Settings.tsx` | — | — | ❌ |
| Operations | `pages/Operations.tsx` | `operations.po.ts` | `operations.spec.ts` | 🟡 |
| Network | `pages/Network.tsx` | `network-page.po.ts` | `network-page.spec.ts` | ✅ (display-only) |
| Agent Hub | `pages/AgentHub.tsx` | — | covered via agent-panel | 🟡 |
| CreateProjectModal | `Modals/CreateProjectModal.tsx` | `modals/create-project.po.ts` | `create-project.spec.ts` | ✅ |
| JoinProjectModal | `Modals/JoinProjectModal.tsx` | — | — | ❌ |
| ImportFilesModal | `Modals/ImportFilesModal.tsx` | `modals/import-files.po.ts` | `import-files.spec.ts` | 🟡 |
| FilePreviewModal | `Modals/FilePreviewModal.tsx` | `modals/file-preview.po.ts` | — | ❌ |
| ShareProjectModal | `Modals/ShareProjectModal.tsx` | — | — | ❌ |

Cross-cutting: `accessibility.spec.ts` ✅, `theme.spec.ts` ✅,
`keyboard-shortcuts.spec.ts` ✅.

## Locator strategy

All raw selectors live in `e2e/helpers/selectors.ts` under one of these groups:
`app, header, leftPanel, center, bottom, rightPanel, dashboard,
projectView, memoryLayer, memoryStack, settings, operations, network,
modals.create, modals.join, modals.import, modals.preview, modals.share`.

Selector preference order is enforced by [SDET_AGENT.md](SDET_AGENT.md):
`getByRole` → `getByText/Label/Placeholder` → `data-testid` → CSS class.
The `.v10-…` class layer is the fallback today because the React tree leans on
class names for layout and not many elements expose roles cleanly.

When a class is the only stable hook, add a `data-testid` to the source rather
than introducing a new fragile class.

## Coverage gaps to close

Each entry below maps to a TODO in the implementation list. Spec names follow
the existing pattern: kebab-case surface name, `.spec.ts` suffix.

### Settings page — new spec `settings.spec.ts`

Open path: header settings button (also `?tab=settings` query).

Cases:
- LLM card renders, status badge `Not Configured` by default.
- API Key input accepts text, Show toggle reveals/masks the value.
- Model and Base URL inputs accept text.
- Save button enabled only when API Key is set; click triggers save state.
- Disconnect button visible only when configured (mock mock returns config).
- Telemetry section: share-telemetry toggle flips state.
- Local Data Retention dropdown: changing value surfaces Prune & Save / Cancel.
  Cancel reverts. Save opens confirm modal; Confirm closes the modal.
- Developer Mode toggle reveals Observability tab in the page tabs.
- Background Sync Status: dropdown disabled when no CGs; Refresh is clickable.
- Danger Zone: Shutdown Node click changes label to Confirm Shutdown; second
  click invokes the API.
- Node Identity / Blockchain Config show placeholder dashes when offline.

### JoinProjectModal — new spec `join-project.spec.ts` + new POM

Cases:
- Opens from left panel Join Project button.
- Title / subtitle render.
- Invite textarea accepts multiline input.
- Join button disabled until invite code present.
- Invite parser surfaces inline errors:
  - missing project ID,
  - invalid multiaddr,
  - multiaddr without peer ID.
- Cancel and overlay click close the modal.
- Already-subscribed branch: error renders.
- Access-denied branch: Send Join Request button renders.

(Backend-bound branches are stubbed at the API client level if available;
otherwise covered by error-surface assertion only.)

### ShareProjectModal — new spec `share-project.spec.ts` + new POM

Cases:
- Opens from project view Share button.
- Tabs Allowlist / Join Requests render; tab badge shows pending count.
- Allowlist tab:
  - Network agents list renders or shows hidden when empty.
  - Add Agent input rejects non-Ethereum address with inline error.
  - Add Agent input accepts a valid `0x…` address; Add button enables.
  - Allowed agents list shows entries with × remove.
  - Invite Code `<pre>` renders the CG ID; Copy Invite swaps to "Copied".
- Join Requests tab:
  - Empty state renders when none.
  - Approve and Reject buttons appear per request and show busy state on click.

### FilePreviewModal — new spec `file-preview.spec.ts`

Cases:
- Opens from a WM assertion preview link.
- Loading state renders, then metadata (content type, triple count, pipeline).
- PDF renders an `<iframe>`; image renders `<img>`; text renders `<pre>`.
- Binary type shows the fallback message and Download original button.
- Download original button triggers a navigation/download (assert click only).
- Markdown intermediate Download visible only when `mdIntermediateHash` present.
- Close (×) and overlay click both close the modal.

### Project view — extend `project-view.spec.ts`

Open from a populated project (mock has Pharma Drug Interactions).

Cases:
- Layer switcher buttons WM / SWM / VM / Overview / Graph Overview render and
  switching updates the active state.
- Sub-graph bar renders (when seeded); selecting a sub-graph swaps the page.
- Entity detail: clicking an entity link opens the overlay; close button
  dismisses it.
- Share button opens the ShareProjectModal.
- Refresh button click does not throw and shows a transient busy state.
- Graph node click routes via `handleNodeClick` (assert side effect).
- Cross-sub-graph entity navigation updates `activeSubGraph`.

### Memory layer view — extend `memory-layers.spec.ts`

Cases:
- VM tab: search input + field select + limit select; Search button click
  triggers query (assert URL or network call observed).
- SPARQL bar: Run executes; Reset clears the query and re-fetches default rows.
- View toggle (table / graph) updates the active state and swaps the body.
- WM tab: Promote All → SWM disabled when empty; per-assertion → SWM button
  enables when assertion exists.
- SWM tab: Select all checkbox toggles all rows; per-row checkbox flips one row
  state; Publish All / Publish N selected enable based on selection.
- Empty-state copy renders for each layer.

### Memory Stack — extend `memory-layers.spec.ts`

Cases:
- Project name button opens the project tab.
- Each layer cell button (WM / SWM / VM) opens the corresponding layer tab.
- "No visible projects" empty state when all are hidden.

### Header — extend `header.spec.ts`

Cases:
- Settings button click opens the Settings tab.
- Theme toggle button title cycles between "Switch to light mode" and "Switch
  to dark mode" (covered by theme spec; cross-link only).
- Notification dropdown items have a clickable affordance for join_request /
  join_approved type and a non-clickable presentation for others.

### Left panel — extend `left-navigation.spec.ts`

Cases:
- Join Project button opens the JoinProjectModal.
- Project tree row × hide button removes the row from the tree.
- Show hidden projects button surfaces hidden rows back into the tree.
- Project ⤑ toggle moves the project between My / Participating sections.
- Context Oracle mode placeholder copy renders (already partial — just confirm).

### Right panel — extend `agent-panel.spec.ts`

Cases:
- + Add tab opens the add-flow surface.
- OpenClaw add-flow shows Connect button + Docs / Release Notes links.
- Connect button shows busy state on click.
- When connected: Refresh and Disconnect buttons render.
- Chat composer:
  - Project select dropdown lists available projects, disabled when none.
  - Attach files button is hidden file input → assert click triggers input.
  - Textarea accepts text; Enter without Shift triggers Send (assert disabled
    state flip or input clearing).
  - Send button disabled when textarea empty.
- Network refresh button click does not throw.
- Sessions list: when populated, clicking a session item routes / loads.

### Operations — extend `operations.spec.ts`

Cases:
- Type filter, Status filter, Search input change values and trigger re-render.
- Phase row expand toggles details visible / hidden.
- Performance sub-tab: period select + granularity select change values.
- Operations / Hardware sub-toggle within Performance switches sub-view.
- Errors sub-tab: error hotspot row click expands a nested failed ops list.
- Copy buttons swap to "Copied" for ~1s on click.

### Import files — extend `import-files.spec.ts`

Cases:
- Drag-over highlights the dropzone (`.drag-over` class).
- Drop event adds files to the list (use Playwright `setInputFiles` on the
  hidden input — drag-drop simulation is brittle).
- × on a file row removes it from the list.
- Progress bar renders while uploading (mock the API to delay).
- Results summary surfaces success and failure counts.
- Done button closes the modal after upload completes.

### Notifications — confirmed gap inside header

- Items with type `join_request` are clickable and dispatch `setActiveProject`
  + open project tab. Items with other types are presentational only.

### Tab management — defer

`tab-management.spec.ts` already covers the meaningful cases. The visual close
× icon test is low value — skip for now.

## Out of scope (for now)

- Resize handle drag — Playwright drag is flaky and the behaviour is
  non-critical for shipping.
- Visual regression / screenshot diffing — separate effort.
- Axe / WCAG scan — separate effort under `accessibility.spec.ts`.
- M-of-N on-chain VM publish — costs gas; the seed creates a WM assertion
  but does not promote-and-publish to chain.
- OpenClaw integration chat composer — requires an actual OpenClaw gateway
  to be installed and connected. Add coverage once the seed boots one.

## Working notes

- The dev server runs on port 5173 (Vite via `webServer`). The daemon runs
  on 9200 via `globalSetup`. If you see port-in-use errors, kill stray
  `node ... cli.js start` or `vite` processes from a prior interrupted run.
- The seed gives you exactly: 1 user CG (`qa-cg` / "QA Context Graph"), 1
  system CG (`agents` / "Agent Registry"), and 1 WM assertion (`qa-seed-doc`).
  Adjust the seed if you need more — don't fake it in the spec.
- The Settings page reflects the live daemon: ONLINE banner, real Peer ID,
  real chain ("Unknown" until a chain is configured), real wallet addresses.
  Most assertions there should not check exact values, just structural
  presence.
- The right panel chat composer is conditional on a selected integration.
  With no integrations connected, only the add-flow surface renders. Add
  OpenClaw install to the seed (or make a separate integration spec gated
  on its presence) to unlock those tests.

## Definition of done

- Every row in the surface map is ✅.
- New POMs follow the `kebab-case.po.ts` / `PascalCasePage` convention from
  [SDET_AGENT.md](SDET_AGENT.md).
- Selectors centralised in `helpers/selectors.ts`.
- Fixtures registered in `fixtures/base.ts` for every new POM.
- `pnpm --filter @origintrail-official/dkg-node-ui test:e2e` is green over
  five consecutive runs.
