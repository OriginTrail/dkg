# Record a publish whose transaction mined late

Use this procedure when a named Knowledge Asset stays `swm-shared` after a VM publish whose transaction mined after the node stopped waiting for it. Typical causes are a receipt timeout during a gas-price spike, or a failure in the node's local recording step after the transaction mined. The asset's seal pins its reserved KA id, so every `vm/publish` retry reverts `KaIdAlreadyMinted`. Do not edit the store or re-seal the asset.

A node administrator records one asset with:

```bash
dkg ka reconcile <name> -c <context-graph-id> --sub-graph-name <sub-graph>
```

Omit `--sub-graph-name` for an asset in the root graph. Add `--tx-hash <hash>` when the mint transaction is known (for example from `daemon.log`). Without it, the node finds the transaction from the asset's creation log, newest block first. A hint that does not prove the mint (for example a duplicate send that reverted) falls back to that search.

When several authors have an asset with this name, the node answers 409 `AMBIGUOUS_ASSERTION_AUTHOR` with the resident candidates. Pick one with `--selected-author-agent-address <address>`; it is the same selector `vm/publish` takes. The HTTP equivalent is:

```http
POST /api/knowledge-assets/<encoded-name>/vm/reconcile
Authorization: Bearer <node-operator-token>
Content-Type: application/json

{ "contextGraphId": "<context-graph-id>", "subGraphName": "<sub-graph>", "txHash": "<optional-hash>", "selectedAuthorAgentAddress": "<optional-author>" }
```

The node verifies the mint before recording anything:

- The asset must be finalized and fully shared, and its shared-memory content must still match its seal.
- The seal and the asset's UAL must name the chain and KAv10 deployment the node is configured for. Chain evidence for an asset reserved on another chain is never read.
- Every fact comes from one successful receipt: exactly one `KnowledgeAssetCreated` for the reserved id from DKGKnowledgeAssets, and exactly one `KnowledgeAssetRegisteredToContextGraph` for it from ContextGraphStorage.
- The receipt's Merkle root, context graph and author must equal the seal's.
- The receipt must hold the node's configured `chain.finalityConfirmations` depth, with its block hash still at its height. At the default of 1 this proves the block canonical, not deeply final.
- The mint must still be the asset's current version. The asset's version view at the finality-depth block must show exactly one root, the receipt's. A later update means the minted content was superseded, and recording it would install a stale version as current. That view only gates the record; every recorded fact comes from the receipt.

It then records the original transaction, block, publisher and TRAC cost through the normal confirmed-publish path and broadcasts the usual finalization message. If the node already holds a confirmed record of exactly this content and transaction, it keeps that record instead of writing a second one. That covers a record written by the failed run that minted the asset, or by the node's chain reconcile. A record of other content refuses with `existing-record-conflict` before anything is written. It sends no transaction, ACK request or member ciphertext, and needs no funded publish wallet. For a curated context graph it reads only the access policy, so it needs no signing key or sender-key setup. Success returns `status: "adopted"` with the UAL, KA id, transaction hash and block. Repeating the command returns `status: "already-published"`.

| Response | Meaning |
|---|---|
| 409 `KA_MINT_ADOPTION_REFUSED`, `reason: "not-minted"` | The reserved id is not minted at the finality-depth block. Publish the asset normally with `dkg ka publish`. |
| 409 `KA_MINT_ADOPTION_REFUSED`, `root-mismatch`, `context-graph-mismatch`, `author-mismatch`, `mint-receipt-invalid` or `existing-record-conflict` | The id was minted by something this seal did not produce. Keep the evidence and investigate; do not force it. |
| 409 `KA_MINT_ADOPTION_REFUSED`, `superseded` | An update replaced the minted content on chain. Recover the current version instead (for example through chain reconcile); do not record this seal. |
| 503 `KA_MINT_ADOPTION_REFUSED`, `retryable: true` (`mint-not-final`, `mint-receipt-missing` or `version-view-unavailable`) | The mint is too recent, its creation log was not found, or the current-version view is unavailable or behind the mint. Retry later, or pass `--tx-hash`. |
| 503 `KA_MINT_RECONCILE_INCOMPLETE` | The mint was verified, but the lifecycle does not yet name the sealed version and the asset's UAL as published. Retry; the retry resumes. |
| 409 `KA_MINT_RECONCILE_REFUSED` | The node holds nothing it can complete. One of:<br>- the asset is not a finalized graph-scoped asset;<br>- its seal or UAL names another chain;<br>- its lifecycle records another VM version;<br>- its share is gone and there is no verified local record of the sealed content, so there is nothing to complete;<br>- an interrupted publish consumed its share before the finalization gossip and catalog transition. Reconcile cannot finish those from the VM record alone, so the asset stays unrecorded. Keep its evidence for a follow-up. |
| 409 `VM_PUBLISH_PRECONDITION` or `PUBLISH_NOT_FULL_SHARE` | The asset is not a finalized, fully shared asset. |
| 409 `AMBIGUOUS_ASSERTION_AUTHOR` or `ASSERTION_AUTHOR_NOT_RESIDENT` | Several authors have an asset with this name, or the selected author has none. Retry with one of the returned `candidates` as the selected author. |

An interrupted attempt is resumed by retrying. While the asset's complete share is still in shared memory, the node records the mint through the publish path, keeping a matching record an earlier attempt left. Once an attempt has consumed the share and gone past its finalization gossip, the VM content and its metadata are already recorded. "Past its finalization gossip" means it cleared the share marker or stamped the VM pointer, both of which the publish path does only after the gossip. The retry then verifies that record against the seal, verifies the mint again, writes the receipt and completes only the lifecycle. Reconcile reports `already-published` only when the lifecycle names the sealed version as its VM version and the asset's UAL as its published UAL. For a first mint, the assertion's publish receipt (transaction and block) must also be present. The publish path writes that receipt best-effort, so if it is missing, the next reconcile writes it. The command sends nothing, so it is safe to retry. On a large node, a 500 with "Triple-store response exceeds byte limit" can come from a concurrent query sharing the store's graph listing during the shared-memory cleanup. Retry it while the node serves no other queries.

A plain `dkg ka publish` retry also adopts the asset's own mint when the contract reports the reserved id already minted. That retry still collects core ACKs first, and under the per-publish approval policy it can send a TRAC approval before gas estimation reverts. Prefer `reconcile`.

Agent-scoped credentials cannot invoke this endpoint. Keep the successful response as operational evidence.
