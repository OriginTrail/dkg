import { computeControlObjectDigestHex, computeSwmAuthorInventoryScopeDigestV1, computeSwmAuthorInventoryRowsDigestV1,
  compareSwmAuthorInventoryRowsV1, computeAuthorCatalogScopeDigestV1, computeAuthorCatalogBucketObjectDigestV1,
  computeAuthorCatalogDirectoryNodeObjectDigestV1, canonicalizeAuthorCatalogBucketPayloadBytesV1 } from '../../packages/core/dist/index.js';
import { inventoryRow } from './inventory-commitments.mjs';
const hex64 = n => '0x' + BigInt(n).toString(16).padStart(16, '0');
const digest = byte => '0x' + byte.repeat(32);
export function inventoryScopeFixture(campaign, inventoryRows, catalogRows, era = '0') {
  const scope = { networkId: 'base:84532', contextGraphId: campaign.contextGraphId, authorAddress: campaign.author.toLowerCase(),
    subGraphName: null, era, governanceChainId: '84532', governanceContractAddress: '0x' + '66'.repeat(20), ownershipTransitionDigest: digest('77') };
  const scopeDigest = computeSwmAuthorInventoryScopeDigestV1(scope);
  const wrap = (objectType, payload) => ({ objectType, issuer: scope.authorAddress, signatureSuite: 'eip191-personal-sign-digest-v1', signatureEvidence: { kind: 'none' }, payload });
  const swm = inventoryRows.map((r, i) => ({ ka_ual: `did:dkg:${scope.networkId}/${scope.authorAddress}/${i + 1}`,
    assertion_version_u64be: hex64(1), share_operation_id: `operation-${r.assertion_coordinate}`, projection_digest: digest('00'),
    public_triple_count_u64be: hex64(8), private_triple_count_u64be: hex64(0), seal_digest: digest('44'),
    shared_at_u64be: hex64(0), expires_at_u64be: null, ...r, inventory_scope_digest: scopeDigest, author_address: scope.authorAddress }));
  const envelope = wrap('SwmAuthorInventoryHeadV1', { ...scope, totalRows: String(swm.length), version: '0', previousHeadDigest: null,
    rowsDigest: computeSwmAuthorInventoryRowsDigestV1(swm.map(inventoryRow).sort(compareSwmAuthorInventoryRowsV1)), issuedAt: '0' });
  // Codec-valid synthetic signature for a fixture, not a claim of cryptographic issuer verification.
  const signed = { ...envelope, objectDigest: computeControlObjectDigestHex(envelope), signature: '0x' + '11'.repeat(65) };
  const head = { inventory_scope_digest: scopeDigest, author_address: scope.authorAddress, current_head_digest: signed.objectDigest,
    total_rows_u64be: hex64(swm.length), signed_head_envelope: '0x' + Buffer.from(JSON.stringify(signed)).toString('hex') };
  const catalogScope = { ...scope, bucketCount: '1' }, catalogScopeDigest = computeAuthorCatalogScopeDigestV1(catalogScope);
  const rows = catalogRows.map((r, i) => ({ assertionVersion: '1', sealDigest: digest('44'), projectionId: 'cg-shared-v1', projectionDigest: digest('00'),
    transfer: { codec: 'dkg-ka-bundle-v1', projectionId: 'cg-shared-v1', projectionDigest: digest('00'), byteLength: '16', chunkSize: '262144', chunkCount: '1', blobDigest: digest('11'), chunkTreeRoot: digest('22') },
    ...r, kaId: r.kaId && BigInt(r.kaId) >> 96n ? r.kaId : ((BigInt(scope.authorAddress) << 96n) | BigInt(r.kaId ?? i + 1)).toString(),
  })).sort((a, b) => BigInt(a.kaId) < BigInt(b.kaId) ? -1 : 1);
  const bucket = rows.length ? wrap('AuthorCatalogBucketV1', { catalogScopeDigest, era, bucketCount: '1', bucketId: '0', rows }) : null;
  const descriptor = { bucketId: '0', rowCount: String(rows.length), byteLength: bucket ? String(canonicalizeAuthorCatalogBucketPayloadBytesV1(bucket.payload).byteLength) : '0',
    bucketDigest: bucket ? computeAuthorCatalogBucketObjectDigestV1(bucket) : digest('00') };
  const directory = wrap('AuthorCatalogDirectoryNodeV1', { catalogScopeDigest, era, level: '0', firstBucketId: '0', entries: [descriptor] });
  const catalogHead = wrap('AuthorCatalogHeadV1', { ...catalogScope, totalRows: String(rows.length), version: '0', previousHeadDigest: null, issuedAt: '0',
    directoryHeight: '0', directoryRootDigest: computeAuthorCatalogDirectoryNodeObjectDigestV1(directory, '1'), catalogIssuerDelegationDigest: digest('33') });
  const headDigest = computeControlObjectDigestHex(catalogHead), catalog = { head: catalogHead, rows: structuredClone(rows), objects: [catalogHead, directory, ...(bucket ? [bucket] : [])] };
  const authority = { contextGraphId: scope.contextGraphId, authorityState: 'accepted', authorityFreshness: 'current', phase: 'complete', authorHeadCount: 1,
    authorityEra: era, expectedCatalogHeadDigest: headDigest, appliedCatalogHeadDigest: headDigest };
  return { capture: { version: 2, contextGraphId: scope.contextGraphId, coverage: 'all-graph-scopes', scopes: [{ head, swm }],
    applied: [{ catalog_scope_digest: catalogScopeDigest, author_address: scope.authorAddress, current_catalog_head_digest: headDigest }], swm },
    catalogs: [catalog], status: { status: 200, value: { rfc64Catalog: { contextGraphs: [authority] } } } };
}
