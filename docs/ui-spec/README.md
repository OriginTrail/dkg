# NSM v3.5 UI Spec Pack

This directory is the **authority for everything visual** in the marketplace UI.
Claude Code: read this file, then `CLAUDE-APPENDIX.md`, before writing any UI code.

## The seven mechanisms, compiled

| # | Mechanism | Where it lives |
|---|---|---|
| 1 | Reference screenshots | `refs/` (+ `refs/README.md` for capture & annotation rules) |
| 2 | Design tokens as law | `tokens.css` |
| 3 | Copy written by the operator | `UI-COPY.md` (string table — the only source of UI text) |
| 4 | Per-surface specs: wireframe, states, bindings, acceptance | `surfaces/01…07` |
| 5 | Self-screenshot loop | this file, §Loop |
| 6 | Mockup-approval gates | this file, §Gates |
| 7 | Persistent rules | `CLAUDE-APPENDIX.md` → append to repo-root `CLAUDE.md` |

## §Loop — look at your own work before showing a human

1. `npm run ui:gallery` — a `/dev/gallery` route must render **every component in
   every state**, driven by `fixtures.json` (real numbers from REPORT-v3: the
   761 / 2,941,000 threshold, the 258 µ leg, conservation 1,000,000 = 761 + 999,239,
   each withhold code, a pending-delivery leg with deadline).
2. `npm run ui:shots` — Playwright captures every surface **and** the gallery at
   1440×900 and 390×844, into `docs/ui-spec/shots/<date>/`.
3. Compare against `refs/` and the surface's acceptance list. Write
   `shots/<date>/critique.md`: what fails, why, fix plan.
4. Fix. Repeat until every acceptance box checks.
5. Only then present to the human. A surface never seen by its own author at
   mobile width is not done.

## §Gates — approval before integration

For each surface `01…07`, in order:

- **M-gate:** build a **static HTML mockup** (tokens.css + UI-COPY strings +
  fixture data, no wiring) and post its screenshot for operator approval —
  in-thread or at the checkpoint. Corrections here cost minutes.
- Approved → integrate into the node UI. **One surface per commit**, commit
  message links its shot.
- Definition of done per surface: all acceptance boxes checked · gallery entries
  exist for its states · shots archived · zero strings outside `UI-COPY.md` ·
  zero color/spacing literals outside `tokens.css`.

## Non-negotiables (duplicated in CLAUDE-APPENDIX on purpose)

- Endpoints render **only** from the live signed quote, never the offering-KA literal.
- Screenshots in any report are of the **real running UI with real data** — a
  mockup presented as live is a fabrication (mockups are labeled as mockups).
- Logos: local, license-checked assets from `assets/model-logos/` with monogram
  fallback. Never hotlink. Never copy pixels from `refs/`.
- Technical truth is never hidden, only layered: plain words first, exact
  µTRAC / digests / codes one reveal deeper.

## Phase 2 amendment (paste into the v3.5 prompt)

> Phase 2 executes against `docs/ui-spec/`: tokens.css is law, UI-COPY.md is the
> only source of strings, each surface follows its spec file and passes its
> M-gate as a static mockup before integration, and the §Loop
> (gallery + Playwright shots + critique) runs before anything is shown to the
> human. Reference screenshots must be present in `refs/` before catalog work
> starts — if the operator hasn't supplied them, ask at CP0.
