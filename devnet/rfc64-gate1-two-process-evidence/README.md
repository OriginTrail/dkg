# RFC-64 Gate 1 — two-process evidence contract

A **closed, deterministic, service-independent** evidence contract for Gate-1
two-process runs. It defines the exact JSON shape a producer/receiver pair must
emit, and a fail-closed verifier that **recomputes** the entire digest chain from
the evidence and rejects any artifact whose declared values, cross-peer
readback, forged-author outcome, or restart outcome disagree with it.

> **Evidence contract only.** `productBoundary` is `not-connected` and
> `gateEvaluation` is `not-evaluated` on every artifact and verdict, and both are
> stamped by the verifier from constants — never copied from input. This contract
> never spawns, drives, or observes a real node, so its output **never asserts a
> real Gate 1 pass**. `fixtureConsistent` is a fixture-level property,
> deliberately distinct from any gate disposition.

## Scope

Per the task constraints, **no receiver, persistence, or service source is
touched**. "Two-process" describes the *shape of the evidence* — two distinct
peer records — and restart-repair, forged-author zero-activation, and applied
inventory readback are evidence fields the verifier validates for presence and
**cross-peer consistency**, not behaviours this harness executes. Wiring a real
two-node run is the job of a future collector that emits `raw@1` documents into
this verifier.

## The seven required dimensions → 19 named checks

Each check is a single material invariant with a dedicated mutation test.

| Dimension | Checks |
| --- | --- |
| peer IDs | `peerIdsPresent`, `peerIdsDistinct`, `forgedAuthorPeerDistinct` |
| head/row/bundle/content digests | `contentDigestMatches`, `bundleDigestMatches`, `rowDigestMatches`, `headDigestMatches` |
| UAL | `ualCanonical` |
| exact quad/count | `quadsCanonicalOrder`, `quadsUnique`, `quadCountExact` |
| applied inventory readback | `appliedInventoryMatchesProducer`, `appliedRowCountExact` |
| forged-author zero-activation | `forgedAuthorZeroActivation`, `forgedAuthorHeadUnchanged` |
| restart repair | `restartHeadStable`, `restartNoDoubleApply`, `restartQuadCountStable` |

Plus `schemaWellFormed`. `fixtureConsistent` is derived by folding over
`GATE1_CHECK_KEYS`, so a check added to the type can never be silently omitted
from the verdict (asserted by a test).

## Digest chain ([`src/digests.ts`](src/digests.ts))

Every stage is domain-separated and versioned, so no digest can collide with
another stage or with a bare content hash:

```
contentDigest = H(content-domain ‖ count ‖ sorted quad-leaf digests)
bundleDigest  = H(bundle-domain  ‖ {bundleLength, contentDigest})
rowDigest     = H(row-domain     ‖ {ual, contentDigest, bundleDigest, bundleLength, quadCount})
headDigest    = H(head-domain    ‖ {previousHeadDigest, rowDigest, headSequence})
```

The content commitment is order-independent (sorted leaves, explicit count
prefix), while the evidence array itself must **already be in canonical order** —
so a complete-but-misordered quad set is still rejected.

## What the verifier refuses to trust

- **Declared digests.** All four are recomputed and compared.
- **Cross-peer agreement.** The receiver readback is compared against the
  *recomputed* producer state, so a receiver colluding with a forged producer
  digest is still rejected (tested).
- **A steady-but-wrong head.** Forged-author and restart records must not merely
  hold `before === after`; both endpoints must equal the recomputed applied head
  (tested for both).
- **The boundary markers.** Stamped from constants in `verify.ts`; an artifact
  claiming `productBoundary: "connected"` fails to parse and still yields an
  honest verdict.

The verifier **always returns a verdict and never throws**, including on
`undefined`, primitives, arrays, and null-prototype objects.

## Commands

The contract has **no dependencies** (only `node:crypto`, `node:assert`,
`node:test`). Typecheck needs the monorepo toolchain (`@types/node` + TypeScript
from a repo-root `pnpm install`):

```
# typecheck (erasable TS, noEmit)
tsc --noEmit -p tsconfig.json

# mutation test suite (Node built-in runner)
node --experimental-strip-types --test test/two-process.test.ts

# generate a fixture / verify one
node --experimental-strip-types src/cli/generate.ts 8
node --experimental-strip-types src/cli/generate.ts 8 | node --experimental-strip-types src/cli/verify.ts

# two-run byte determinism
node --experimental-strip-types src/cli/generate.ts 8 > a.json
node --experimental-strip-types src/cli/generate.ts 8 > b.json
cmp a.json b.json && shasum -a 256 a.json b.json
```

`verify` exits `0` when the fixture is consistent, `1` when it is not, `2` when
stdin is not valid JSON.

## Verified results (source commit `1f9119ac8`)

- `tsc --noEmit`: **clean** (exit 0).
- `node --test`: **34 pass / 0 fail**. Every mutated artifact still parses, so
  each failure is the targeted invariant rather than a schema rejection.
- Two-run determinism (count=8): byte-identical,
  `sha256 = 517f8dcfe4f7eb7259f9137cf1f46ec3ab301a5d5d331bac06560efe6b1fe686`.
- **Teeth proven by verifier mutation**: neutering `forgedAuthorZeroActivation`
  → 2 failures; `appliedInventoryMatchesProducer` → 3; `restartNoDoubleApply`
  → 1; trusting the declared `contentDigest` → 3. Restoring the verifier returns
  34/34.

## Handoff

To evaluate a real Gate 1, a future collector runs the two processes and emits a
`raw@1` document from observed state instead of `generateConsistentEvidence`,
then adds a `productBoundary`/`gateEvaluation` state machine. Until that
collector exists, keep the markers `not-connected` / `not-evaluated`: a green
fixture is not a gate pass.
