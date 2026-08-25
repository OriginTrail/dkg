# CORRECTION — the journeys live in the DKG node UI (2026-08-25)

Operator course correction applied mid-Phase-1. This file records the audit
(taken BEFORE migration), the mount map, and what was thrown away.

## 1. Audit — every user-facing surface and its mount at correction time

| surface | built | mount at audit time | verdict |
|---|---|---|---|
| MarketplaceV35View (catalog · model page · playground · treasury · access tabs) | P4 | **inside the node UI bundle** — `PanelCenter` tab `marketplace`, flag-gated nav in `PanelLeft` | component mount correct; **serving deviation**: P4 journeys ran it through a vite dev server (`:5175`, `DKG_UI_HOME=~/.dkg-v35-buyer`) instead of the buyer node's own baked `/ui` bundle |
| OperateV35View | P4 | node UI bundle, tab `marketplace-operate`; deployed in okf's installed dist-ui at `:9200/ui` | correct |
| v3-era Marketplace view in okf's installed dist-ui | P1/v3 | `:9200/ui` (stale bundle) | superseded; replaced when P5 bundle deploys |
| P5 mockups (10 pages: onboarding, composer, catalog, model page, meters, statement, storefront, playground, operate, runthrough index) | P5 Phase 1 | `docs/ui-spec/mockups/p5/` on `file://` — M-gate dev artifacts | mount N/A (dev tooling, sanctioned exception 4) — but **shell-less**, violating new rule 12; corrected below |
| `/dev/gallery` | P4 | dev route in node UI | sanctioned exception 4 |

No other user-facing surface exists. No P5 engine code exists yet (Phase 2
not started), so nothing server-side needed migration.

## 2. Mount map (node UI primary navigation, flag `marketplace.enabled`)

| nav entry | contains | notes |
|---|---|---|
| **Marketplace** | catalog → model pages → node storefronts → **playground as a tab** | playground stays under Marketplace — matches the existing P4 IA (it was already a Marketplace tab); proposed, per the correction, rather than beside Agents |
| **Plans** (new) | allowance bars + per-offering breakdowns · plan composer · statement line · top-up / 402 fork · **Subscribe→Key onboarding as the empty-plan state** (deep-linked from Marketplace "Add to plan" CTAs) | replaces the Treasury tab |
| **Access** | keys (promoted from a Marketplace tab to primary nav per the correction's default map) | |
| **Operate** | ask editor · subscriber list · statement queue · revenue wallet · calibration export · P4 archive link | existing entry, v5 content |

Flag off ⇒ no nav entries, routes 404. Flag on ⇒ all four present.

## 3. What was migrated, what was thrown away

- **Thrown away: routes only, and only prospectively.** No component, token,
  or copy key was discarded. The P4 views were already node-UI views.
- The vite dev server is **demoted to dev-only** (gallery + mockup host).
  Doctrine: journeys are exercised against the node's own `/ui` bundle;
  Phase-3 evidence shots must show node chrome.
- P5 mockups gained the **node UI shell frame** (PanelLeft-style sidebar +
  header + primary nav with active states) and were re-shot; the CP-R
  contract now includes the mounting.
- New fixture-suite probe (Phase 2, G13): **no user-journey page served from
  any port or path outside the node UI**; dev routes carry no product nav.

## 4. Paper-trail updates

- `CLAUDE-APPENDIX.md`: rules 11 (journeys mount in the node UI) and
  12 (mockups wear the shell) appended.
- Surface specs 01–11: `Mount:` line added per the map above.
- `PLAN.md` re-stamped (G11 names node-UI mounts; G13 gains the probe).
- Hermes's P5 runbook (Phase 5) will reference node-UI paths only.

## 5. Convergence pass (same day, operator follow-up)

The first shell was a generic dashboard frame — not the DKG node UI. Rebuilt
faithfully from `refs/node-ui-current-*.jpg` (header, left rail, center
tab-chips, Node Log dock, Agents panel) with Layer-1 tokens rebased to the
node UI's neutral palette. Every mockup shot now shows the actual product
chrome; Phase-3 integration inherits real components instead of a facsimile.

## 6. Rider lesson (CP-R closure, 2026-08-25)

The gate cycle changed the design (Part 0 removed the pool) and one label
didn't follow: the runthrough index still advertised "shared drawdown
itemized" after the surface it described had stopped doing that. Rule-5
class: a status that changed without its re-stamp. Fixed with a full
sibling sweep (also caught: two fork wait-options after the expiry doctrine
killed waiting, three runtime-routing copy lines after provider choice moved
to plan time). Standing consequence: `copy-probe.mjs` makes string keying
greppable, and design-delta sweeps now grep mockups AND docs, not just the
surface that changed.
