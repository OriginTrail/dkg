# RFC-64 Gate 2 multi-asset completeness evidence contract

A closed deterministic contract for the exact bounded product slice implemented
by the Gate 2 producer, receiver, and inventory-completeness helper: one
public/open author-catalog bucket containing **1..1,024 rows**.

> Fixture harness only. `productBoundary` is always `not-connected` and
> `gateEvaluation` is always `not-evaluated`. A true `fixtureComplete` proves
> only that the contract and its generated fixture agree; it is not a Gate 2
> result. A real two-process adapter still has to supply product observations.

## What is bound

The `raw@1` artifact carries an authored and a received observation. Its
fail-closed verifier checks:

- the exact nine-field catalog scope and its independently recomputed
  `dkg-author-catalog-scope-v1` digest;
- the receiver's exact authored catalog-head digest;
- head `totalRows`, signed bucket row count, receiver row count, and the actual
  signed/activated array lengths;
- strict mathematical `kaId` order, independent duplicate-`kaId` and
  duplicate-UAL rejection, and the 1..1,024 bucket bound;
- each UAL's network, author, canonical KA number, and packed `kaId`;
- exact per-row `catalogRowDigest`, projection/content digest, author-seal
  digest, opaque-bundle digest, UAL, and activated triple count;
- missing, extra, duplicate, and mismatched received rows; and
- the receiver's declared applied-inventory digest, independently recomputed
  with the production `dkg-rfc64-applied-inventory-v1` binary framing in numeric
  `kaId` order.

The legacy applied-inventory digest does not include `bundleDigest`. The
contract therefore keeps bundle equality as a separate mandatory invariant;
its mutation test proves that a wrong bundle is rejected even when the legacy
inventory digest remains unchanged.

Serialization is bounded RFC 8785 JCS plus exactly one trailing LF. The JS
boundary accepts only exact data descriptors, rejects accessors without invoking
them, snapshots Proxies without property gets, caps rows before enumerating
their keys, and caps depth, nodes, strings, input bytes, and output bytes.

## Real two-process adapter mapping

The adapter should build one raw artifact from these product values. Entries
marked **gap** exist in the internal producer result but are not yet carried by
`PublishOpenAuthorCatalogExactSetSuccessorResultV1`; exposing detached read-only
copies is the minimal product-to-harness adapter seam.

| Contract field | Product source |
| --- | --- |
| `authored.catalogScope` | **gap:** expose the exact `deriveAuthorCatalogScopeFromHeadV1(head.payload)` snapshot from `publishOpenAuthorCatalogExactSetSuccessorV1` |
| `authored.declaredCatalogScopeDigest` | **gap:** expose `result.assets[0].projection.catalogScopeDigest` (and retain the producer's all-assets equality check) |
| `authored.catalogHeadDigest` | existing public result `.headObjectDigest` |
| `authored.catalogHeadTotalRows` | existing public result `.inventoryRowCount` (assigned directly from `head.payload.totalRows`) |
| `authored.signedBucketRowCount` | **gap:** expose `produced.publication.bucket.payload.rows.length.toString()` independently of head count |
| `authored.signedRows[].kaId` | existing public result `.assets[].kaId` |
| `authored.signedRows[].catalogRowDigest` | existing public result `.assets[].catalogRowDigest` |
| `authored.signedRows[].contentDigest` | existing public result `.assets[].contentDigest` |
| `authored.signedRows[].sealDigest` | **gap:** expose internal `produced.assets[].sealBinding.sealDigest` |
| `authored.signedRows[].bundleDigest` | existing public result `.assets[].bundleDigest` |
| `authored.signedRows[].kaUal` | existing public result `.assets[].kaUal` |
| `authored.signedRows[].activatedTripleCount` | **gap:** expose a checked safe-integer conversion of internal `produced.assets[].projection.publicTripleCount` |
| `received.catalogHeadDigest` | `Rfc64PublicCatalogNativeMultiAssetActivationEvidenceV1.catalogHeadDigest` |
| `received.declaredInventoryDigest` | `.inventoryDigest`, also equal to the durable applied-head post-read |
| `received.inventoryRowCount` | `.inventoryRowCount` |
| `received.activatedRows` | `.rows`, projected to the seven contract row fields (omit `swmGraph` and `authorship`) |

The receiver side is already sufficient. The author side needs the five
read-only gaps above; without them, a harness would have to synthesize scope,
bucket count, seal, or triple-count claims from its own request instead of
recording verified product output. After that small seam, orchestration can
expose the exact-set publish and multi-row synchronization calls through two real
DKGAgent child processes, carry these values verbatim, read the receiver's
durable applied head using the exposed scope digest, and use a separate connected
Gate 2 schema to make a real gate disposition.

## Commands

```sh
cd devnet/rfc64-gate2-multi-asset-completeness
tsc --noEmit -p tsconfig.json
node --experimental-strip-types --test test/completeness.test.ts
node --experimental-strip-types src/cli/generate.ts 8 > raw.json
node --experimental-strip-types src/cli/verify.ts raw.json > verdict.json
```

Two identical generator invocations must produce byte-identical raw artifacts;
two verifier invocations over them must produce byte-identical verdicts.
