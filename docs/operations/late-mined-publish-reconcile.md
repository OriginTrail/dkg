# Record a publish whose transaction mined late

Use this procedure when a named Knowledge Asset stays `swm-shared` after a VM publish whose transaction mined after the node stopped waiting for it. Typical causes are a receipt timeout during a gas-price spike, or a failure in the node's local recording step after the transaction mined. The asset's seal pins its reserved KA id, so every `vm/publish` retry reverts `KaIdAlreadyMinted`. Do not edit the store or re-seal the asset.

A node administrator records one asset with:

```bash
dkg ka reconcile <name> -c <context-graph-id> --sub-graph-name <sub-graph>
```

Omit `--sub-graph-name` for an asset in the root graph. Add `--tx-hash <hash>` when the mint transaction is known (for example from `daemon.log`). Without it, the node finds the transaction from the asset's creation log, newest block first. A hint that does not prove the mint (for example a duplicate send that reverted) falls back to that search. The HTTP equivalent is:

```http
POST /api/knowledge-assets/<encoded-name>/vm/reconcile
Authorization: Bearer <node-operator-token>
Content-Type: application/json

{ "contextGraphId": "<context-graph-id>", "subGraphName": "<sub-graph>", "txHash": "<optional-hash>" }
```

The node verifies the mint before recording anything:

- The asset must be finalized and fully shared, and its shared-memory content must still match its seal.
- Every fact comes from one successful receipt: exactly one `KnowledgeAssetCreated` for the reserved id from DKGKnowledgeAssets, and exactly one `KnowledgeAssetRegisteredToContextGraph` for it from ContextGraphStorage.
- The receipt's Merkle root, context graph and author must equal the seal's.
- The receipt must hold the node's configured `chain.finalityConfirmations` depth, with its block hash still at its height. At the default of 1 this proves the block canonical, not deeply final.

It then records the original transaction, block, publisher and TRAC cost through the normal confirmed-publish path and broadcasts the usual finalization message. If the node already holds a confirmed record of exactly this content and transaction, it keeps that record instead of writing a second one. That covers a record written by the failed run that minted the asset, or by the node's chain reconcile. A record of other content refuses with `existing-record-conflict` before anything is written. It sends no transaction, ACK request or member ciphertext, and needs no funded publish wallet. Success returns `status: "adopted"` with the UAL, KA id, transaction hash and block. Repeating the command returns `status: "already-published"`.

| Response | Meaning |
|---|---|
| 409 `KA_MINT_ADOPTION_REFUSED`, `reason: "not-minted"` | The reserved id is not minted at the finality-depth block. Publish the asset normally with `dkg ka publish`. |
| 409 `KA_MINT_ADOPTION_REFUSED`, `root-mismatch`, `context-graph-mismatch`, `author-mismatch`, `mint-receipt-invalid` or `existing-record-conflict` | The id was minted by something this seal did not produce. Keep the evidence and investigate; do not force it. |
| 503 `KA_MINT_ADOPTION_REFUSED`, `retryable: true` (`mint-not-final` or `mint-receipt-missing`) | The mint is too recent, or its creation log was not found. Retry later, or pass `--tx-hash`. |
| 503 `KA_MINT_RECONCILE_INCOMPLETE` | The mint was verified, but the lifecycle did not reach `vm-confirmed`. Retry. |
| 409 `VM_PUBLISH_PRECONDITION` or `PUBLISH_NOT_FULL_SHARE` | The asset is not a finalized, fully shared asset, or its shared-memory content is gone. |

Any other failure, such as a store error, leaves the lifecycle at `swm-shared`. A retry keeps the matching record an earlier attempt left and completes the remaining steps. The command sends nothing, so it is safe to retry. On a large node, a 500 with "Triple-store response exceeds byte limit" can come from a concurrent query sharing the store's graph listing during the shared-memory cleanup. Retry it while the node serves no other queries.

A plain `dkg ka publish` retry also adopts the asset's own mint when the contract reports the reserved id already minted. That retry still collects core ACKs first, and under the per-publish approval policy it can send a TRAC approval before gas estimation reverts. Prefer `reconcile`.

Agent-scoped credentials cannot invoke this endpoint. Keep the successful response as operational evidence.
