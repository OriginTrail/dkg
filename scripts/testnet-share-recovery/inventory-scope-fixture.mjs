import { computeControlObjectDigestHex, computeSwmAuthorInventoryScopeDigestV1 } from '../../packages/core/dist/index.js';
export function inventoryScopeFixture(campaign, inventoryRows, catalogRows, era = '0') {
  const scope = { networkId: 'base:84532', contextGraphId: campaign.contextGraphId, authorAddress: campaign.author.toLowerCase(),
    subGraphName: null, era, governanceChainId: '84532', governanceContractAddress: '0x' + '66'.repeat(20), ownershipTransitionDigest: '0x' + '77'.repeat(32) };
  const scopeDigest = computeSwmAuthorInventoryScopeDigestV1(scope);
  const envelope = { objectType: 'SwmAuthorInventoryHeadV1', issuer: scope.authorAddress, signatureSuite: 'eip191-personal-sign-digest-v1',
    signatureEvidence: { kind: 'none' }, payload: { ...scope, totalRows: String(inventoryRows.length), version: '0', previousHeadDigest: null,
      rowsDigest: '0x' + '88'.repeat(32), issuedAt: '0' } };
  const swm = inventoryRows.map(r => ({ ...r, inventory_scope_digest: scopeDigest, author_address: scope.authorAddress }));
  const head = { inventory_scope_digest: scopeDigest, author_address: scope.authorAddress, current_head_digest: computeControlObjectDigestHex(envelope),
    total_rows_u64be: '0x' + BigInt(swm.length).toString(16).padStart(16, '0'), signed_head_envelope: '0x' + Buffer.from(JSON.stringify(envelope)).toString('hex') };
  const catalog = { head: { ...envelope, objectType: 'AuthorCatalogHeadV1', payload: { ...scope, totalRows: String(catalogRows.length), version: '0', previousHeadDigest: null, issuedAt: '0',
    bucketCount: '1', directoryHeight: '0', directoryRootDigest: '0x' + '22'.repeat(32), catalogIssuerDelegationDigest: '0x' + '33'.repeat(32) } }, rows: catalogRows };
  const authority = { contextGraphId: scope.contextGraphId, authorityState: 'accepted', authorityFreshness: 'current', phase: 'complete', authorHeadCount: 1,
    authorityEra: era, expectedCatalogHeadDigest: computeControlObjectDigestHex(catalog.head), appliedCatalogHeadDigest: computeControlObjectDigestHex(catalog.head) };
  return { capture: { version: 2, contextGraphId: scope.contextGraphId, coverage: 'all-graph-scopes', scopes: [{ head, swm }], applied: [], swm },
    catalogs: [catalog], status: { status: 200, value: { rfc64Catalog: { contextGraphs: [authority] } } } };
}
