# EPCIS-on-DKG Demo — Acme Bikes Assembly Line W18

A practical, end-to-end walkthrough of the v10-rc EPCIS plugin against synthesized supply-chain data. One bicycle, 7 station events, full privacy story.

## What this is

**Acme Bikes** is a fictional bicycle manufacturer used here to keep the demo grounded in something readable while staying free of any partner data. Their **Assembly Line W18** produces road bikes. Each bicycle passes through 7 stations (frame welding, painting, wheel assembly, drivetrain, paint inspection, functional test, packing) before shipping. Every station emits a structured event — which item, where, when, status — that maps directly to the GS1 **EPCIS 2.0** supply-chain standard.

This demo follows **one bicycle** (`trace_id 7c4f8d2a-9e3b-4a6d-b517-8f9e0a1b2c3d`, item `BIKE-2026-W18-0001`) through the line. It captures every station event with the v10-rc EPCIS plugin, queries the data back, and shows what each party (Acme owner, granted research lab, external auditor, competitor) can see at each step.

The privacy story is the central beat: by default, EPCIS captures publish a **public anchor** (proves the event happened) plus a **private payload** (full event body, locally readable, optionally granted to specific peers via allowList). The demo demonstrates this contrast on synthesized data that's safe to commit and replay in any environment.

## Prerequisites

- Node.js 22+ — matches the repo-level requirement (`README.md:70`). The demo also uses built-in `fetch`, which is stable from Node 18 onward; the 22 lower bound here is set by the repo, not the demo itself, and is enforced when you run `pnpm -C packages/cli build` from the next bullet.
- Local DKG daemon running and reachable on `~/.dkg/api.port`. Start it with `dkg start`.
- Either a recent `dkg` on your `$PATH` *with* the `epcis` subcommand, **or** the local CLI build (`pnpm -C packages/cli build` from repo root). `run.mjs` prefers the local build automatically.
- The local devnet must be in a **healthy** state — chain adapter responding, contracts deployed and in sync. If the devnet has been running across contract redeploys, captures will finalize with `Async lift cannot mark chain inclusion`. Stopping and restarting the daemon (`dkg stop && dkg start`) typically resolves this; see commit `27490f2b fix(devnet): redeploy contracts when artifacts outpace running chain` for the underlying fix.

## How to run

Default — paced, narrated walkthrough. Each phase prints its story, then waits for `Enter`. Read at your own speed; the prior phase output stays on screen until you advance.

```sh
node run.mjs
```

Unattended (still narrated, but no pauses):

```sh
node run.mjs --no-pause
```

Agent-friendly NDJSON mode (one JSON line per phase step, no narrative, no pauses):

```sh
node run.mjs --json | jq .
```

Skip context-graph creation (useful when the CG is already registered and you want to skip the daemon round-trip). Skip mode requires `EPCIS_DEMO_CG` to be the **fully qualified** CG ID — bare names exit early with a clear error because the auto-resolution path is bypassed:

```sh
EPCIS_DEMO_CG=0xabc.../dmaast-bike-demo node run.mjs --skip-cg-create
```

Override the context graph ID:

```sh
EPCIS_DEMO_CG=my-test-cg node run.mjs
```

By default the demo auto-suffixes its CG name with a per-run timestamp (e.g. `dmaast-bike-demo-mz4hk7n0`) so naive re-runs always create a fresh context graph. The ETL produces deterministic event IDs, so re-capturing the same fixtures into an existing CG hits publisher duplicate-root rejection mid-Phase-1 and never reaches the verification phases — so **pinning `EPCIS_DEMO_CG=<name>` does not, on its own, let you iterate Phase 7**. Phase 1 will hard-fail before Phase 7 runs. To iterate Phase 7 against a stable CG you would need a separate "skip-capture" mode (not provided), so the supported workflow is: let the demo create a fresh CG per run. Pin `EPCIS_DEMO_CG` only when targeting a CG whose `bike-line` sub-graph does not already contain these event IDs.

## How to navigate

| What you want | Where to look |
|---|---|
| Regenerate fixtures from source data | [`lib/etl.mjs`](./lib/etl.mjs) and [`fixtures/README.md`](./fixtures/README.md) |
| EPCIS field mapping rules | [`lib/epc-mapping.mjs`](./lib/epc-mapping.mjs) |
| The synthesized raw source | [`fixtures/source-raw/acme-bikes-line-w18.json`](./fixtures/source-raw/acme-bikes-line-w18.json) |

## What's NOT in this demo

These are deliberately excluded:

- **Multi-node setup.** AllowList grant is *recorded* (Phase 6); cross-node read enforcement uses the same plugin code path but requires a second node to exercise.
- **Kafka / streaming ingest.** EPCIS is the channel; the upstream wiring is separate.
- **Real partner data.** The fixtures are fully synthesized — no customer or partner identifiers anywhere. If you want to drive the demo from a real export, you'll need to author your own raw source file with the same shape as `fixtures/source-raw/acme-bikes-line-w18.json` and point `BIKE_SOURCE` at it.
- **UI integration.** node-ui's Explorer / graph-viz exists; this demo is CLI/API only.
- **Live-chain hardening.** Devnet-only.

## License

Apache-2.0 (matches the parent repo).
