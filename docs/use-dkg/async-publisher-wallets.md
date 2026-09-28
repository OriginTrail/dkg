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

## Admission retries

Before `POST /api/knowledge-assets/{name}/vm/publish-async` enqueues a job, it verifies the immutable SWM snapshot. Temporary store pressure or recovery returns `503` with `code: "STORE_SCHEDULER_BUSY"` or `"STORE_OPERATION_TIMEOUT"`, `retryable: true`, and `Retry-After: 1`. Retry the same request after the store recovers without re-sharing valid content. A genuine snapshot mismatch still returns `409 PUBLISH_INTENT_STALE`.

These pre-enqueue failures include `jobCreated: false`: this request did not reach enqueue, although an earlier job may exist for the KA. The separate `outcome` describes the failed store operation (`not_started` or `indeterminate`); even an indeterminate read can reject before job creation. Once enqueue begins, a store failure omits `jobCreated` because a job may already have been persisted. Use the publisher job lookup before assuming that no job exists.

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
