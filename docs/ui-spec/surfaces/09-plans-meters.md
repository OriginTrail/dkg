# Surface 09 — Plans & meters (replaces 05-treasury; the Claude usage idiom)

**Mount:** node UI · Plans · flag `marketplace.enabled` (correction 2026-08-25).

Purpose: the meter is the product. Structural reference: Claude's own usage
screen — scope bars, "X% used", plain reset phrasing, approaching-limit
warning, limit-reached message that offers options. Ref capture:
`refs/claude-usage.png` (operator-supplied; if absent, follow this spec's
anatomy as written). Fixtures: `p5.plan`, `p5.allowances`, `p5.meterStates`.

## Wireframe
```
Plan: 38% used                        Resets in 12 days
[█████████░░░░░░░░░░░░░░░]                    [Top up]
────────────────────────────────────────────────────────
okf-mainnet shared — 1.064 of 2.8 TRAC · any mix of 4 offerings
  [█████████░░░░░░░░░░]  38%
   Qwen2.5 14B: 1.2M tokens · Qwen2.5 7B: 800k tokens
   okf knowledge: 4,200 units
hermes · Qwen2.5 7B (scoped) — 1.2M of 5M tokens
  [█████░░░░░░░░░░░░░░]  24%        Resets in 12 days
────────────────────────────────────────────────────────
This period: our count 1,238,400 · provider count 1,238,400 ✓
Expired at reset (last period): 173,000 µ — value recognized, not returned
```

## Components
PlanBar (headline `meter.plan.headline` + `meter.plan.resets`) ·
AllowanceBar per allowance (shared: value-denominated with itemized lines
beneath — the overall-plus-per-model pattern; scoped: unit bar) ·
WarningState (≥85%: bar → `--gauge-mid`, `meter.warn.approaching`) ·
CeilingFork (100%: `meter.hit.*` — three plain buttons wait/upgrade/top-up,
never a wall) · TopUpGate (`meter.topup.gate`, human-gated, restates
amount/from/to) · ExpiryLine (`meter.expired.journal` + tooltip) ·
StatementLine (see surface 11, embedded here).

## Data bindings
bars ← allowance consumed/ceiling projections · shared bars itemize by
offering with units × frozen ask = value (I5 rendered) · statement line ←
latest period statement · expiry ← `expired` journal entries.

## States
normal · approaching (≥85%) · hit (fork visible) · topup-pending ·
just-reset (bars at 0, expiry line showing) · disputed-statement.

## Acceptance
- [ ] Bar anatomy matches the Claude idiom: per-scope bar, "X% used", plain reset phrase.
- [ ] Approaching state appears at the configured threshold in gallery.
- [ ] The 100% state presents wait/upgrade/top-up as buttons — no dead-end copy anywhere.
- [ ] Shared bar itemizes offerings and the itemized values sum to the bar's consumed value (I5 on screen).
- [ ] Expired value renders with `meter.expired.journal` — never as a refundable amount.
- [ ] 390 px: bars full-width, itemized lines wrap, fork buttons stack.

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
