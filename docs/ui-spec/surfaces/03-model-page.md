# Surface 03 — Model page (provider-variant table)

**Mount:** node UI · Marketplace · flag `marketplace.enabled` (correction 2026-08-25).

Purpose: OpenRouter's model detail, with reputation that means something.
Refs: `or-model-detail.png` (column anatomy/density).

## Wireframe
```
◇ Qwen2.5 14B Instruct        Qwen · text · 32k context · Q4_K_M
────────────────────────────────────────────────────────────────
Provider        Price /1M      Class  TTFT   tok/s  Via     Up  
0x633E…(okf)    ~$0.95 2µ/6µ   ⛓      380ms  42     direct  ●   [Try]
0x9A21…(hermes) ~$1.05 2µ/7µ   ⛓      510ms  35     lane    ●   [Try]
  └ rep: 4 verified · 0 disputed   (popover: model.rep.tip)
```

## Components
ModelHeader (logo-lg, chips: family/modality/context/quant) · ProviderTable
(sortable: price, TTFT, tok/s) · RepPopover · UptimeDot · TransportTag ·
RowActions (`model.buy`, `model.try`).

## Data bindings
variants = offerings where modelRef = this Model KA · price/endpoint from
**live signed quote per row** (fetch on expand; KA literal never rendered) ·
rep ← close KAs per provider (`model.rep`, popover `model.rep.tip`) · TTFT &
tok/s ← local telemetry store (this node's own measurements; "no data yet" if
unmeasured — never invent) · uptime ← probe cache (`model.uptime.*`).

## States
loading · quote-unverifiable (row shows "Terms couldn't be verified" +
disabled actions — unverifiable ≠ pass) · provider-unreachable (dot red,
actions disabled, lane-only providers show reachability via lane) ·
no-telemetry-yet.

## Acceptance
- [ ] okf-mainnet and Hermes render as two rows of ONE table, sortable.
- [ ] Every row's price/endpoint provably sourced from a live quote (code path
      asserted in test; KA apiBase literal absent from the DOM).
- [ ] Rep popover shows the disputes-are-evidence copy verbatim.
- [ ] A row with a failed quote verification cannot be bought or tried.
- [ ] TTFT/tok/s show em-dash + "no data yet" before first measurement.

---

## P5 amendment — covered/not-covered seller rows

Each per-seller row gains a covered state (chip: remaining allowance under
that seller) or an **Add to plan** action — comparing and switching sellers
of one model is a browsing act, not a config file. The two-seller Qwen 7B
case (okf + hermes) is the fixture centerpiece. Ask column shows committed
ask; queued changes render as `store.ask.next`. Acceptance additions:
- [ ] A model with two sellers shows both rows with independent covered states.
- [ ] Add to plan deep-links into the composer with the seller pre-pinned.
