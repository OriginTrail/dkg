# §Loop critique — integrated surfaces, 2026-08-17/18

Scope: the REAL UI (vite dev against live okf-mainnet, `DKG_UI_HOME=~/.dkg-mainnet`),
after surfaces 01–07 integrated one-per-commit. Gallery remains the
every-component×every-state record; these shots are the live shell.

## What the live shots show (real data, real states)

- **operate-desktop**: the flagship live proof — gauge at the honest **0.03%
  (761 µ of 2,941,000 µ)** with `gauge.threshold.low` verbatim, Settle
  disabled, both v3 offerings (Qwen ⛓ / gpt-5.4 ☁) live with monograms,
  REAL leg ids (`leg_e1552c0a`, `leg_27796e2b`…) rendering **Verified ✓**
  chips from countersign records.
- **marketplace-desktop**: onboarding shows err.offline (the live node runs
  the v3 plugin — no `/marketplace/buyer/*` routes; correct until the Phase 3
  buyer node) and the catalog's states.
- **access-desktop**: `empty.keys` + mint modal path; **treasury-desktop**:
  nav + loading (v3 plugin lacks the treasury route — resolves on the v3.5
  node).

## Found and fixed this round

| # | Failure | Fix |
|---|---|---|
| 1 | Every proxied API call crawled (2–25 s): vite forwarded its own Host header and the daemon stalls foreign Hosts; a flat 72-query fan-out then starved the browser's 6-socket limit and discovery never settled | proxy `changeOrigin`; two-stage market sweep (offerings on all graphs → Model-KA/closes only on market graphs) with a 3-wide pool + 12 s per-query timeout |
| 2 | Wrong bearer: the live node's home is `~/.dkg-mainnet`, vite only knew `~/.dkg` | `DKG_UI_HOME` env override |
| 3 | fullPage screenshots clipped to the viewport (shell locks body scroll) | `.nsmx--page` scroll container + shots unlock body before capture |
| 4 | Operate legs all rendered "Checking…" against the v3-plugin node (old `{status}` vs v3.5 lifecycle `{state}`) | compat mapping; operate/status now projects the v3.5 lifecycle + deadline |
| 5 | v3 `legById` event-shadowing class of bug re-checked in UI: chips bind to lifecycle state only, never to row presence | (design, verified in gallery) |

## Known, carried to Phase 3 (devnet rehearsal)

- Loaded catalog/model-page/playground/treasury live shots need the two-seat
  devnet: okf-mainnet's daemon serves browser-context queries too slowly for
  a settled capture, and its v3 plugin lacks the buyer routes. The devnet run
  (CP2) supplies these.
- treasury/access **mobile** shot automation flakes on the second nav click
  (overlay interception in the non-responsive shell); surfaces themselves are
  390px-clean (gallery + measured sweep).
- Wire SSE streaming: scheme + verifier + drills shipped in Phase 1; the
  SSE transport lands next so `play.stream.note` and the mid-stream tamper
  drill run live in rehearsal.
- MarginPanel (☁ upstream-cost) deferred — no upstream cost telemetry exists;
  omitted rather than invented.
- Logos: monogram fallback until the CP3 licensed pack (plan: lobehub/icons,
  MIT — license check at CP3).
