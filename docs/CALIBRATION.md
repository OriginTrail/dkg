# CALIBRATION.md — the P5 telemetry export (Stage 2's raw material)

`node packages/marketplace/dist/cli/calibration-export.mjs [DKG_HOME]`
emits `nsm-calibration/1` JSON for one seat, built ONLY from journals the
seat already keeps — nothing new is measured.

## Schema (`nsm-calibration/1`)

| field | meaning |
|---|---|
| `periods[]` | one entry per plan/period: `volumes[]` per (offering, seller) in native units against guaranteed ceilings; `unusedAllowanceRatio` (Σ unused value ÷ Σ paid, frozen asks); `ceilingHits` (exhausted meters — the future argument for/against a post-RFC pooled credit); `switchRequests` (boundary switches queued — is one-provider-at-a-time chafing?); `perKey` (I2's per-key unit attribution) |
| `askDistribution[]` | every committed ask with its effective cycle |
| `buyerConcentration` | pair count + top-pair unit share (wash-trading watch input) |
| `statements` | total/agreed/disputed/resolved + dispute rate |
| `checkpoints[]` | per pair: emitted count, last agreed seq, divergence rate — the 100-calls/15-min interval-fit evidence |

## Watch-items instrumented (argue later, per the continuation prompt)

checkpoint divergence rate + interval fit · interim-publish frequency (I6's
"exactly one" in practice — audit via `checkI6` against VM publish records) ·
per-offering ceiling-hit frequency · provider-switch requests at boundaries.

Both seats export; Phase-5 runbook asks Hermes to share his export back.
