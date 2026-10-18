# Repair a published Knowledge Asset descriptor

Use this procedure for #3362: a confirmed asset's original-name and UAL descriptors return 404 because its local lifecycle `state` was removed by an interrupted write. Exact VM content and chain ownership alone do not authorize a repair.

If the original publisher job is still retained, upgraded queue recovery repairs matching incomplete lifecycle metadata before finalizing that job. Do not clear an unresolved job or submit another publication.

For an already-cleared job, a node administrator can verify one asset with:

```http
POST /api/knowledge-assets/<encoded-original-name>/vm/repair-descriptor
Authorization: Bearer <node-operator-token>
Content-Type: application/json

{
  "contextGraphId": "<original-context-graph>",
  "kaUal": "<confirmed-graph-scoped-UAL>",
  "dryRun": true
}
```

Include `subGraphName` when the asset belongs to a subgraph. Omission of `dryRun` also means verification only. A successful response has `status: "verified"`, the verified author, assertion version, root and transaction hash. To apply the repair, repeat the same request with `dryRun: false`; success returns `status: "repaired"`. Verify both descriptor identifiers and the exact VM content afterwards.

The operation sends no blockchain transaction. It completes the confirmed VM lifecycle projection on the existing subject through the lifecycle writer and is idempotent. Repair preserves the already-verified VM pointer and layer, including on compatibility stores, so a transient failure cannot delete the evidence needed for another attempt. This also repairs a first publication interrupted before its published UAL and VM graph pointer were stamped. It requires an compatible surviving VM projection, unambiguous name/author/KA/version/reservation, matching local pointers, exact content commitment, canonical transaction evidence, a final receipt, current chain version and context-graph membership. Private publications also require the existing trusted private-control evidence.

HTTP 409 means the proof is insufficient, inconsistent, superseded, or verification failed. Preserve the metadata and receipt evidence for diagnosis; do not remove conflicting fields to force acceptance. HTTP 503 / `KA_DESCRIPTOR_REPAIR_BUSY` means another repair is still active. Read verification has a 30-second deadline; underlying reads retain backpressure until settled. Lock waiting and reads share the deadline; an entered metadata write is awaited to completion. Agent-scoped credentials cannot invoke this endpoint.

This repairs interrupted publication projections with a retained confirmed VM root, not arbitrary metadata loss. It does not modify content, choose among duplicate identities, replace newer drafts, or reconstruct absent receipts. Keep a backup of the node store and the successful verification response as operational evidence.
