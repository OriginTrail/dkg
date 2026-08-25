# Surface 04 — Playground (streaming chat with the verified chip)

**Mount:** node UI · Marketplace (playground tab — existing IA) · flag `marketplace.enabled` (correction 2026-08-25).

Purpose: the flagship demo — every message an audited receipt. OpenRouter's
chat, plus what it cannot copy.
Refs: `or-chat.png` (layout only).

## Wireframe
```
┌ models ─┐ ┌───────────────────────────────┐ ┌ receipt rail ─┐
│ ◇ Qwen  │ │ user ▸ Explain recounting     │ │ leg_e1552c0a  │
│ ◇ GPT5.4│ │ ◇ Qwen2.5 ▸ token streaming…  │ │ ✓ Verified    │
│ [+ cmp] │ │   ▁▂▃ chunks verifying…       │ │ 258 µ ~$0.0001│
└─────────┘ │ ┌─────────────────────────┐   │ │ counts 42/29  │
            │ │ 258 µ  [✓ Verified]     │   │ │ sig ✓ close ▸ │
            │ └─────────────────────────┘   │ │ Basescan ▸    │
            └───────────────────────────────┘ └───────────────┘
```

## Components
ModelSwitcher (grouped, badged) · ChatPane (streaming) · MessageFooter
(CostChip + StateChip) · ReceiptDrawer (labels from `receipt.*`; drawer rows:
plain label left, mono value right) · CompareSplit (2 models, same prompt,
two receipts) · ReroutedToast (`state.rerouted`).

## Data bindings
send → gateway (implicit node key) with transport chosen by router
(interactive → direct if offered, else lane) · stream frames render live;
`play.stream.note` under the bubble; chunk-digest chain accumulates; final leg
→ recount → chip transitions checking→verified/blocked · StateChip binds to
leg.state exactly: checking / verified / pending / blocked / voided · drawer
binds every `receipt.*` row to the leg record; close row appears after B8;
Basescan link after settlement/refund txs exist.

## States (all in gallery, all reachable in rehearsal drills)
streaming · checking · verified · **pending-delivery with live deadline
countdown → auto-transition to verified on late delivery (the v3-incident
drill, on screen, no user action)** · blocked (plain string first, code in
drawer, `withhold.explain` beneath) · voided · rerouted (toast; failed try
shows "cost nothing") · compare mode · 402-unfunded (`err.402.unfunded` with
Treasury link).

## Acceptance
- [ ] A streamed ⛓ completion shows ✓ landing AFTER the final chunk recount —
      timing visibly honest, not decorative.
- [ ] Delayed-delivery drill: ◷ chip with countdown resolves to ✓ unattended.
- [ ] Tamper drill renders `withhold.overbill` string; E_OVERBILL only in drawer.
- [ ] Every chip opens the drawer; every drawer reaches Basescan when txs exist.
- [ ] Compare mode shows two independent receipts for one prompt.
- [ ] No raw error code, digest, or µTRAC-first string in the primary layer.

---

## P5 amendment — allowance-in-context, chips retired

Streaming stays. The per-message verified chip is retired; each response
carries a subtle served-by line (`play.servedby`: "via okf-mainnet ⛓") so
routing stays transparent without ceremony. The model switcher shows
remaining allowance beside every model (`play.remaining`). A mid-chat
ceiling hit renders the 402 fork INLINE in the conversation
(`play.fork.inline` + the three `meter.hit.*` buttons) — never a dead end.
Query calls show `play.query.cost` with the units basis one reveal deeper.
Acceptance additions:
- [ ] No verified/checking chips anywhere in the P5 playground.
- [ ] The inline fork renders inside the conversation flow at fixture 100%.
- [ ] Served-by line names seller + provenance class on every response.

## CP-R revision (D1–D12, 2026-08-25)
See UI-COPY.md §CP-R revision for the binding strings. Applied here: default
journey = 3 interactions w/ ONE consent (D1) · "NN% left" chip grammar (D2) ·
USD-only primary, TRAC at consent only (D3) · composer collapses to
budget+template+Confirm with Advanced holding pooling/max-price/pins (D4) ·
fork = Top up + one line (D5) · banned-term purge (D6) · D7 expiry line ·
segmented pool bars w/ --usage-seg-*/--usage-query tokens + plain legend
(D8) · sparkline + one pace sentence per pool, amber early-exhaustion state
(D9) · playground before/after linkage w/ Pool chip (D10) · Recent-activity
list, key-filterable, on Plans (D11) · Access restored to nav + runthrough
(D12).
