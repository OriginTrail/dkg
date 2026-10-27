---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Async Publisher Wallets

Async publisher wallets are transaction signers for queued Verifiable Memory publish jobs. They live in `publisher-wallets.json` under the DKG data directory and are managed with:

```bash
dkg publisher wallet add <privateKey>
dkg publisher wallet list
dkg publisher wallet remove <address>
dkg publisher enable
dkg publisher publish-async <context-graph-id> <name>
```

## Pause and resume the running publisher

Node administrators can pause all new claims, including jobs already accepted in the queue:

```bash
curl -H "Authorization: Bearer $DKG_API_TOKEN" -X POST -d '{}' http://127.0.0.1:9200/api/publisher/pause
curl -H "Authorization: Bearer $DKG_API_TOKEN" http://127.0.0.1:9200/api/publisher/control
curl -H "Authorization: Bearer $DKG_API_TOKEN" -X POST -d '{}' http://127.0.0.1:9200/api/publisher/resume
```

Use the daemon's configured API port. Agent-scoped tokens cannot call these node-wide controls. Responses contain `desiredState`, `effectiveState`, `generation`, `acknowledgedGeneration`, `updatedAt`, and each wallet's claim gate and generation. A successful pause waits for claims already inside the claim transaction to finish and fences every wallet before acknowledging. A job claimed before that boundary may continue execution, broadcasting, receipt handling, and finalization. Recovery remains active while paused; pause does not cancel or clear job evidence, and admission can continue accepting jobs.

The live runtime persists desired state in `publisher-control.json` in its data directory, and restores it before startup recovery or wallet loops begin. Repeating the current desired state is idempotent; successful transitions increment the durable generation. Resume persists intent before opening gates. Shutdown closes gates before draining a concurrent control request, so a persisted resume may take effect on the next startup while the closing runtime remains fenced. `DKG_PUBLISHER_START_PAUSED=1` overrides persisted running intent at startup; a subsequent live resume can reopen the runtime.

A missing runtime returns HTTP 503. A persistence/control failure also returns 503, fences the runtime, and requires restart to reload durable intent; a failed request has no acknowledgement. A status read during a transition may show the previous acknowledged desired state alongside gates already closing. File contents are synced before atomic rename, and the parent directory is synced on supported POSIX hosts. Windows preserves process-restart state without claiming the same directory-fsync power-loss guarantee.

The isolated native restart campaign runs actual two-wallet runtime composition, authenticated loopback HTTP routes, persistent Oxigraph queue evidence and SIGKILL/restart. After building publisher and CLI, run `node --experimental-sqlite --import tsx scripts/repro/publisher-live-control-restart.test.mts`. It uses a disposable data directory and `NoChainAdapter`; it verifies queue/control behavior rather than on-chain execution.

## Receipt, finality, and local completion

A job enters `broadcast` when its signed transaction is durably recorded before send. Receipt confirmation can trigger reconciliation while the executor finishes local work. The reconciler independently checks the transaction at the configured confirmation depth and binds canonical publish evidence to that job before writing `included` and releasing its wallet. `finalized` also requires the executor to settle, local lifecycle repair/private staging to complete, and the final job record to be persisted. An `included` job can therefore have already reached chain finality while local work remains.

`GET /api/publisher/job?id=<id>` and `GET /api/publisher/jobs` expose `timestamps.receiptObservedAt` and `timestamps.finalityObservedAt` (Unix milliseconds). The first records the receipt-confirmation callback, or the inclusion itself when nothing was observed earlier (it then equals `includedAt`). The second is recorded only when a reconciliation or recovery pass proves the transaction at the configured confirmation depth. A job whose executor completes before any such pass has no `finalityObservedAt`: reaching `finalized` is local completion, and it is not recorded as a chain observation. Both are distinct from `includedAt` and `finalizedAt`, which describe job transitions. Receipt observations are diagnostics and never release a wallet or authorize a publish. Observations are matched to the job's transaction hash. A daemon that runs the publisher shows them on these endpoints as soon as they are made, and the next state transition persists them. A restart before that transition loses the observation, and a job view read by another process shows it only once it is persisted. Older jobs and local-only finalizations omit both fields.

RFC-64 exact-set verification yields between rows after roughly 25 ms of work, allowing receipt polling and store timers to progress. Every row still passes verification before signing and bundle/control-object staging. One large row or whole-object codec operation can take longer than a slice.

The default scheduler has four total slots (capped by available logical CPUs), with one slot each reserved for ACK and health work. This leaves two shared normal/background slots on a four-CPU host. Background work protects one normal slot and uses at most one slot by default. These are intentional backend admission limits, rather than a count of publisher wallets; six wallets do not imply six concurrent store operations. `DKG_STORE_MAX_CONCURRENT` and the lane reservation settings control these limits. Post-confirmation store work uses this scheduler, and the daemon's main event loop also gates the completion of job-state reads and writes.

### Queue control path

By default the publisher queue's own job-state reads and writes use that same scheduler. With `DKG_STORE_CONTROL_RESERVED_SLOTS` set (for example `publisher:2`; see [Queue control schedulers](backpressure-observability.md#queue-control-schedulers), off in this release), every store call on the queue's three graphs (`urn:dkg:publisher:control-plane`, `urn:dkg:publisher:wallet-locks` and `urn:dkg:publisher:journal`) runs on the publisher's own scheduler of up to two slots instead, so it does not wait behind client reads or data-plane work. That covers admission (duplicate check, job write), job and wallet-lock reads and writes, claim candidate selection, the stale-lock sweep, the admission journal (sequence allocation and append), the point reads (`GET /api/publisher/job`, `/job-payload`, `/job-by-intent` and `/journal`), cancel and the removal of one job, and the job listing that a bulk `POST /api/publisher/retry` takes while it holds the claim lock. Everything else keeps today's lane. The unlocked reads stay on the normal lane, because they hold no lock and the control scheduler's slots are for the calls that do. Some of them read the whole history: `GET /api/publisher/jobs`, the job listing of a bulk `POST /api/publisher/clear`, the reconciliation inventory and the boot backfill that indexes older jobs. The others are bounded: `GET /api/publisher/stats`, which is a single `COUNT` query grouped by state, and the paged job read (`listPage`), which returns one page of jobs per call under the same context graph scope as the complete listing and which no HTTP route serves yet. The queue-depth counts behind the `async_admission_usage` line stay on the background lane. The claimed job's own work (workspace reads, validation, the publish, post-confirmation store work) never carries the control tag, whatever lane the claim ran in. A call the control scheduler refuses is the usual retryable `503` with `"priority": "control"`. With the setting off (the default), no control scheduler exists and every call takes exactly the lane it took before.

## Admission retries

All publisher wallets share the daemon's RPC request budget. For rate sizing,
the restart requirement and diagnosing local wait versus provider latency, see
[RPC Request Budget](rpc-request-budget.md).

Before `POST /api/knowledge-assets/{name}/vm/publish-async` enqueues a job, it verifies the immutable SWM snapshot. Temporary store pressure or recovery returns `503` with `code: "STORE_SCHEDULER_BUSY"` or `"STORE_OPERATION_TIMEOUT"`, `retryable: true`, and `Retry-After: 1`. Retry the same request after the store recovers without re-sharing valid content. A genuine snapshot mismatch still returns `409 PUBLISH_INTENT_STALE`; so does a finalized update that is not numbered one above the KA's latest confirmed version, which could never be published (see [Stale update intents](#stale-update-intents) below and [Editing a published Knowledge Asset](knowledge-asset-lifecycle.md#editing-a-published-knowledge-asset)).

These pre-enqueue failures include `jobCreated: false`: this request did not reach enqueue, although an earlier job may exist for the KA. The separate `outcome` describes the failed store operation (`not_started` or `indeterminate`); even an indeterminate read can reject before job creation. Once enqueue begins, a store failure omits `jobCreated` because a job may already have been persisted. Use the publisher job lookup before assuming that no job exists.

### Duplicate check on admission

Admission looks for an existing job for the same Knowledge Asset (the lifecycle key: context graph, sub-graph and name) so that a re-submit reuses it, or is refused with `409` and `existingJobId`, instead of creating a second job. The lookup runs under the global claim lock and is bound by that lifecycle key: its cost follows the jobs under this key, not the retained history of every other asset.

Jobs admitted before the lifecycle index existed (#1828) have no index row. The first admission after a node starts therefore also scans for such rows. When it finds none that could match an admission, the node remembers that for the rest of the process, and later admissions use the key-bound lookup alone. The boot backfill (`ensureVmPublishIntentIndex`) indexes any such row it finds, so a restart scans once more and then stops again. Raw-lift rows and rows that cannot form a lifecycle key never match an admission and do not keep the scan on.

One narrowing follows: a pre-index VM-publish row that appears **after** the node has cleared the scan is not seen by admission until the next backfill or restart. Nothing in the current code writes such a row, and each node has its own queue store, so in practice it does not occur. If you restore an old queue into a running node, restart it so the backfill and the first scan see the restored rows.

### Clearing finished jobs, and retention

A Knowledge Asset's jobs are siblings: they share the lifecycle key above. Whether a job still binds the Knowledge Asset depends on its siblings, not on the job alone. A failed job older than the newest job for the same Knowledge Asset is history and binds nothing; if that newest job is deleted, the older failed job becomes the newest and binds again, so a re-submit would reaccept it instead of starting a new job. Everything that deletes finished jobs in bulk therefore applies one rule, which keeps every such binding decision as it was:

- **Bulk clear** (`dkg publisher clear finalized|failed`, `POST /api/publisher/clear`) keeps a finalized job while an older failed job for the same Knowledge Asset is kept, and removes no job whose removal would make a kept job bind the Knowledge Asset. It takes the claim lock for each job it removes, as clearing one job by id does, and it goes oldest first. A Knowledge Asset whose job records cannot be read is skipped. The rule is always on, so a bulk clear can remove fewer jobs than it did before this release (the count in the response is what it removed), and a large one takes longer. `POST /api/publisher/clear-job` for one job is unchanged and stays the deliberate override: clearing the newest job by id can make an older failed job bind the Knowledge Asset.
- **Retention** is an opt-in sweep that deletes a `finalized` job 7 days after it finished. Its core ships in this release switched off and is not yet started by the daemon. Every failed job is kept until an operator clears it, and so is any job that is not finished. A Knowledge Asset's finalized jobs are deleted oldest first, inside the same claim transaction that serializes admission and claims, and a finalized job is never deleted while an older job for the same Knowledge Asset is kept: a failed or unfinished one, or a finalized one the sweep keeps or cannot delete itself (for example a record stored by a much older version). The sweep has the modes `off` (default), `report` (counts what it would delete and deletes nothing) and `delete`. It never touches the journal. After a job is deleted, `GET /api/publisher/job` for it answers `404`, `job-by-intent` answers `none` or lists one job fewer as `superseded`, and a re-submit after the window is admitted as a new job.

`dkg publisher cancel`, `retry` and `clear` fall back to the node's store directly when the daemon cannot be reached. They refuse to do that while the node home names a running daemon process, because a second writer next to the daemon's admission instance is not excluded by its locks. Stop the daemon (`dkg stop`) first, or try again once it answers. `jobs`, `job` and `stats` only read, and still fall back.

## Stale update intents

An update of an already-published KA can only be published as **one above the KA's latest confirmed version**; the publisher, the ACK quorum, peers and the chain all require exactly that number, and `wm/finalize` returns the number it sealed the draft with (`assertionVersion`). A draft finalized under any other number — sealed by an older node, or because the published version moved on meanwhile (for example another update of the same KA was still being published when the draft was finalized and landed first) — cannot be published, so the node refuses it before anything is staged or sent. At `vm/publish-async` admission nothing is created at all: `409 PUBLISH_INTENT_STALE` with `jobCreated: false`; `vm/publish` answers the same `409`. A job that was already queued passes the preflight (which does not compare the number), signs its local update attestation, and then fails terminally as `publish_intent_stale` from `validated` when `update()` refuses it (never the retryable `rpc_unavailable`). The message names the sealed number, the required number and the confirmed version.

Recovery, per KA:

1. If a failed job for the KA is still listed (`GET /api/publisher/jobs?status=failed`), clear it by id: `POST /api/publisher/clear-job { "jobId": "…" }`. `POST /api/publisher/retry` skips a job whose retry budget is spent, a re-submit of the stale request is refused at admission (so it never reaches the job), and the job keeps owning the KA until it is cleared; a corrected publish is otherwise refused with `409` and the job's `existingJobId`.
2. `POST /api/knowledge-assets/{name}/wm/pull-from { "layer": "swm" }` re-opens the shared content as a draft (add `"onConflict": "replace"` if a WM draft already exists). If the message says the **published version moved on** (the sealed number is *below* the required one), use `"layer": "vm"` instead and re-apply your edits.
3. `wm/finalize` — check that the returned `assertionVersion` equals the number the message asked for.
4. `swm/share`, then `vm/publish-async` (or `vm/publish`).

A core that already ACK-signed the abandoned draft declines its replacement transiently until the pending window ends (`DKG_STORAGE_ACK_PENDING_TX_WINDOW_MS`, 5 minutes by default), so retry the publish after that. Peers that already hold an earlier shared draft of the KA may keep showing it in Shared Memory until the update is published: a re-share carrying the same or a lower number than a draft a peer already holds is not applied there, and with `swmAwaitCuratorAck` on a curator that holds the earlier draft rejects the re-share before it commits. Finalizing a replacement draft also replaces the private payload sealed under that number, so an earlier shared draft that carried private content can no longer be re-opened from Shared Memory once its replacement is finalized (tracked in [#2964](https://github.com/OriginTrail/dkg/issues/2964)).

## Held jobs

A job is **held** when it failed after a transaction may have been sent (it persisted a transaction hash, or failed from `included`) and nothing has accounted for that transaction yet. "Held" means the publication outcome is **not yet known** — not that the chain can never answer. A held job is never retried, keeps its Knowledge Asset's lifecycle, and survives bulk cleanup, because running it again could publish the same asset twice.

By contrast, a **transient RPC failure raised while the publish transaction was still being prepared** (every endpoint failed during estimate/sign, the local request governor was full, or a bounded read timed out) is not held: nothing was signed or sent for the publication, so the node records it as a retryable failure and re-runs the **same job** on its bounded backoff, re-validating authority and intent each time. A TRAC approval or a context-graph registration may already have been sent by that attempt; neither is the publication. The identical error *after* the pre-send write-ahead recorded a transaction hash — a broadcast that exhausted every endpoint, a receipt wait that timed out — names a transaction and is held.

### What recovery is waiting for

`GET /api/publisher/job?id=<id>` and `dkg publisher job <job-id>` return `retryState`. For a job that is not moving it carries `blocker: { code, summary, missing? }`: derived on read, additive, fixed text (never an RPC URL, hash or payload). The set of codes is open; read `summary` for any you do not know. `retryState` is derived by the running daemon; with the daemon stopped, `dkg publisher job` prints the job alone. The `503 LIFT_JOB_PENDING_CHAIN_PROOF` returned to a re-submit carries the same `blocker`.

| `blocker.code` | What it says | Can an operator supply it? |
|---|---|---|
| `chain_recheck_pending` | The record is complete and this node can settle it. While the publisher runtime is running and not paused, recovery re-checks on a bounded backoff, finalizes the **same job** if the transaction mined, and releases a CREATE for a re-run only once the transaction is proven never sent (an UPDATE whose transaction never landed stays held). What the latest re-check found is reported as `blocker.lastCheck` when the running publisher holds an observation of it (below); without one it is not named. | Nothing to supply. Wait; restore RPC access if the provider is the problem. |
| `recovery_not_configured` | The record is complete, but this node has no chain-recovery capability for the job's wallet and operation (no resolver, the chain adapter cannot answer, or the publisher runtime is not running). | Restore chain access, the adapter capability or the runtime. A retry is refused while a transaction may exist. |
| `no_transaction_hash`, `no_signer_wallet` | Nothing can be asked about the job at all. | No supported control writes evidence into a job. The best-effort journal (`GET /api/publisher/journal`, named-KA jobs on the daemon) may still hold the hash; inspect the transaction on a block explorer. |
| `claim_or_validation_missing`, `publish_identity_unpinned` | The chain can be asked, but a mined transaction cannot be turned into this job's finalization or recognized as its effect. | No. Inspect the transaction yourself. |
| `operation_unmarked` | The record does not say whether the signed transaction was a create or an update, so no operation-specific proof applies and none is guessed. | No. |
| `nonce_missing` (CREATE) | Recovery still finalizes the job if the transaction mined, but can never prove it unsent, so it can never release it for a re-run. | No. |
| `intended_root_missing` (UPDATE) | Recovery cannot recognize the effect. Absence is never proof for an UPDATE: a later third-party update would make a replay write a stale root over newer state, so recovery never releases one. | No. |

`blocker.missing` lists **every** gap of an incomplete record, so you are not sent to fix one and then meet the next.

#### What the latest chain re-check found (`blocker.lastCheck`)

For a `chain_recheck_pending` job, the job-detail routes (`GET /api/publisher/job`, `job-payload` and the legacy `jobs/<id>` shapes) add `blocker.lastCheck: { outcome, at }` when the running publisher holds an observation of the latest re-check of that exact job. `at` is epoch milliseconds on the daemon's clock, taken when the re-check finished. `outcome` is a closed set of codes (never provider text, which can carry RPC URLs or keys):

| `outcome` | What the latest re-check found |
|---|---|
| `pending-mempool` | The chain has the transaction in its mempool. |
| `pending-awaiting-confirmation` | The transaction is mined but not yet confirmed to the configured depth. |
| `rpc-unavailable` | The chain RPC could not answer: every endpoint failed, a bounded request timed out, or the local request governor was full. It does not by itself mean the provider is down. |
| `absence-unproven` | The chain has no record of the transaction, but the proof that would let this node release the job is not established, so nothing is released. For an UPDATE absence is never proof; for a CREATE it is any of: the signed nonce is not provably spent, the pinned identity is already minted (a replacement transaction may have published) or its state could not be read, no identity is pinned, or the pinned snapshot could not be read. Do not assume it is only an RPC problem. |
| `inconclusive` | Nothing was established and the cause is not classified (an adapter that cannot answer, a confirmation this node cannot map to evidence, another failure). It never means the provider is fine. |
| `unrecognized` | A mined CREATE transaction carries no publish this node can parse (an UPDATE is verified against its intended root instead). |
| `recovered` | The chain confirmed the transaction but this node did not apply it (yet): finalization declined, or the pass ran out of time between the answer and applying it. |
| `reverted` | A job holding an earlier attempt's hash on an UPDATE: a revert proves that transaction had no effect, but an UPDATE is never re-run from it (a replay could write a stale root over newer state), so it stays held. |
| `not-found` | Only a third-party resolver reports it for an UPDATE (the built-in resolver reports `absence-unproven` instead); an UPDATE is never released by absence. |
| `deadline` | The pass's time budget ended before the lookup answered. |
| `error` | The re-check threw: the lookup, the claim transaction or applying its answer. |

It is observability only and changes nothing about when a job is re-checked or what is done with the answer. It lives in the running daemon's memory, so there is none before the first re-check and after a restart; a paused dispatcher (`DKG_PUBLISHER_START_PAUSED`), a pass that did not reach the job (each pass asks at most 25 jobs within 15 seconds) and the idle 60-second cadence all leave an older one in place, so read `at` against the clock. The `503 LIFT_JOB_PENDING_CHAIN_PROOF` body carries the same `blocker` without `lastCheck`.

Retryable jobs that carry no transaction evidence get a blocker too. `not_auto_retryable`: the failure is not one the publisher retries by itself, and `POST /api/publisher/retry` or re-submitting the identical request re-runs it as the same job. `auto_retry_disabled` and `retry_not_scheduled`: a retry that was already scheduled fires again once `autoRetryEnabled` is switched back on, but a job recorded while automatic retry was off was never scheduled and is not released by switching it on, so re-run it by hand. `retry_budget_spent`: re-submitting the identical `vm/publish-async` request re-arms a full budget on the same job. While the daemon reports the publisher runtime unavailable, `waitingReason` reads `operator` and no blocker is added: `GET /api/status` names that reason.

### Operator decision path for a held job

1. **Inspect the exact job** with `dkg publisher job <job-id>`: the retained transaction hash (`broadcast.txHash`, or `recovery.txHashChecked` after a reset), the signing wallet, the nonce, the operation kind and `retryState.blocker`.
2. **Tell the three problems apart.** A provider or access problem leaves the record complete (`chain_recheck_pending`): recovery keeps asking and resumes by itself once the lookup works. Missing local evidence shows up as the `missing` gaps above. An operation-specific limit (an UPDATE has no absence proof; a CREATE needs its nonce and pinned asset identity) is why a complete-looking record can still be held.
3. **Restore the lookup or the capability, or inspect the transaction yourself**, then request only the control that applies. `POST /api/publisher/retry` and a re-submit refuse a held job by design; recovery is the only automatic exit.
4. **If no adequate proof can be obtained, an operator cannot manufacture a safe retry either.** Keep the hold and its evidence. Elapsed time is not proof of non-effect, and neither is a missing receipt; escalating or deliberately abandoning the job is a decision, not a proof.
5. **What clearing does.** `POST /api/publisher/clear-job` with `{ "jobId": "<id>", "allowPendingTransaction": true }` (node-operator token, or the agent that enqueued the job) removes that one record: it **abandons this node's tracking** of the job. It does not cancel a transaction that was already sent, does not prove that none was, and does not authorize a duplicate-safe replacement — a re-submit afterwards mints a **new** job for the Knowledge Asset, which may publish it a second time. A clear never touches the journal, so whatever it recorded about the job (best-effort, named-KA jobs) stays readable. `POST /api/publisher/cancel` removes only a job that is still `accepted` and cannot act on a held one.

## Publication latency and store pressure

Measure queueing separately from chain time using the job's `timestamps`:
`acceptedAt` to `claimedAt` is admission wait; `rpcAcceptedAt` to
`receiptObservedAt` is receipt wait; `finalityObservedAt` to `finalizedAt`
is the remaining local completion interval. Missing timestamps mean that
stage was not observed, rather than a zero-duration stage.

Wallet count alone does not determine throughput. Claims serialize durable
job and wallet ownership writes, and those writes share store capacity with
other node work. Durable admission and resume wake parked wallet loops; repeated
notifications coalesce, and ownership checks and error backoff still apply.
The polling interval remains a fallback, rather than a required delay for new work.
Automatic retry selection uses the persisted retry deadline
index, and recovery inventories exclude accepted and finalized history.
Recovery still retains every failed job needed to preserve its proof backoff.

A detached named-KA executor can finish its own queue record after confirmed
chain execution and successful local finalization. Failed local bookkeeping,
incomplete results, or lost claim ownership retain the existing recovery path.
Private catalog placement remains asynchronous after its durable repair marker
is stored; publication does not wait for placement.

Use `GET /api/diagnostics/backpressure` to inspect store lane occupancy. The
`dkg.store.scheduler_queue_wait_ms` and
`dkg.store.scheduler_operation_duration_ms` histograms separate admission wait
from admitted execution time by `priority` and static `operation` label. The
duration histogram also labels `outcome` as `ok` or `error`; its sample count
shows completed operation volume. Increasing store concurrency is not a
substitute for diagnosing the operations occupying the normal lane.

For a focused investigation, start the daemon with `DKG_ASYNC_PUBLISH_TRACE=1`.
The opt-in `async_publish_claim_trace` log records monotonic claim-lock wait/hold
boundaries, native wallet-ownership decisions, durable lock changes and worker
outcomes. It adds no store reads and is disabled by default. Wallet identifiers
are hashed; job IDs are retained for correlation, so treat these logs as
operational diagnostics. A free wallet can still wait for the claim lock or
store capacity, and a worker may still be finishing an earlier execution after
its wallet is released. Do not infer wallet availability from job finalization.
## Funding

Every async publisher wallet needs the chain's native gas token because it submits on-chain transactions.

For TRAC payment, choose one path:

| Payment path | Wallet requirement |
| --- | --- |
| PCA-funded | Register the wallet address as a Publishing Conviction Account agent. |
| Direct spend | Fund the wallet with enough TRAC and native gas. |

If neither path is ready, the daemon can still start and claim jobs, but publish attempts will fail when the transaction reaches the chain.

## Identity And Attribution

An async publisher wallet does not need an on-chain node identity or profile to claim jobs.

The daemon still reads each wallet's identity at startup:

| Resolved identity | Behavior |
| --- | --- |
| `0` | Publish in no-attribution mode. |
| `N > 0` | Use `N` as publisher-node attribution by default. |

`publisherNodeIdentityId` is attribution metadata. It is not PCA eligibility, direct-spend eligibility, author identity, or ACK quorum identity.

Use `--publisher-node-identity-id 0` when you want explicit no-attribution for one publish:

```bash
dkg ka publish-async notes -c my-project --publisher-node-identity-id 0
dkg publisher publish-async my-project notes --publisher-node-identity-id 0
```

Use a non-zero override only when an operator intentionally wants the publish to carry a specific publisher-node attribution claim.

## Optional Node Attribution Setup

Core node profile setup creates an identity for the node's primary operational wallet. Separate async publisher wallets are not automatically attached to that identity.

To make a separate publisher wallet resolve to a non-zero node identity, authorize it as an operational wallet for that node identity with the current `POST /api/operational-wallets` API route or an equivalent future CLI wrapper. If you do not need publisher-node attribution, leave the wallet identityless.

ACK quorum still depends on core receiver identities and operational keys. Changing async publisher wallet attribution does not relax ACK requirements.
