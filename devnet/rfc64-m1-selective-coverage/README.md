# RFC-64 M1 selective coverage evidence

This directory defines and launches the closed, deterministic evidence boundary
for the M1 three-process devnet harness. An operator-owned adapter controls real
Publisher, Edge, and Core processes; the repository-owned collector controls
the phase order, checks process identity, and refuses to publish an artifact
until the fail-closed verifier accepts every observation.

The verifier passes only when all of these user-visible outcomes are proven:

- the corpus digest, network, exact Git/runtime manifests, and three distinct
  process peer IDs match a trust anchor supplied outside the evidence artifact;
- Publisher-owned source snapshots match the anchored corpus, so a receiver
  cannot redefine the VM or SWM state it is expected to receive;
- an Edge has no VM or SWM payload before the user selects a graph;
- an on-demand selection receives an exact point-in-time VM and SWM snapshot
  but does not advance after restart without another request;
- an always-on selection receives the first exact snapshot and advances to the
  second exact snapshot after restart;
- unselected public and private graphs remain payload-free on the Edge;
- automatic Core rounds never exceed the configured batch and never include a
  private graph;
- every public graph is eventually scheduled and converges to exact final VM
  and SWM heads, inventory digests, asset counts, and payload triple counts.

The corpus may contain up to 64 graphs, while one automatic journal entry may
contain at most 32 graph IDs. Accordingly, `coreAutomaticBatchSize` is capped at
32 and a 33-64 graph corpus must converge through multiple bounded rounds. A
truncated single-round claim cannot satisfy the gate.

Edge results are bound to runtime subscription modes and distinct operation job
IDs whose completion records carry the exact resulting snapshot. After restart,
always-on work must come from the reconciler; on-demand payload remains at its
first snapshot but its process-local mode is absent until a second explicit user
request reactivates and advances it. Core results are
bound to scheduler-issued automatic jobs with an empty explicit selection list
and exact final-wave per-graph completion records. Every public graph must first
appear within the anchored coverage-round limit. Manual catch-up cannot be
relabeled as automatic evidence.

Metadata is allowed to exist for an excluded graph because chain and discovery
metadata are not corpus payload. Metadata-only responses can never satisfy a
required plane: `reportedComplete` is treated as an assertion, and the verifier
independently requires exact nonzero data, counts, heads, and inventory roots.

## Runtime sequence

The launcher deliberately starts Core cold, after the second publication wave:

1. Start Publisher and Edge as distinct OS processes and verify their peer,
   network, commit, and loaded-runtime identities against the trust anchor.
2. Publish the selected wave and read exact Publisher VM and SWM snapshots.
3. Prove the Edge has no payload, then issue only the anchored on-demand and
   always-on user selections and retain their returned job IDs.
4. Publish the final wave, restart the Edge into a new OS process, and require
   its actual reconciler record for always-on refresh. Observe on-demand data
   still at the selected snapshot with no active runtime mode.
5. Issue the second explicit on-demand request and require exact final state.
6. Start Core cold, consume scheduler-issued automatic rounds only, and require
   every public graph to enter the bounded window and reach exact final state.

The collector always stops every role it attempted to start. If collection,
node cleanup, adapter shutdown, or adapter exit fails, it does not write a
passing evidence artifact. Artifact publication therefore happens only after
the controlling adapter and all controlled node processes have shut down.

## Exact plane observations

For each VM and SWM plane the adapter queries the complete scoped KA inventory
and builds `Rfc64SemanticSnapshotV1` using
`devnet/_bootstrap/rfc64-evidence.ts`. The mapping is fixed:

- `headDigest` = `ualsSha256`;
- `inventoryDigest` = `semanticNQuadsSha256`;
- `assetCount` = `kaCount`;
- `dataTripleCount` = `quadCount`;
- `metadataTripleCount` = the separately queried scoped metadata row count.

An empty or metadata-only plane must use the absent representation; it must not
set `reportedComplete=true`. The adapter may not derive the expected snapshot
from Edge or Core. Expected snapshots come from the immutable corpus file and
must match Publisher-owned observations.

## Operator adapter protocol

Set `DKG_RFC64_M1_ADAPTER_COMMAND` and, optionally,
`DKG_RFC64_M1_ADAPTER_ARGS_JSON` to an executable that reads one JSON command
per stdin line. It may write ordinary logs, but evidence results use exactly:

```text
DKG_RFC64_M1_RESULT {"schema":"dkg-rfc64-m1-selective-coverage-runtime-result-v1",...}
```

Every command carries the runtime protocol, a launcher-generated 256-bit
`sessionNonce`, a monotonic `sequence`, a command name, and a payload. The
adapter must return the same nonce and sequence with either
`{"ok":true,"value":...}` or `{"ok":false,"error":"..."}`. A result or log
line larger than 1 MiB is rejected, preventing an unbounded stdout buffer.
Commands are:

| Command | Required runtime action/evidence |
| --- | --- |
| `start` | Start the named role; independently return PID, process instance/wave IDs, `processStartedAt` as integer epoch milliseconds sourced from `Math.floor(performance.timeOrigin)`, durable-directory identity, peer ID, network, commit, and loaded-runtime digest. The command contains only the role, never the trust anchor. |
| `publish-wave` | Publish the named anchored wave; return exact Publisher VM/SWM observations for every graph. |
| `observe-edge` | Return exact Edge VM/SWM observations, effective runtime mode, and the actual producing job ID. |
| `synchronize-edge` | Issue only the named explicit user selection; return its real job ID and terminal exact snapshot. |
| `restart-edge` | Stop and restart Edge from the same durable data directory; return a receipt binding the old process instance/PID and observed exit to the new process instance/PID, stable directory identity, and peer identity. |
| `wait-edge-reconciler` | Wait/read only; return source, mode, job ID, completed snapshot, and the post-restart journal reference without receiving those conclusions in the command. |
| `core-automatic-round` | Return `round` with the frozen scheduler plan and a journal snapshot/reference proving its actual planned IDs, lane, job ID, empty explicit selection, and per-CG terminal completions. |
| `observe-core-final` | Return exact final VM/SWM observations and the automatic job IDs that produced each graph. |
| `stop` / `shutdown` | Stop one role / close the controlling adapter. Acknowledgement means all controlled node processes have exited; the launcher waits for adapter exit, then escalates from `SIGTERM` to `SIGKILL` on timeout. |

The adapter reads automatic provenance from the node-admin-only endpoint
`GET /api/diagnostics/sync-coverage-evidence?afterSequence=N`. The launcher
requires schema version 1, the exact 256-entry journal capacity, an in-window
terminal entry, `evidenceTruncated=false`,
and all metadata/durable/shared-memory verification bits. It binds:

- `edge-reconciler-job` entries to the actual job ID, context graph,
  `source=reconciler`, `trigger=periodic-reconciler`, and
  `syncMode=always-on`;
- `core-automatic-round` entries to the actual job ID, planning lane,
  configured batch, frozen explicit/automatic ID lists, and every terminal
  per-CG completion. Every completion carries the same real scheduler-round
  job ID; a detached or synthetic per-CG ID is rejected. Planned IDs and
  completion IDs must match exactly in count and order, so later completion
  cannot retroactively validate an incomplete earlier admission round.

`droppedBeforeSequence` and `nextSequence` prove the selected entry was not
overwritten. Any truncated, missing, nonterminal, or mismatched record fails the
run. Synthetic job IDs or inference from final store contents are not acceptable
substitutes. The admin subscriptions response supplies the effective Edge
`syncMode`; omission retains the legacy `always-on` interpretation only inside
the node, never as evidence for a requested on-demand selection.

The exact bounded journal snapshots and selected sequence numbers are retained
in the canonical artifact alongside the Edge/Core process-start and wave
identities. `verify-live` parses and revalidates those raw records, so an artifact
with relabeled automatic fields, synthetic job IDs, missing journal proof, or a
mismatched process wave is rejected independently of the collection process.

Every adapter response is decoded through a closed per-command schema at the
process boundary before orchestration can consume it. Wrong session/protocol,
unknown sequences, malformed JSON, oversized lines, unexpected keys, and
malformed command values all fail closed. The launcher also has a direct
regression test proving that corpus, trust-anchor, and artifact paths are absent
from the spawned adapter environment.

This repository supplies the fail-closed orchestrator and framed adapter
protocol, not a deployment-specific adapter executable. The live command is
therefore intentionally blocked unless `DKG_RFC64_M1_ADAPTER_COMMAND` names an
operator-reviewed implementation. The launcher removes corpus, trust-anchor,
and output paths from the adapter environment; the adapter must report runtime
identity from the processes it launched, not echo expected values.

## Running the live gate

The corpus and trust anchor are separate, pre-existing operator inputs. The
launcher cleans and rebuilds the runtime closure, recomputes its manifest, and
requires it to match the trust anchor before starting any node:

```sh
export DKG_RFC64_M1_CORPUS_FILE=/secure/operator/m1-corpus.json
export DKG_RFC64_M1_TRUST_ANCHOR_FILE=/secure/operator/m1-trust-anchor.json
export DKG_RFC64_M1_ADAPTER_COMMAND=/secure/operator/dkg-m1-adapter
export DKG_RFC64_M1_ADAPTER_ARGS_JSON='[]'
pnpm test:m1:rfc64-selective-coverage
```

The trust anchor contains `networkId`, exact `testedHeadCommit`, computed
`runtimeManifestDigest`, `corpusManifestDigest`, and the three expected peer
IDs. Do not generate or overwrite it from receiver output during the run.

Run the bounded contract checks with:

```sh
pnpm test:m1:rfc64-selective-coverage:unit
pnpm typecheck:m1:rfc64-selective-coverage
```
