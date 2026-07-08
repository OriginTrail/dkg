# Log KA publish lifecycles by Asset UAL

A Knowledge Asset publish crosses working memory, shared working memory, receiver-node validation, acknowledgement collection, verifiable memory, and chain confirmation, so operators need one grep-friendly identifier that follows the asset across all participating nodes. We will use `assetUal` as the single normal log correlation key for KA publish lifecycle logs, rather than exposing `reservedUal`, raw `kaId`, `publishOperationId`, or batch IDs in ordinary lifecycle messages.

## Considered Options

- **Use `publishOperationId`**: rejected because it is publish-attempt scoped and starts too late for the full lifecycle.
- **Log every internal identifier**: rejected because it makes the logs look detailed while making operator diagnosis noisier.
- **Use `assetUal` as the normal key**: accepted because the code can determine the KA identity early and the same asset identity can be carried through publisher and receiver node logs.

## Consequences

KA publish lifecycle logs should prioritize clarity over exhaustiveness: every lifecycle state change should log what the node is doing, the useful inputs, the useful outputs, and the concrete failure reason, but noisy or large payloads should be summarized. ACKs are part of the lifecycle, not a side-channel: SWM Share ACKs, Storage ACKs, and Sender Key Package ACKs should be logged with the same `assetUal` when they participate in a publish. Logs before `assetUal` exists should be avoided when possible; if an early step must log before the UAL is available, it should include a temporary local id and the first `assetUal` log should connect back to that id.

Every lifecycle log should include one small stable `stage=` token while keeping the message human-readable. Accepted stage tokens are `identity`, `wm`, `swm_share`, `sender_key`, `storage_ack`, `chain`, `vm`, `finalization`, `sync`, and `reconcile`. The token identifies the coarse lifecycle area; the current step, inputs, outputs, and failure details belong in the log message or in bounded key-value fragments such as `step=`, `peer=`, `ackCount=`, `tx=`, or `reason=`. Implementations should not mint one-off stage names from method names, timers, or retry helpers.

Lifecycle logs should not use a generic `nodeId` field. They should log `role` and `localPeerId` on every lifecycle line where the local peer identity is available. They should also log `localNodeIdentityId` when the process has a known on-chain DKG node identity or an explicit no-attribution identity. For remote interactions, logs should include `peer` for the remote libp2p peer id and `peerNodeIdentityId` when ACK verification or chain metadata establishes the remote node identity. Peer ids explain which process or transport endpoint participated; node identity ids explain which registered DKG node or operator participated.

Lifecycle identifiers should be logged in full by default. `assetUal`, `localPeerId`, `peer`, transaction hashes, and node identity ids must remain grep-grade and copy-pasteable across nodes and chain tooling. Shortened display hints may be added only as extra context, never as the only representation in a lifecycle log.

Lifecycle logs should be emitted through a small shared helper rather than hand-built `log.info(...)` messages at each call site. The helper should keep the emitted message human-readable while enforcing the required `assetUal`, `stage`, `role`, peer identity fields, full identifier rendering, bounded key-value formatting, severity selection, and payload redaction. Raw logger calls remain appropriate for ordinary non-lifecycle logs.

Implementation should start with tests that capture lifecycle logs through the existing logger sink and assert that representative publish paths emit a connected sequence with `assetUal`, stable `stage`, `role`, peer identity metadata, ACK events, chain confirmation, and VM/finalization, sync, or reconcile logs. Tests should also guard that lifecycle logs do not emit raw triples, ciphertext, private payload snippets, or truncated-only identifiers.

The first implementation scope is KA create/publish plus the Published KA Sync Lifecycle for those same assets. It includes identity allocation, working-memory writes and promotion, shared-working-memory receive/apply, Sender Key setup where used, SWM Share ACKs, Storage ACK request/decline/success/quorum, chain submit/confirm/fail, verifiable-memory store, finalization gossip, peer sync catch-up for published KAs, and chain-driven reconcile/core-fill for those KAs. It does not include update, delete, verify, generic peer sync, or unrelated system graph sync except where those paths naturally reuse the helper while carrying the same `assetUal`.

The feature is not complete until it has devnet proof. After implementation, a multi-node devnet publish should produce one `assetUal`, and a grep across publisher and receiver node logs for that `assetUal` should show a compact connected sequence covering identity, working memory, shared working memory, ACKs, chain submission/confirmation, verifiable memory/finalization, and published-KA sync or reconcile. The proof should be captured in the handoff or PR notes so reviewers can see the lifecycle working outside isolated tests.

Receiver-side lifecycle logs should obtain `assetUal` from existing publish identity material before adding protocol fields. SWM receive paths can derive the asset identity from the KA author and KA number already carried with workspace messages. Publisher-side ACK collection can carry `assetUal` in local log context because the publishing node knows it before asking peers for ACKs. SWM Share ACKs can be correlated through the originating share operation record, and chain-event paths can derive the canonical `assetUal` from the on-chain KA id plus chain and contract context. A new wire field is justified only for a lifecycle path that cannot derive or correlate the Asset UAL otherwise.

Missing `assetUal` in a publish lifecycle log is an observability defect, not by itself a reason to fail an otherwise valid publish. The implementation should log the defect loudly and tests should fail when lifecycle logs are missing `assetUal`. The publish should fail only when the missing `assetUal` exposes a real publish identity invariant violation, such as missing or invalid KA author, KA number, chain id, contract address, or on-chain KA id where that material is required by the step itself.

Normal lifecycle state changes should be logged at `info`. Declines, retries, and degraded-but-continuing paths should be logged at `warn`. Terminal publish failures should be logged at `error`.

KA publish lifecycle logs are always on for now. Operators can rely on their presence without enabling a feature flag; normal log-level filtering remains the escape hatch for deployments that need less output.

Lifecycle logs must not include raw triples, ciphertext, private payload snippets, or unbounded peer-controlled text. Inputs and outputs should be represented with counts, hashes, identifiers, peer/node metadata, and bounded error reasons.
