---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Async Share and Publish Jobs

Use the async routes for bulk imports, long work, and work that must finish even if your client stops. The node stores the job and answers at once with a job ID. That answer means stored, not done: your client polls the job until it finishes. Operators tune the queues in [Async Queue Operations](../use-dkg/async-queue-operations.md).

## Submit and poll

Share a finalized Knowledge Asset from Working Memory to Shared Working Memory, then read the job:

```bash
curl -s -X POST -H "Authorization: Bearer $DKG_AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"contextGraphId\": \"$DKG_CONTEXT_GRAPH\"}" \
  "$DKG_NODE_URL/api/knowledge-assets/$DKG_KA_NAME/swm/share-async"
# {"jobId":"<job-id>","state":"queued"}

curl -s -H "Authorization: Bearer $DKG_AUTH_TOKEN" \
  "$DKG_NODE_URL/api/knowledge-assets/swm/share-jobs/<job-id>"
```

Poll until `state` is `succeeded`. `queued`, `running` and `failed_retrying` are not success; the node retries a `failed_retrying` job by itself. A `failed` job needs attention: read its `lastError` before you recover it. The CLI equivalents are `dkg ka share-async <name> -c <context-graph-id>` and `dkg ka share-job <job-id>`.

Publishing works the same way, once the node has [Async Publisher Wallets](../use-dkg/async-publisher-wallets.md). `POST /api/knowledge-assets/{name}/vm/publish-async` answers `202` with a `jobId`. Poll `GET /api/publisher/job?id=<job-id>` until `job.status` is `finalized`.

## When the answer is not a success

A `409` with `existingJobId` means a job for this Knowledge Asset already exists. Poll that job instead of submitting again.

A `503` with a `Retry-After` header means the node is busy. Wait that long, then send the same request. If a share answer says `admissionOutcome: "indeterminate"`, a job may exist, so poll its `statusPath` first. Without `Retry-After`, waiting helps only if the answer says `retryable: true`.

The common answers are in the [response reference](#response-reference).

## Retry safely

When an answer is lost or unclear, send the identical request again: the same context graph, sub-graph, name and author, with the same token. Never rename the Knowledge Asset or change the request to get past an unclear answer. That can share or publish the same content twice.

An empty status read or job list does not prove that a job never existed.

## Cancel, recover, retry and clear

Share jobs live at `/api/knowledge-assets/swm/share-jobs/{jobId}`:

- `DELETE` cancels a `queued` job. The job stays, as `failed` with reason `cancelled`.
- `POST .../recover` restarts a `failed` job.
- `POST .../clear` removes one finished job. Clearing a single job is API-only for now.

For publish jobs, a node admin cancels an `accepted` job with `POST /api/publisher/cancel` and retries failed jobs with `POST /api/publisher/retry`. `POST /api/publisher/clear-job` removes one finished job.

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
| `409` with `existingJobId` | A job for this asset exists. Poll it |
| `409 PUBLISH_INTENT_STALE` or `PUBLISH_NOT_FULL_SHARE` | The shared content is out of date or not fully shared. See [Stale update intents](../use-dkg/async-publisher-wallets.md#stale-update-intents) |
| `503 PROMOTE_ADMISSION_UNAVAILABLE`, `admissionOutcome: "not_admitted"` | No share job was written. Send the same request after `Retry-After` |
| `503 PROMOTE_ADMISSION_UNAVAILABLE`, `admissionOutcome: "indeterminate"` | A share job may exist. Poll `statusPath`, or send the same request |
| `503 STORE_SCHEDULER_BUSY` or `STORE_OPERATION_TIMEOUT` | The store is busy. Send the same request after `Retry-After` |
| `503 async_publisher_unavailable`, or `async-promote worker is not available` | No job was written. If `retryable` is `true`, try again shortly. Otherwise an operator must set up [Async Publisher Wallets](../use-dkg/async-publisher-wallets.md) or turn on the share worker (`promoteQueue.enabled`) |
| `503 LIFT_JOB_PENDING_CHAIN_PROOF` | An earlier publish of this asset may have sent a transaction. See [Held jobs](../use-dkg/async-publisher-wallets.md#held-jobs) |
| `404` on a status read | Unknown, cleared or removed job. Not proof that it never ran |

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
