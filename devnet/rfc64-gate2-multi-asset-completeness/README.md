# RFC-64 Gate 2 — multi-asset completeness evidence contract

A **closed, deterministic** evidence contract that proves multi-asset
completeness: that a receiver's applied row set exactly reproduces an authored
row set, with unique UALs, canonical ordering, matching content/bundle digests
and lengths, exact total count, and an independently recomputed inventory set
root — and that explicitly **rejects** missing, duplicate, and extra rows.

> **Fixture harness only.** `productBoundary` is `not-connected` and
> `gateEvaluation` is `not-evaluated` on every artifact and verdict. This
> contract is not wired to any product runtime, so its output **never asserts a
> real Gate 2 pass**. `fixtureComplete` is a fixture-level property, deliberately
> distinct from any gate disposition.

## Contract

Raw evidence (`raw@1`) and verdict (`verdict@1`) schemas live in
[`src/schema.ts`](src/schema.ts). A row binds `ual`, `contentDigest`,
`contentLength`, `bundleDigest`, `bundleLength`.

The verifier ([`src/verify.ts`](src/verify.ts)) is **fail-closed** — it always
returns a verdict, never throws on bad input — and checks:

- `schemaWellFormed` — exact keys, types, lowercase sha-256 hex, non-negative
  integer lengths; unknown/missing fields are rejected.
- `authored/receivedUniqueUals` — duplicates detected on the raw array, before
  any Map/Set collapse.
- `authored/receivedCanonicalOrder` — the array **as given** equals its sorted
  self (a complete-but-misordered set is still rejected).
- `totalCountMatchesAuthored`, `noMissing`, `noExtra`, `perRowExactMatch`.
- `inventorySetRootMatches` — the root is **recomputed from the received rows**
  ([`src/set-root.ts`](src/set-root.ts), domain-tagged, full-row leaves, sorted)
  and compared to the declared value; the declared field is never trusted.

## Determinism

The generator ([`src/generate.ts`](src/generate.ts)) is a pure function of the
asset count: no clock, randomness, host, or environment input. Output is
canonical ([`src/canonical.ts`](src/canonical.ts): sorted keys, integers only,
lowercase hex, single trailing LF).

## Commands (run from the repo/worktree root toolchain)

```
# typecheck (erasable TS, noEmit)
tsc --noEmit -p tsconfig.json

# mutation test suite (Node built-in runner; no external deps)
node --experimental-strip-types --test test/completeness.test.ts

# generate a fixture / verify one
node --experimental-strip-types src/cli/generate.ts 8
node --experimental-strip-types src/cli/generate.ts 8 | node --experimental-strip-types src/cli/verify.ts

# two-run byte determinism
node --experimental-strip-types src/cli/generate.ts 8 > a.json
node --experimental-strip-types src/cli/generate.ts 8 > b.json
cmp a.json b.json && shasum -a 256 a.json b.json
```

## Verified results (at source commit `19892c1d`)

- `tsc --noEmit`: clean.
- `node --test`: **15 pass / 0 fail** — one per material invariant, each mutated
  artifact still parses so the failure is the targeted invariant.
- Two-run determinism (count=8): byte-identical,
  `sha256 = b5bb0ad3c1b78b67dd19fa785ac7d59bf2f9d123975a8f065d0f8ba3d64b2892`.

## Handoff

To evaluate a real Gate 2, a future adapter feeds authored/received rows from the
live producer/receiver into `generateCompleteFixture`'s place and sets a
`productBoundary`/`gateEvaluation` state machine. Until that adapter exists, keep
the markers `not-connected` / `not-evaluated`; a green fixture is not a gate pass.
