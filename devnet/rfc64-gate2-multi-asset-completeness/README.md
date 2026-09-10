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

The connected adapter builds one raw artifact from these product values. The
author-side result fields are detached, read-only observations of the already
verified signed successor and its durable bundles.

| Contract field | Product source |
| --- | --- |
| `authored.catalogScope` | `PublishOpenAuthorCatalogExactSetSuccessorResultV1.catalogScope`, derived from the actual signed successor head |
| `authored.declaredCatalogScopeDigest` | `.catalogScopeDigest`, checked against predecessor scope and every verified asset projection |
| `authored.catalogHeadDigest` | existing public result `.headObjectDigest` |
| `authored.catalogHeadTotalRows` | existing public result `.inventoryRowCount` (assigned directly from `head.payload.totalRows`) |
| `authored.signedBucketRowCount` | `.signedBucketRowCount`, sourced independently from the signed bucket |
| `authored.signedRows[].kaId` | existing public result `.assets[].kaId` |
| `authored.signedRows[].catalogRowDigest` | existing public result `.assets[].catalogRowDigest` |
| `authored.signedRows[].contentDigest` | existing public result `.assets[].contentDigest` |
| `authored.signedRows[].sealDigest` | `.assets[].sealDigest` |
| `authored.signedRows[].bundleDigest` | existing public result `.assets[].bundleDigest` |
| `authored.signedRows[].kaUal` | existing public result `.assets[].kaUal` |
| `authored.signedRows[].activatedTripleCount` | `.assets[].activatedTripleCount`, a checked safe-integer conversion |
| `received.catalogHeadDigest` | `Rfc64PublicCatalogNativeMultiAssetActivationEvidenceV1.catalogHeadDigest` |
| `received.declaredInventoryDigest` | `.inventoryDigest`, also equal to the durable applied-head post-read |
| `received.inventoryRowCount` | `.inventoryRowCount` |
| `received.activatedRows` | `.rows`, projected to the seven contract row fields (omit `swmGraph` and `authorship`) |

The receiver side and author side are now both sufficient for a connected
adapter. The orchestration exposes exact-set publication and multi-row
synchronization through two real DKGAgent child processes, carries these values
verbatim, and reads the receiver's durable applied head using the exposed scope
digest. A separate connected schema makes the real gate disposition.

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

## Public catalog finalized-policy process proof

`pnpm live:public-finalized-catalog` clean-builds the exact repository HEAD,
then starts an author and receiver as distinct real `DKGAgent` OS processes.
Both this command and the legacy `pnpm live:public-vm` alias execute
`launch-public-finalized-catalog.ts`, which loads `public-finalized-catalog.ts`.
Set `DKG_RFC64_PUBLIC_FINALIZED_CATALOG_ARTIFACT` to override the artifact path;
the old `DKG_RFC64_M2_PUBLIC_VM_ARTIFACT` variable remains a fallback alias.

The receiver learns numeric Context Graph id `14` from a production
`ContextGraphCreated` poller event and resolves its current chain authority.
The author uses that exact policy and ownership scope for its catalog. The
receiver verifies finalized policy through its adapter-owned loopback RPC
before committing the public catalog head.

`artifacts/public-finalized-catalog-result.json` proves the exact two-quad SWM
projection, durable applied-head equality, peer/process identity separation,
and the clean-build runtime manifest. It also requires zero VM rows and no
fabricated confirmed VM metadata: public catalog reconciliation is policy-only,
as specified by the production applied-head coordinator. This proof does not
claim public VM materialization. Private finalized-VM recovery has its separate
CP2/CP3 harnesses.
