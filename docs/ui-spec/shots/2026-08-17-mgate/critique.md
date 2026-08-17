# §Loop critique — M-gate static mockups, 2026-08-17

Scope: `docs/ui-spec/mockups/01…07.html` (static, fixture-driven, labeled as
mockups). Shot at 1440×900 + 390×844 via `mockups/shoot.mjs`. Compared against
`refs/or-*.png` for density/anatomy and each surface's acceptance list.

## Round 1 — found and fixed

| # | Surface | Failure | Fix |
|---|---|---|---|
| 1 | 04 | Receipt-rail drawer too narrow (252px): labels wrapped to 3 lines, mono values clipped past the drawer edge | rail → 1.1×card-min-w; `.drow` flex-wrap + `overflow-wrap:anywhere` on values |
| 2 | 04 | Chips broke across lines (`◷ Waiting for delivery` split; cost chip `258 µ` split) | `.chip`/`.btn` `white-space:nowrap; flex-shrink:0`; `.msg-footer` wraps as a unit |
| 3 | 04 | Chat panes carried ~200px dead vertical space in every non-flagship state | min-height only on the flagship frame |
| 4 | 01 mobile | Copy buttons collapsed to one-character-per-line ("C/o/p/y") beside long snippets | covered by fix #2 |
| 5 | 05 | Tab-row mini-bar floated detached above the action buttons | actions cell → right-aligned stack, bar above buttons |
| 6 | 07 mobile | **Horizontal overflow: 454px document at 390px viewport** (grid children inherit the legs table's intrinsic min-width) | `.cols > * { min-width:0 }`; `.row` wraps ≤480px; measured sweep now 390/390 on all seven |
| 7 | 02/03 | Secondary price line violated the number-display rule (`µTRAC / 1M` math was wrong) | secondary = exact contract terms `2 µ / 6 µ per token`; primary stays `~$X.XX / 1M tokens` |
| 8 | 04 | Receipt chip read `✓ Verified ✓` (icon + `state.verified.short` double-check) | chip renders the table string verbatim |

Verification: post-fix scrollWidth sweep = 390px on all seven at 390-wide
viewport; re-shot both viewports.

## Known limitations, carried to integration (not mockup defects)

- **Logos are `.logo-monogram` fallback everywhere** — licensed pack is a CP3
  deliverable (planned source: lobehub/lobe-icons, MIT; license check due at CP3).
- 07 legs table on mobile wraps its detail column ugly-but-readable; integration
  will collapse detail columns into the row-expand pattern instead.
- Withhold-mix bar exposes reason labels only via tooltip; integration adds an
  inline legend (spec: "plain labels").
- `or-credits.png` ref remains uncaptured (login-gated); Surface 05 leaned on
  the wireframe + tokens only.
- Copy-table gaps found while building are proposed in UI-COPY.md §"Proposed
  additions" (ctl.*, treasury.confirm.*, operate.*, wizard.* …) — they ship only
  if the operator lands that section.
- 0.03% threshold gauge renders a minimum ~2° tick so the arc is visible at all;
  readout carries the honest number.

## Acceptance-list status (mockup-answerable boxes only)

Boxes that require live wiring (KPI events, live quote assertions, revocation
timing, settle-route 404 probe, sort functionality) are integration-phase and
stay open by design. Everything visual/stateful the specs demand is present:
each surface renders its full state set, strings are UI-COPY keys (or proposed
additions), zero color/spacing literals outside tokens.css (mockup CSS is
var()-only), technical truth layered plain-first.
