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
  pinned Java/Blazegraph runtime builds a private journal with strict parsing,
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
`dataDir` and a matching chain adapter. It returns `{ agent, result, dataDir }`
only when authenticated catch-up reports current coverage. Call `agent.stop()`
to close the owned local store process. Never open the same journal concurrently.

`resumePublicCheckpointEdge({ config, runtime: { java, jarSha256 }, sync,
signal })` reopens only a successfully initialized checkpoint Edge, with the same
chain, deployment, graph and evidence mode. It verifies the copied runtime and
local store properties and performs fresh catch-up before returning. Use this
explicit entry point to restart this experimental Edge; the standard daemon does
not yet discover or manage the native journal automatically.

## Validation and rollout boundary

The implementation is exercised on local peer transport and a captured historical
909-asset / 9,817,731-public-quad dataset. Offline timings exclude live Core export
work, WAN transfer, RPC latency, Blackbox startup and initial rule sampling. They
are not a mainnet under-ten-minute result. Keep the feature experimental until
Blackbox installation/restart orchestration and an authorized live comparison
have passed. No default or release promotion is implied by local verification.
