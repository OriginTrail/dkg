# Phase-0 measurement — RandomSampling weighted-CG sampling

- **Network:** `base_sepolia_v10` (chainId 84532) — pre-mainnet; no mainnet deployment exists yet
- **currentEpoch:** 521
- **cgCount (getLatestContextGraphId):** 75
- **active CGs:** 75 / 75  (inactive: 0)
- **CGs with nonzero current-epoch weight:** 8
- **read errors:** 0

## D = currentEpoch − cgLastFinalizedEpoch  (per-CG SLOAD replay depth)

min=1  p50=521  p90=521  p99=521  max=521

| D bucket | CGs |
|---|---|
| 1 | 1 |
| 2-5 | 5 |
| 6-20 | 19 |
| 101-1000 | 50 |

## Weight (active TRAC/epoch) cross-check

- Σ weight (all CGs):    180
- Σ weight (active CGs): 180
- getTotalValueAtEpoch:  180   ✅ matches active Σ

## Worst-case scan cost implied (status quo)
Leading-order draw SLOADs ≈ R·2·Σ(1+(1+D)), R≤5. Plugging in this snapshot: Σ(2+D) over the
75 CGs ≈ **~26.4k SLOADs per scan** (dominated by the 50 CGs at D≈521), and the draw does two
scans → **~52.8k SLOADs ≈ ~110M gas of (mostly cold) reads for a *single* fresh-attempt draw**,
before any CG-retry. That is already at/over a typical block-gas budget — at **N=75**.

---

## Interpretation & decision input

1. **The cliff is real and already present, not just a mainnet projection.** Most CGs are
   dormant *and never finalized* (`cgLastFinalizedEpoch == 0` ⇒ D == currentEpoch == 521), and the
   status-quo draw calls `getCGValueAtEpoch` for **every** active CG — including the 67/75 with
   zero weight — each triggering the full per-epoch replay. The implied ~110M-gas draw at N=75
   means `createChallenge` is plausibly already at the gas wall on testnet. **Follow-up:** confirm
   directly via an `eth_call`/`estimateGas` of the draw path (blocked here by node-identity auth);
   treat the number above as analytic, not measured.

2. **Eligibility ≡ active confirmed (75/75 active).** No CG is inactive, matching the "append-only,
   `deactivateContextGraph` has no callers" premise. A weight-only BIT is sound today — but keep
   **Invariant 2** (`cgWeight>0 ⇒ active`) enforced for the day deactivation is wired up.

3. **Global-total oracle works** (active Σweight == `getTotalValueAtEpoch` == 180). Safe to use as
   the migration/runtime cross-check the RFC specifies.

4. **Open Decision #1 (settlement strategy) → recommend settle-on-miss ONLY for V10; defer the
   keeper and the epoch-due index.** Rationale from the data:
   - Dormancy here manifests as **zero-weight** CGs (67/75). A Fenwick skips zero leaves in the
     O(log) search for free — they're never drawn, never replayed. So the dominant status-quo cost
     (scanning dead CGs) is solved *structurally* by the BIT, independent of settlement.
   - Only 8 CGs carry weight and their sum equals the global total exactly ⇒ **no detectable
     future-dated/extend backlog** (under-statement, the one thing settle-on-miss does *not* heal,
     is not present in this workload). Post-migration, leaves start fresh (D→0 for all), and
     publish-now-then-expire traffic keeps expired CGs at a zero leaf via settle-on-miss.
   - Revisit and add the keeper/epoch-due index only if **mainnet** shows materially different
     behavior: significant scheduled/extended (future-dated) value, or dormant CGs that retain
     *nonzero* weight. Log this as the trigger.

5. **Open Decision #2 (fairness tolerance).** With ~8 weighted CGs the draw is trivially fair;
   propose a concrete bar for the property test: **steady-state per-CG draw frequency within ±2%
   of true active-weight share, and wasted-retry rate < 1%** under a publish/expire/extend workload.
   Adjust once mainnet weight dispersion is known.

6. **BIT_CAPACITY.** ~75 CGs created by epoch 521 ⇒ very low growth. `2^21` (~2.1M) is ample
   headroom; even `2^20` would do. Keep `2^21` for margin.

> **Caveat:** testnet ≠ mainnet scale. The zero-weight fraction and the D tail will likely be
> **worse** on mainnet (more abandoned CGs over a longer history), which only strengthens the case
> for the BIT + the Phase-1 interim finalize-in-prologue stopgap.
