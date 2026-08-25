# Surface 01 — Onboarding card ("two steps, beating their three")

**Mount:** node UI · Plans (empty-plan state; deep-linked from Marketplace CTAs) · flag `marketplace.enabled` (correction 2026-08-25).

Purpose: fresh node → copyable OpenAI snippet, with the KPI clock running.
Refs: `or-credits.png` (balance/top-up presentation), `node-ui-current-dashboard.png`.

## Wireframe
```
┌─ Two steps to your first verified completion ─────────────┐
│ ● 1 Fund ──────────────── ○ 2 Get your key                │
│                                                           │
│  Budget  [ 1.0 TRAC ▾ ]   (~$0.28)                        │
│  ▸ wallet: 1.2500 TRAC ($0.35)                            │
│  [ Set budget ]                                           │
│  This node opens and manages provider tabs for you.       │
└───────────────────────────────────────────────────────────┘
Step 2 swaps the body:
│  Name [ openclaw-main ]   budget cap [ 250,000 µ ▾ ]      │
│  OPENAI_BASE_URL = https://<node>/gateway/v1   [copy]     │
│  OPENAI_API_KEY  = nsm_k_9f3…                  [copy]     │
│  ⚠ Shown once. Store it now.                              │
```

## Components
StepIndicator · BudgetInput (TRAC + USD live subtext) · WalletReadout ·
KeyMintForm (reused by Surface 06) · SnippetBlock (mono, copy buttons) ·
KpiToast (`onboard.kpi`).

## Data bindings
wallet balance ← node wallet API · budget → treasury policy create ·
key mint → gateway keystore (hash at rest; plaintext rendered once, never
persisted client-side) · KPI: emit `ux.kpi.first_run_started` on card mount,
`ux.kpi.first_verified` on first ✓ chip anywhere; delta rendered via
`onboard.kpi` and written to the evidence log.

## States
empty-wallet (`onboard.fund.empty` + address + copy + QR) · funding-pending
(chain confirm spinner, block count) · ready · step2 · done (card collapses to
the KPI toast). Error: wallet API unreachable → `err.offline`, retry.

## Acceptance
- [ ] Fresh node reaches a copyable snippet in ≤ 3 screens, zero jargon strings.
- [ ] USD subtext updates live from the reference rate; FX tooltip present.
- [ ] Key plaintext is unrecoverable after dismiss (verified in gallery state).
- [ ] KPI event pair fires; the measured mm:ss appears in REPORT-v35.
- [ ] 390px width: no horizontal scroll, snippet wraps with copy intact.

---

## P5 amendment — Subscribe → Key (the Fund step is retired)

Step 1 becomes **Subscribe** (`onboard.p5.title`, `onboard.sub.*`): pick a
built-in plan template (ship one or two) or open the composer (surface 08).
Payment gates are per seller (`onboard.pay.gate` / `onboard.pay.line`), each
restating amount/from/to, with `onboard.pay.norefund` always visible at the
gate — the no-refund doctrine is stated before the first payment, not
discovered after. Step 2 (key mint, shown-once) is unchanged. KPI string
becomes "first metered completion". Acceptance additions:
- [ ] No Fund/deposit vocabulary anywhere; a tab-era string is a defect.
- [ ] The no-refund line is on the payment gate itself, not a tooltip.
- [ ] Template preview shows per-seller payment lines before the gate.

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
