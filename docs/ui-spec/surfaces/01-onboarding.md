# Surface 01 — Onboarding card ("two steps, beating their three")

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
