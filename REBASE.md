# REBASE.md — P5 continuation rebase audit (2026-08-25)

Scan of everything written so far against the consolidated delta. Baseline:
no P5 engine code exists yet (Phase 2 had not started at CP-R), so the
conflicts live in (a) the P4 codebase that P5 inherits, (b) PLAN.md's build
list, (c) mockup copy — (c) was fixed in the rider commits.

## Kill-list scan results

| kill-list item | found | disposition |
|---|---|---|
| Shared / value-denominated allowance paths | **None in code** (never built — Part 0 landed before Phase 2). Mockup/fixture traces removed in gate rounds 9+; last stale label ("shared drawdown itemized", index.html) fixed in rider 1 | closed |
| Runtime seller-routing / price-cap logic | **None in code.** P4's gateway maps modelId → ONE registered offering (`gateway/router.ts` — a lookup, not competitive routing; the only "fallback" is the honest non-streaming path, which stays). Planned-but-unbuilt G4 floor-vs-better math and G5 runtime resolution are **deleted from PLAN** before existing | closed |
| Auto-renewal / reset scheduling / "Resets" strings / wait-option | **None in code**; zero "Resets" strings anywhere (wording swept to "Expires" in the gate cycle); fork wait-option removed from mockups + UI-COPY in rider 1 | closed |
| Refund-shaped anything | **Exists in P4 code by design**: `core/deposit-rail.ts`, `seller/tabs.ts`, refund paths in `plugin.ts`, `buyer/actions.ts`, `core/ledger.ts` — the tab rail P5 retires. Disposition per the migration plan: public routes unregistered (404 probes), modules **deleted from the P5 build** (not just dormant — rule 2 is absolute); the P4 ledger archive stays read-only on disk. The per-leg *verifiers* (`buyer/bpe.ts`, stream verifier, recount) are NOT refund-shaped and demote into `dispute/` | executes first in Phase 2 |

## Refactors (P4 modules that survive with changed roles)

- `gateway/router.ts` — keeps modelId→offering lookup; gains: allowance
  admission (per-offering meter check → 402 fork body), **no-fallback error
  semantics** (provider failure ⇒ charge nothing, say so), key budgets.
- `seller/offering.ts` + `seller/model-ka.ts` — publish targets move to the
  **Marketplace Registry CG**; AskCommitment (effectiveFromCycle) added.
- `core/inference-meter.ts` / BPE engines — demoted into `dispute/` +
  spot-checks; also feeds both-sides metering counts.
- `lane/*` — carries **checkpoint gossip** (SWM-only cadence traffic);
  wire-payload role per master prompt.
- `config.ts` — subscription config (period, cadence params 100 calls/15 min
  jittered, compressed-period scaling), `fundingSource` seam.

## New work items the gate cycle created (now in PLAN as G16–G22)

G16 checkpoint service (SWM emitter + verifier, hash-chained running totals,
divergence flagging, interim VM publish only on unresolved divergence, the
freshness line feed) · G17 pair-CG lifecycle (auto-create at first
subscription, membership = exactly the pair) · G18 registry-CG publishers
(Model KAs, offers/asks, tokenizer bundles, cost schedule) · G19 Query Cost
Schedule freeze + parser + guards (admission/delivery split, abort keeps
admission) · G20 provider-switch-at-boundary mechanics · G21 expired state +
start-new-period flow (nothing renews; new period = new consented payment) ·
G22 no-fallback error semantics + I5/I6 invariants + cadence cost audit.

## Calibration watch-items (instrumented from day one)

checkpoint divergence rate + interval fit (tune 100/15) · interim-publish
frequency (I6 "exactly one" in practice) · per-offering ceiling-hit
frequency (the post-RFC pooled-credit argument) · boundary switch requests.

## Documents caveat

`claude-code-prompt-nsm-v5.md` and `cpr-correction-v2.md` (edited outside
the session) were NOT found in ~/Downloads at rebase time. This audit binds
to the continuation prompt's consolidated delta, which declares itself
authoritative. The two files must land in `docs/` and be reconciled against
this audit before Phase-2 engine code is written against Appendix A.
