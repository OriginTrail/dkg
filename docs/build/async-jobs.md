---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Async Share and Publish Jobs

Use the async routes for bulk imports, long work, and work that must finish even if your client stops. The node stores the job and answers at once with a job ID: stored, not done. Poll the job until it finishes. Operators tune the queues in [Async Queue Operations](../use-dkg/async-queue-operations.md).

## Submit and poll

Share a finalized Knowledge Asset to Shared Working Memory, then read the job:

```bash
curl -s -X POST -H "Authorization: Bearer $DKG_AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"contextGraphId\": \"$DKG_CONTEXT_GRAPH\"}" \
  "$DKG_NODE_URL/api/knowledge-assets/$DKG_KA_NAME/swm/share-async"
# {"jobId":"<job-id>","state":"queued"}

curl -s -H "Authorization: Bearer $DKG_AUTH_TOKEN" \
  "$DKG_NODE_URL/api/knowledge-assets/swm/share-jobs/<job-id>"
```

Poll until `state` is `succeeded`; the node retries a `failed_retrying` job by itself. A `failed` job needs attention: read its `lastError` before you recover it. The CLI equivalents are `dkg ka share-async <name> -c <context-graph-id>` and `dkg ka share-job <job-id>`. When `share-async` or `publish-async` fails, it prints what the answer says about a job (`code`, `admissionOutcome`, `jobId`, `statusPath`, `jobCreated`, `existingJobId`) and the command that reads a job it names. Follow [Retry safely](#retry-safely) before you run it again.

Publishing works the same way, once the node has [Async Publisher Wallets](../use-dkg/async-publisher-wallets.md). `POST /api/knowledge-assets/{name}/vm/publish-async` answers `202` with a `jobId`. Poll `GET /api/publisher/job?id=<job-id>` until `job.status` is `finalized`.

### Read a failure

A failed job carries a machine code and a short reason. For a share job they are `lastError.code` (with `lastError.diagnosticCode` when there is one) and `lastError.message`; for a publish job, `failure.code` and `failure.message`. Act on the code. The message is for people: at most 512 characters, without transaction payloads, long hex values or request details, and with any URL reduced to its host. When the node had to shorten it, the whole text, with the same parts left out, is in the node's log under the job ID.

## When the answer is not a success

A `409` with `existingJobId` means another job holds this Knowledge Asset:

- **Share:** the same share is still running: poll it.
- **Publish:** it is a different publish request for the same asset. Read that job: if it [carries your seal](#retry-safely), poll it and do not resend. Otherwise wait for it to finish before you send yours. If it failed, see [Held jobs](../use-dkg/async-publisher-wallets.md#held-jobs).

A `503` means the node is busy. Wait for `Retry-After`, then follow [Retry safely](#retry-safely). Without `Retry-After`, waiting helps only if the answer says `retryable: true`.

## Retry safely

Resend a request only when you know no job came of it: a `503` with `admissionOutcome: "not_admitted"`, or a publish answer with `jobCreated: false`. Send it unchanged: the same context graph, sub-graph, name and author, with the same token.

Otherwise find the job first:

- **Share:** a share is deduplicated only against a running job. Poll the job ID or `statusPath` (an `"indeterminate"` answer has one) and do not resend, whatever state it shows. If every reply was lost, [reconcile the share](#lost-every-reply-reconcile-a-share).
- **Publish:** read the job (`GET /api/publisher/job?id=<jobId>`) or [find it by intent](#find-a-publish-job-by-intent). It carries your seal when its `request.knowledgeAssetVmPublish.sealMerkleRoot` and `assertionVersion` equal the `merkleRoot` and `assertionVersion` from your `wm/finalize`. If the job that carries your seal is `finalized`, it is published: do not resend or re-base.

Never rename the Knowledge Asset or change the request to get past an unclear answer or a conflict; that can share or publish the same content twice. An empty status read or job list does not prove that a job never existed.

## Cancel, recover, retry and clear

Share jobs live at `/api/knowledge-assets/swm/share-jobs/{jobId}`:

- `DELETE` cancels a `queued` job. The job stays, as `failed` with reason `cancelled`.
- `POST .../recover` restarts a `failed` job.
- `POST .../clear` removes one finished job. Clearing a single job is API-only for now.

A share job's `attempts` never exceeds `maxAttempts`. When automatic recovery runs a job past its budget, the extra attempts are in `recoveryAttempts`; see [Share retries](../use-dkg/async-queue-operations.md#share-retries).

For publish jobs, a node admin cancels an `accepted` job with `POST /api/publisher/cancel` and retries failed jobs with `POST /api/publisher/retry`. `POST /api/publisher/clear-job` removes one finished job. A [held](../use-dkg/async-publisher-wallets.md#held-jobs) one needs `"allowPendingTransaction": true`: check its transaction first, or a re-submit can publish again.

The [API reference](../references/api.md) lists every route.

## Lost every reply? Reconcile a share

If every answer to a share was lost, the read `GET /api/knowledge-assets/swm/share-jobs/reconcile` tells you whether a stored job ran it.

Before you share, keep the identity that `wm/finalize` returns, and pass it as [query parameters](#reconcile-reference). `outcome: "proven"` gives the `jobId` of the one succeeded job that ran this exact share. Anything else is `unproven`, with a `reason`.

Every answer carries `mutationRetryAllowed: false`: no answer on its own makes another share safe. The SDK method is `ApiClient.knowledgeAssetReconcileShare(identity)`.

## Response reference

| Answer | Meaning and next step |
| --- | --- |
| `200` (share) or `202` (publish), with `jobId` | The job is stored. Poll it |
| `400 KA_ATOMIC_SHARE_REQUIRED` | Drop the `entities` array: a share always takes the whole Knowledge Asset |
| `409` with `existingJobId` | Another job holds this asset. See [When the answer is not a success](#when-the-answer-is-not-a-success) |
| `409 PUBLISH_INTENT_STALE` or `PUBLISH_NOT_FULL_SHARE` | Out of date or not fully shared. If you sent this publish before, [check that job](#retry-safely) first; then see [Stale update intents](../use-dkg/async-publisher-wallets.md#stale-update-intents) |
| `503 PROMOTE_ADMISSION_UNAVAILABLE`, `admissionOutcome: "not_admitted"` | No share job was written. Send the same request after `Retry-After` |
| `503 PROMOTE_ADMISSION_UNAVAILABLE`, `admissionOutcome: "indeterminate"` | A share job may exist. Poll `statusPath` and do not resend |
| `503 STORE_SCHEDULER_BUSY` or `STORE_OPERATION_TIMEOUT` | The store is busy. Resend a publish only on `jobCreated: false`; otherwise [find the job](#retry-safely) |
| `503 async_publisher_unavailable`, or `async-promote worker is not available` | No job was written. If `retryable` is `true`, retry shortly; otherwise an operator must set up [Async Publisher Wallets](../use-dkg/async-publisher-wallets.md) or enable the share worker (`promoteQueue.enabled`) |
| `503 LIFT_JOB_PENDING_CHAIN_PROOF` | An earlier publish of this asset may have sent a transaction. See [Held jobs](../use-dkg/async-publisher-wallets.md#held-jobs) |
| `404` on a status read | Unknown, cleared or removed job. Not proof that it never ran |

### Find a publish job by intent

`GET /api/publisher/job-by-intent?contextGraphId=<id>&name=<name>` finds an asset's publish jobs. Add `subGraphName` if you used one, and `agentAddress` if you published for another author.

| `result` | Next step |
| --- | --- |
| `active` | Poll `job`. If it does not carry your seal, treat it as a [publish `409`](#when-the-answer-is-not-a-success) |
| `superseded` | The listed `jobs` have ended. One `finalized` with your seal means you are done; otherwise read the note below before you resend |
| `none` | No job is stored. That does not prove your publish never ran: a finished job may have been cleared or removed by cleanup. Read the note below before you resend |
| `conflict` | Ask an operator |

After `none`, or `superseded` without your seal, only the chain can tell you whether your publish ran. Check the asset's published state (`dkg ka history <name>`) and any transaction you know of. The journal, `GET /api/publisher/journal` with the same parameters, may list an earlier attempt and its `txHash`, but it is best effort: a missing entry proves nothing. Resend only when you are sure your content is not published and no earlier attempt can still land. If you are not sure, ask an operator.

### Reconcile reference

Send `contextGraphId`, `assertionName`, `agentAddress` (the storage lane), `authorAddress`, `kaUal`, `assertionVersion`, `merkleRoot` and `entities=all`. Add `subGraphName` if the share used one; `shareOperationId` is an optional extra filter. An agent token may read only its own lane.

| `reason` | Meaning |
| --- | --- |
| `absent_or_pruned` | No stored job matches: never admitted, or removed |
| `identity_mismatch` | A job exists for this asset, with other evidence |
| `unsupported_legacy_evidence` | A matching job has no evidence this node can check |
| `unfinished` | A matching job has not finished |
| `ambiguous` | More than one job matches |
| `conflicting_evidence` | The stored records disagree |
| `incomplete_inventory` | More than 1,000 stored jobs, or an unreadable record |
| `unavailable` | The store did not answer; HTTP `503` |
