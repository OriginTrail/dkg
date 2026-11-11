# Guarded native public snapshot bootstrap

This experimental path prepares a public DKG graph in a separate local journal,
then opens it as a **new Edge** and runs ordinary authenticated catch-up. Existing
Edges, private data, community data and configuration are never replaced. It is
not enabled by the Blackbox setup default and does not change hardware or Core
configuration automatically.

## What is implemented

- The distinct `/dkg/experimental/public-checkpoint/1.0.0` protocol reuses the
  current bounded public export cache and authorization. It is advertised only
  with the existing `DKG_PUBLIC_SNAPSHOT_BULK=1` responder gate. Its `PERSISTED`
  acknowledgement grants transport progress after bytes are fsynced; it does
  not mean graph data is committed. The existing bulk protocol is unchanged.
- Every asset is checked using the existing identity, root, version, graph-scope,
  canonicalization and complete-content verifier. One to four workers are chosen
  within local CPU and free-memory limits. A changed inventory refuses preparation.
- Native loading consumes only verified, locally sanitized N-Quads. An explicitly
  configured Java executable and SHA-256-pinned Blazegraph JAR build a private journal with strict parsing,
  then every asset and all public quads are read back. Positive and negative
  queries retain their two-second limit. Core-cache trust metadata remains durable.
- A prepared journal reports `verified-unpublished`, `current: false` and
  `activeStoreChanged: false`. A fresh Edge becomes current only after normal
  exact catch-up against newly authenticated authority. Restart repeats normal
  catch-up; an old completion file is never current-chain proof.

## Limits and failure behavior

The original one-hour snapshot job budget includes download, verification,
loading and fresh activation. Stream idle (120 seconds), codec (5 seconds),
per-query (30 seconds) and smoke (2 seconds) budgets remain unchanged. A restart
is a separate ordinary catch-up job with the existing one-hour budget.

The initial native profile permits at most 100,000 assets, 1 GiB encoded and
8 GiB expanded, reserves 7 GiB disk space, and needs a minimum 4 GiB machine or
container memory allowance. The JVM uses at most a 3 GiB heap and four CPUs.
The private store admits one request at a time, including control operations and
the full body of admitted reads. This avoids overlapping requests to the pinned
Blazegraph runtime, where full-data testing observed missing mandatory SELECT
bindings. Its queue and operation deadlines are unchanged; ordinary external
stores retain their existing concurrency and control capacity. Incomplete
metadata still fails validation; it is never accepted or silently retried.
Peak disk planning includes retained inputs and a separate journal. This is an
explicit profile, not a promise that every device can run it.

Incompatible cores, corrupt inputs, changed ownership/inventory, expired jobs,
failed loaders or failed full readback leave the active store untouched. Partial
attempts remain for diagnosis. There is no silent retry, deadline extension,
store swap, or automatic deletion. Use the existing incremental recovery path
when this profile is unavailable. Existing initialized directories are refused.

## Operator preparation

Configure the daemon's local pinned native runtime with
`DKG_PUBLIC_CHECKPOINT_JAVA`, `DKG_PUBLIC_CHECKPOINT_JAR` and
`DKG_PUBLIC_CHECKPOINT_JAR_SHA256`. No executable path is accepted over the API.
The runtime must be separately installed and verified; nothing is downloaded.

`dkg sync prepare-bootstrap --request request.json --native` submits an admin-only
preparation job and waits for its exact job identity. The JSON request uses the
existing `contextGraphId`, `onChainId`, `mode`, and `sourcePolicy` or
`trustedCorePeerIds` fields. Omitting `--native` stops after verified load files.
`GET /api/context-graph/snapshot-checkpoint` reads the current preparation status.
Preparation does not activate an Edge.

## SDK fresh activation and restart

`createFreshPublicCheckpointEdge({ config, prepared, native, runtime, sync,
signal })` accepts a verified preparation and native result, explicit runtime
pin, ordinary snapshot source policy and a config with a **nonexistent** absolute
`dataDir` and a matching chain adapter or explicit chain configuration. It returns `{ agent, result, dataDir }`
only when authenticated catch-up reports current coverage. Call `agent.stop()`
to close the owned local store process. Never open the same journal concurrently.

`resumePublicCheckpointEdge({ config, runtime: { java, jarSha256 }, sync,
signal })` reopens only a successfully initialized checkpoint Edge, with the same
chain, deployment, graph and evidence mode. It verifies the copied runtime and
local store properties and performs fresh catch-up before returning. The normal daemon can now own this lifecycle through the fresh profile below.

## Validation and rollout boundary

The implementation is exercised on local peer transport and a captured historical
909-asset / 9,817,731-public-quad dataset. Offline timings exclude live Core export
work, WAN transfer, RPC latency, Blackbox startup and initial rule sampling. They
are not a mainnet under-ten-minute result. Keep the feature experimental until
Blackbox installation/restart orchestration and an authorized live comparison
have passed. No default or release promotion is implied by local verification.

## Normal daemon and Blackbox integration (experimental)

A new Edge can set `publicSnapshotBootstrap` in its local `config.json`:

```json
{
  "version": 1,
  "source": {
    "contextGraphId": "<graph>", "onChainId": "14", "mode": "core-cache",
    "sourcePolicy": "DKG_Core_chain_cache", "trustedCorePeerIds": []
  },
  "runtime": { "java": "/absolute/java11", "jar": "/absolute/pinned.jar", "jarSha256": "<sha256>" }
}
```

The profile requires `nodeRole: "edge"` and no `store` setting. It refuses an
initialized or unknown data directory. The ordinary daemon owns preparation,
full verification, native activation, API startup and shutdown. Its private
journal lives in `public-checkpoint-edge`; preparation remains separate for
diagnosis. On restart it opens that journal and performs authenticated current
catch-up. A network change, testnet reset, failed attempt or incompatible runtime
fails closed; it does not convert or erase an existing store.

During bootstrap the API returns HTTP 503 with `ready: false`. This is liveness,
not completed sync. The existing one-hour job budget includes daemon preparation;
normal readiness, coverage and initial rule checks still follow. The SDK also
exposes `openFreshPublicCheckpointEdge` and `openResumablePublicCheckpointEdge`
for lifecycle owners: register handlers, start the agent, call `complete()`,
then dispose the job lifetime. Stop the agent on any failure.

`dkg sync bootstrap-capabilities` advertises installed support. `defaultEligible`
is deliberately false until a separately authorized end-to-end mainnet comparison
passes. Blackbox's matching installer can explicitly select `--store native` for
a fresh default-graph profile with Java 11, the verified pinned runtime and more
than 18 GiB free. Ordinary installs keep their current backend. Existing native
profiles retain their compatible DKG runtime during Blackbox upgrades; a DKG
runtime upgrade requires a separately verified compatible package. Community
protections, custom graph/source choices and explicit opt-outs remain intact.
