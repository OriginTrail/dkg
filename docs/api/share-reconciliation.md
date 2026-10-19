# Reconcile an async share after losing its replies

Use `GET /api/knowledge-assets/swm/share-jobs/reconcile` when an async share's enqueue and replay replies were lost. This read does not enqueue, recover, clear or retry a job. Ordinary share conflict exclusion remains unchanged.

Before submitting the share, retain the finalized asset's exact identity. Supply all these query parameters:

| Parameter | Meaning |
| --- | --- |
| `contextGraphId`, `assertionName` | Exact context and lifecycle name |
| `agentAddress` | Storage lane, distinct from the signing author |
| `authorAddress` | Signing author of the finalized asset |
| `kaUal`, `assertionVersion`, `merkleRoot` | Finalized native identity, positive decimal version and `0x`-prefixed content root |
| `entities` | Explicit `all`, or a JSON array of entity IRIs for a partial selector |
| `subGraphName` | Required when the original selector used a subgraph; omit otherwise |
| `shareOperationId` | Optional additional exact filter when the original operation is already known |

The SDK exposes `ApiClient.knowledgeAssetReconcileShare(identity)` with the same fields; pass entity arrays directly. Use the finalized identity you retained before sharing, rather than reconstructing intent from a later mutable descriptor. An asset changed before the worker executed will not match the earlier expectation. Current atomic asset sharing supports only the full selector; a partial reconciliation selector cannot match full-share evidence.

An accepted agent credential may read only its own storage lane and must have read access to the context. An authenticated node operator may select a lane. Anonymous access is refused, including tokenless authentication-disabled mode. Rejected requests do not disclose candidate job IDs or private metadata.

## What a positive result proves

A `200` response with `outcome: "proven"` identifies one retained successful `jobId` and its versioned `evidence`. The evidence contains the actual `shareOperationId`, exact selector and canonical author seal (native UAL, version, content root, author and attestation). The publisher captures eligible evidence before commit under the lifecycle lock and returns it only after completion; the worker persists it with the successful queue result under its lease. Client correlation fields are not copied into this evidence. An explicit share-author expectation must match the finalized seal; the publisher rejects a mismatch under its lifecycle lock before durable ownership admission and again before sharing, so evidence validation cannot turn an author mismatch into post-commit bookkeeping failure.

The query must examine the complete retained queue inventory within its 1,000-row bound and find exactly one matching successful record, with no potentially competing legacy or unfinished record for the same selector. The returned `inventory.scope` is `retained_queue_jobs`. This proves the retained job executed the specified immutable share. It does not identify a unique historical HTTP submission, prove current shared-memory availability, or certify that no other job ever existed before retention cleanup.

Discovery scans every subject in the queue control graph before filtering canonical payloads by context. Missing or inconsistent indexes therefore cannot hide a competing retained job. The bound applies across contexts; a large queue can return `incomplete_inventory` even when the requested context is small. A process restart preserves stored evidence. A replay of the same committed operation retains its operation identity. A different native version, content root, author, lane or subgraph does not match. Multiple matching retained jobs remain ambiguous even if they replayed the same operation.

## Conservative outcomes and compatibility

Every response contains `mutationRetryAllowed: false`, including positive responses. This endpoint never authorizes another mutation.

| Unproven reason | Interpretation |
| --- | --- |
| `absent_or_pruned` | No retained candidate; never-admitted and deleted history cannot be distinguished |
| `identity_mismatch` | Retained producer evidence does not match the exact expectation |
| `unsupported_legacy_evidence` | A relevant terminal job has no supported producer evidence |
| `unfinished` | A relevant unfinished job has no completion evidence yet |
| `ambiguous` | More than one retained job matches |
| `conflicting_evidence` | Duplicate or inconsistent evidence prevents association |
| `incomplete_inventory` | The inventory exceeds its bound or has unreadable/inconsistent records |
| `unavailable` | Storage could not complete the read; returned with HTTP 503 |

Context-authority unavailability also returns HTTP 503 before reading evidence. The SDK throws its normal HTTP error on a non-2xx response; neither an exception nor a transport timeout is evidence of non-admission. Fix the dependency and repeat the read, or obtain operator confirmation. Do not submit another share just because an observation is empty or unavailable.

Evidence schema version 1 is an optional addition to queue format 4. Existing records remain readable by the diagnostic job API. Older jobs, previously accepted seals missing canonical evidence fields, successful no-op paths without a verified operation, and jobs that crashed before recording completion are not backfilled from their current descriptor. They may remain unproven and require operator confirmation. Pruning or manually clearing terminal jobs removes this evidence; no historical completeness or retention tombstone is promised. Unknown evidence versions fail conservatively. The read holds the queue mutation lock so a fallback delete/insert replacement cannot hide a competing record. The query supplies a ten-second store cancellation signal; lock wait, authentication and context-authority work are outside that store budget.
