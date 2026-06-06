# BDD / Gherkin pilot

A small, self-contained pilot that runs **Gherkin `.feature` specs on the
project's existing Vitest runner** — no second test framework, no extra CI lane.

The goal is to evaluate whether describing system behaviour in human-readable
`Given / When / Then` is worth adopting more widely, **before** committing to it.

```
bdd/
├── features/                     # the human-readable specs (.feature)
│   ├── entity-predicate.feature  #   pure smoke spec — always runnable
│   └── ka-lifecycle.feature      #   @devnet — the real KA publish lifecycle
├── steps/                        # step definitions that bind specs to code
│   ├── entity-predicate.steps.ts
│   └── ka-lifecycle.steps.ts
├── support/
│   └── world.ts                  # shared devnet connection + HTTP helpers
├── vitest.config.ts
└── package.json
```

## Why this approach

The binding is [`@amiceli/vitest-cucumber`](https://www.npmjs.com/package/@amiceli/vitest-cucumber).
It was chosen deliberately over standalone Cucumber:

- **One runner, one CI lane.** `describeFeature/Scenario/Given/When/Then`
  compile down to Vitest's own `describe/test`. Its peer dependency is
  `vitest ^4.0.4`, which the repo's `^4.0.18` satisfies — no runner duplication,
  no Jest typings, nothing new for CI to learn.
- **Real `.feature` files.** `loadFeature('./x.feature')` parses actual Gherkin
  (Scenario Outline, Examples, Background, tags, hooks) — the specs are not
  inline strings, so non-engineers can read and edit them.
- **Maintained and Vitest-4 native** (unlike `jest-cucumber`, which is Jest-first,
  or `@deepracticex/vitest-cucumber`, which doesn't declare Vitest 4 support).

It is **strict by design**: every step in a `.feature` must have a matching step
definition or the suite fails. That keeps specs and code honest.

## The two specs

### 1. `entity-predicate.feature` — the smoke spec (always runnable)

Pins the OT-RFC-43/44 entity-predicate rename invariant
(`dkg:rootEntity → dkg:entity`, `dkg:assertionRootEntity → dkg:assertionEntity`):
during the dual-write migration window, a mixed-fleet node **must recognise both
the new and the legacy predicate** or it silently drops entity members.

It exercises the real pure helpers in
[`packages/core/src/entity-predicate.ts`](../packages/core/src/entity-predicate.ts)
via a data-driven `Scenario Outline`. No devnet, no network — it runs in
milliseconds and proves the Gherkin→Vitest binding works end to end.

This is the package's default `test` script, so `turbo test` (the standard CI
command) runs it automatically — no extra CI lane:

```bash
pnpm --filter @origintrail-official/dkg-bdd test
```

### 2. `ka-lifecycle.feature` — the real e2e (tagged `@devnet`)

The canonical V10 flow expressed as behaviour: a draft assertion goes
`create → write → finalize → promote → publish` and ends as a confirmed
on-chain Knowledge Asset. The step definitions call the same daemon routes as
`devnet/v10-core-flows`' `fullPublish()`, sharing the produced
assertion/`kaId` through the test World.

It is **tag-gated**: if no local devnet is provisioned it is skipped cleanly
(rather than failing), mirroring how the existing devnet suites guard. Like the
other `devnet/*` suites it is intentionally kept out of the default `turbo test`
lane and run explicitly:

```bash
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
node devnet/_bootstrap/bootstrap.cjs
pnpm --filter @origintrail-official/dkg-bdd test:devnet
```

To run both specs at once (the devnet one self-skips without a cluster):
`pnpm --filter @origintrail-official/dkg-bdd test:all`.

## How to add a new spec

1. Write `features/my-thing.feature` in plain Gherkin.
2. Create `steps/my-thing.steps.ts`: `loadFeature(...)` + `describeFeature(...)`,
   implementing one step definition per line in the feature.
3. Reuse `support/world.ts` for any devnet/HTTP plumbing.
4. Tag devnet-dependent scenarios `@devnet` so they self-skip without a cluster.

## Honest tradeoffs

- **Where it pays off:** multi-step, spec-driven flows with stakeholders who read
  them (KA lifecycle, conviction staking tiers, provenance modes, the KA-routes
  parity/must-not-regress invariants). The `.feature` doubles as living spec.
- **Where it does not:** simple unit assertions, and anything where the cost is
  the *infrastructure* (booting a 6-node devnet) rather than the assertion syntax
  — Gherkin does nothing for that hard part. Don't rewrite the 9 existing devnet
  scenarios; add Gherkin where the readable-spec value is real.
- The strict matching means every feature line needs an implementation — good for
  rigor, but it is real maintenance.

## Pilot status (branch `test/bdd-gherkin-pilot`)

- **Smoke spec** — verified green locally: `9` Example rows / `27` step-tests
  pass in ~8ms. It is the package's `test` script, so it runs under the standard
  `turbo test` CI lane.
- **`@devnet` spec** — verified to skip cleanly (exit 0) when no cluster is
  present. Every HTTP route, request payload and response field it uses has been
  cross-checked against the live daemon handlers (`assertion.ts`, `memory.ts`,
  `status.ts`) and matches `devnet/v10-core-flows`' `fullPublish()` — but it has
  not been executed against a live cluster as part of this pilot.
