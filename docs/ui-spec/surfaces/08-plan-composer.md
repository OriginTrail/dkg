# Surface 08 — Plan composer (where a human chooses between sellers)

**Mount:** node UI · Plans · flag `marketplace.enabled` (correction 2026-08-25).

Purpose: allocate a period budget across models and query services; sellers
resolve automatically under the price cap or are pinned by hand. The brief's
"independent asks become competition instead of homework."
Refs: `or-models.png` (row anatomy), fixtures `p5.asks`, `p5.plan`.

## Wireframe
```
Compose your plan                       Period [monthly ▾]
Period budget [ 3.6 TRAC ]  ≈ $1.01
────────────────────────────────────────────────────────
okf-mainnet                              [shared ●|scoped ○]
  ✓ Qwen2.5 14B ⛓   0.6µ/tok (~$0.17/1M)
  ✓ Qwen2.5 7B ⛓    0.35µ/tok   seller: auto (price cap 0.4µ)
  ✓ gpt-5.x ☁       1.1µ/tok
  ✓ okf knowledge    15.24µ/query-unit · CGs: neurosymbolic…, odysseus
  ≈ up to 4.6M Qwen tokens or 183k query units — any mix
hermes                                   [scoped ●]
  ✓ Qwen2.5 7B ⛓    0.30µ/tok
  At least 5M tokens at your price cap — more if routed cheaper
────────────────────────────────────────────────────────
This plan pays 2 providers: okf-mainnet 2.8 TRAC · hermes 0.8 TRAC
Prices are frozen for the period. Changes take effect at the next reset.
                                   [Review payments →]
```

## Components
BudgetInput (TRAC + USD subtext) · PeriodPicker (`composer.period.note`
always visible) · SellerGroup (one card per seller; shared/scoped toggle per
seller — shared recommended per brief) · LivePreview (`composer.shared.preview`
/ `composer.scoped.preview`, recomputed on every change from frozen asks) ·
PaymentsSummary (`composer.payments` — one line per seller, exact TRAC) ·
GuaranteeLine (`composer.guarantee`).

## Data bindings
asks ← verified offer KAs (committed ask + nextCycle) · preview = allocation ÷
frozen ask per offering; shared preview shows the any-mix restatement ·
payments = Σ per seller · price-cap input bounds auto seller resolution.

## States
empty (no offerings discovered) · composing · preview-live · at-gate (each
payment restated amount/from/to, human-gated) · editable-at-boundary (mid-cycle
view is read-only except top-up).

## Acceptance
- [ ] Preview numbers recompute live and equal ceiling math the engine will use (allocation ÷ ask).
- [ ] Shared vs scoped toggle changes the preview restatement text accordingly.
- [ ] Per-seller payment lines sum exactly to the period budget.
- [ ] Ask shown is the committed ask; a queued next-cycle ask renders as `store.ask.next`, never applied early.
- [ ] 390 px: seller groups stack, toggle stays reachable, preview never truncates numbers.

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

## Part-0 revision (2026-08-25): separate meters
The shared value-denominated pool is REMOVED from P5. Per-offering meters in
native units only; one display-only "Plan overall" readout line (never a
limit); composer Advanced = max price + pinning (pool toggle gone); the
segmented bar is superseded by one plain bar per offering, each with
sparkline + one pace sentence. Nav: Plans/Access/Operate are collapsible
children of "Neurosymbolic Marketplace".
