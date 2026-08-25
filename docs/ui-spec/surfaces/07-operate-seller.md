# Surface 07 — Operate (seller / Hermes-facing)

**Mount:** node UI · Operate · flag `marketplace.enabled` (correction 2026-08-25).

Purpose: the seller's cockpit — the honest gauge, the pending queue, the
margin truth, and a publish wizard whose preview IS the buyer's view.

## Wireframe
```
Earnings → payout                    Offerings
   ╭──────╮  761 µ of 2,941,000     ◇ Qwen2.5 14B ⛓  live  [Edit][Pause]
   │ 0.03%│  Not yet worth settling ◇ GPT-5.4    ☁  live
   ╰──────╯  (fees would exceed it)
Legs                                 ☁ margin
leg_27796e2b  ◷ due in 04:12        upstream est $0.41 · billed $0.38
leg_e1552c0a  ✓ verified 258 µ      reasoning overhead: 9%
Publish wizard: Connect → Price → Preview → Publish
  [ Preview = the exact Catalog card + Model-page row buyers will see ]
```

## Components
ThresholdGauge — radial 270°, animated fill; states/copy exactly:
  <25% → --gauge-low + `gauge.threshold.low`
  25–99% → --gauge-mid + `gauge.threshold.mid`
  ≥100% → --gauge-ready + `gauge.threshold.ready` + enabled Settle action
  tooltip `gauge.threshold.tip` with exact µ figures
LegsTable (state chips shared with Surface 04; ◷ rows show deadline countdown;
`operate.pending.aging` summary) · WithholdMix (mini-bar of reasons, plain
labels) · MarginPanel (☁ only; `operate.margin.reasoning`) · PublishWizard
(Connect→Price→**ListingPreview**→Publish; preview renders the real ModelCard
and ProviderTable-row components with this offering's data — `listing.preview`).

## Data bindings
gauge ← unsettledEarned/threshold from the loopback status projection (never
caller-supplied) · legs ← seller ledger · margin ← upstream estimate vs billed
(operator-only; USD never enters the TRAC ledger) · preview consumes the same
components as Surfaces 02/03 — one source of truth, zero drift.

## States
below-threshold (the honest default) · ready-to-settle · pending queue with
aging · offering paused · upstream unhealthy (☁ rows flagged; serving halted
notice — failed calls create no legs).

## Acceptance
- [ ] Gauge renders 761/2,941,000 (~0.03%) without visual breakage; tooltip exact.
- [ ] ≥100% state exists in gallery with Settle enabled (devnet-forced).
- [ ] ◷ legs count down; deadline miss transitions to voided on screen.
- [ ] ListingPreview is pixel-identical to the buyer-side components (same code).
- [ ] Settle action absent from any public route (404 probe unaffected).

---

## P5 amendment — Operate v5 (seller side of the subscription rail)

New blocks: **AskEditor** (`op.ask.editor` — edits queue for next cycle,
current ask stays visibly in force) · **SubscriberList** (`op.subscribers`:
plan scope, period, consumed vs ceiling per subscriber) · **StatementQueue**
(`op.stmt.queue`: awaiting-signature items with itemized counts; disagree →
dispute panel, same vocabulary as surface 11) · **RevenueWallet**
(`op.revenue.wallet` + `op.revenue.note` — the dedicated subscription wallet
balance, VISIBLY distinct from the ops wallet; the P3 commingling defect made
structurally unrepeatable is a rendered fact, not a footnote) ·
**CalibrationExport** (`op.calibration` button → file download).
The P4 tabs/legs/election blocks are retired from this surface; the ledger
archive remains reachable via a read-only "Prototype 4 archive" link.
Acceptance additions:
- [ ] Ask edit shows both current and next-cycle values simultaneously.
- [ ] Revenue wallet and ops wallet render as two visibly separate balances.
- [ ] Statement queue items itemize units per offering before signing.
- [ ] No tab-era vocabulary outside the archive link.
