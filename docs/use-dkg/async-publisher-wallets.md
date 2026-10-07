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

## Receipt, finality, and local completion

A job enters `broadcast` when its signed transaction is durably recorded before send. Receipt confirmation can trigger reconciliation while the executor finishes local work. The reconciler independently checks the transaction at the configured confirmation depth and binds canonical publish evidence to that job before writing `included` and releasing its wallet. `finalized` also requires the executor to settle, local lifecycle repair/private staging to complete, and the final job record to be persisted. An `included` job can therefore have already reached chain finality while local work remains.

`GET /api/publisher/job?id=<id>` and `GET /api/publisher/jobs` expose `timestamps.receiptObservedAt` and `timestamps.finalityObservedAt` (Unix milliseconds). The first records the receipt-confirmation callback or inclusion evidence; the second records canonical recovery evidence at the configured confirmation depth. They are distinct from `includedAt` and `finalizedAt`, which describe job transitions. Receipt observations are diagnostics and never release a wallet or authorize a publish. Observations are matched to the job's transaction hash, exposed immediately in the running process, and persisted at the next state transition; a restart before that transition can lose the observation. Older jobs and local-only finalizations can omit these fields.

RFC-64 exact-set verification yields between rows after roughly 25 ms of work, allowing receipt polling and store timers to progress. Every row still passes verification before signing and bundle/control-object staging. One large row or whole-object codec operation can take longer than a slice.

The default scheduler has four total slots (capped by available logical CPUs), with one slot each reserved for ACK and health work. This leaves two shared normal/background slots on a four-CPU host. Background work protects one normal slot and uses at most one slot by default. These are intentional backend admission limits, rather than a count of publisher wallets; six wallets do not imply six concurrent store operations. `DKG_STORE_MAX_CONCURRENT` and the lane reservation settings control these limits. Job-state reads/writes and post-confirmation store work use this scheduler, and the daemon's main event loop also gates their completion.

## Admission retries

Before `POST /api/knowledge-assets/{name}/vm/publish-async` enqueues a job, it verifies the immutable SWM snapshot. Temporary store pressure or recovery returns `503` with `code: "STORE_SCHEDULER_BUSY"` or `"STORE_OPERATION_TIMEOUT"`, `retryable: true`, and `Retry-After: 1`. Retry the same request after the store recovers without re-sharing valid content. A genuine snapshot mismatch still returns `409 PUBLISH_INTENT_STALE`; so does a finalized update that is not numbered one above the KA's latest confirmed version, which could never be published (see [Stale update intents](#stale-update-intents) below and [Editing a published Knowledge Asset](knowledge-asset-lifecycle.md#editing-a-published-knowledge-asset)).

These pre-enqueue failures include `jobCreated: false`: this request did not reach enqueue, although an earlier job may exist for the KA. The separate `outcome` describes the failed store operation (`not_started` or `indeterminate`); even an indeterminate read can reject before job creation. Once enqueue begins, a store failure omits `jobCreated` because a job may already have been persisted. Use the publisher job lookup before assuming that no job exists.

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
