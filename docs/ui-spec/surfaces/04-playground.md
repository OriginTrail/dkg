# Surface 04 — Playground (streaming chat with the verified chip)

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
