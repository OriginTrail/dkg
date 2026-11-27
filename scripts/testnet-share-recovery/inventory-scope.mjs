import { unsigned, verifyInventoryCommitment, verifyCatalogCommitment } from './inventory-commitments.mjs';
import { pathToFileURL } from 'node:url';
import { computeAuthorCatalogHeadObjectDigestV1, computeSwmAuthorInventoryHeadObjectDigestV1, computeSwmAuthorInventoryScopeDigestV1,
  snapshotAuthorLaneScopeV1 } from '../../packages/core/dist/index.js';

export const encodeInventory = value => JSON.parse(JSON.stringify(value,
  (_key, v) => v?.type === 'Buffer' ? '0x' + Buffer.from(v.data).toString('hex') : v));

/** Keep every graph scope, including other authors and obsolete lanes, in one SQLite snapshot. */
export function collectInventoryScopes(db, contextGraphId) {
  return db.transaction(() => {
    const scopes = db.prepare('SELECT * FROM rfc64_swm_author_inventory_heads_v1').all()
      .filter(head => JSON.parse(head.signed_head_envelope.toString()).payload.contextGraphId === contextGraphId)
      .map(head => ({ head, swm: db.prepare('SELECT * FROM rfc64_swm_author_inventory_rows_v1 WHERE inventory_scope_digest=? AND author_address=? ORDER BY assertion_coordinate')
        .all(head.inventory_scope_digest, head.author_address) }));
    return { version: 2, contextGraphId, coverage: 'all-graph-scopes', scopes,
      applied: db.prepare('SELECT * FROM rfc64_applied_catalog_heads_v1').all() };
  })();
}

/** Resolve from captured current authority, never from inventory row counts or head order. */
export function verifyInventoryScope(campaign, capture, catalogs, status) {
  const errors = [], result = { valid: false, errors, capturedScopes: capture.scopes?.length ?? 0, rows: [], catalogRows: [] };
  try {
    if (capture.version !== 2 || capture.coverage !== 'all-graph-scopes' || capture.contextGraphId !== campaign.contextGraphId
      || !Array.isArray(capture.scopes)) throw Error('Missing complete graph-scope capture');
    const authorities = status?.value?.rfc64Catalog?.contextGraphs?.filter(c => c.contextGraphId === campaign.contextGraphId) ?? [];
    if (status?.status !== 200 || authorities.length !== 1) throw Error('Missing or ambiguous captured graph authority');
    const authority = authorities[0];
    // This campaign has one author. Multiple author heads need an explicit per-author authority witness.
    if (authority.authorityState !== 'accepted' || authority.authorityFreshness !== 'current' || !['complete', 'known-incomplete'].includes(authority.phase) || authority.authorHeadCount !== 1
      || authority.expectedCatalogHeadDigest !== authority.appliedCatalogHeadDigest) {
      throw Error('Inventory authority is not current or is not a single-author campaign');
    }
    result.authorityPhase = authority.phase;
    const current = catalogs.filter(c => computeAuthorCatalogHeadObjectDigestV1(unsigned(c.head)) === authority.appliedCatalogHeadDigest);
    if (current.length !== 1) throw Error('Missing or ambiguous current catalog head');
    const committedCatalog = verifyCatalogCommitment(current[0], capture.applied);
    const scope = snapshotAuthorLaneScopeV1(current[0].head.payload);
    if (scope.contextGraphId !== campaign.contextGraphId || scope.authorAddress !== campaign.author.toLowerCase()
      || scope.subGraphName !== null || scope.era !== authority.authorityEra) throw Error('Catalog authority lane differs from campaign');
    const expectedScope = computeSwmAuthorInventoryScopeDigestV1(scope);
    result.scopeDigest = expectedScope; result.authorAddress = scope.authorAddress;
    const matching = [];
    for (const entry of capture.scopes) {
      const head = entry.head, envelope = JSON.parse(Buffer.from(head.signed_head_envelope.slice(2), 'hex'));
      const actualScope = snapshotAuthorLaneScopeV1(envelope.payload), scopeDigest = computeSwmAuthorInventoryScopeDigestV1(actualScope);
      if (actualScope.contextGraphId !== campaign.contextGraphId || scopeDigest !== head.inventory_scope_digest
        || actualScope.authorAddress !== head.author_address || computeSwmAuthorInventoryHeadObjectDigestV1(unsigned(envelope)) !== head.current_head_digest
        || !/^0x[0-9a-f]{16}$/.test(head.inventory_version_u64be) || BigInt(head.inventory_version_u64be) !== BigInt(envelope.payload.version)
        || head.rows_digest !== envelope.payload.rowsDigest
        || BigInt(head.total_rows_u64be) !== BigInt(entry.swm.length) || BigInt(envelope.payload.totalRows) !== BigInt(entry.swm.length)
        || entry.swm.some(r => r.inventory_scope_digest !== scopeDigest || r.author_address !== actualScope.authorAddress)) {
        throw Error('Inventory head/rows have inconsistent scope provenance');
      }
      verifyInventoryCommitment(envelope, entry.swm);
      if (scopeDigest === expectedScope && head.author_address === scope.authorAddress) matching.push(entry);
    }
    if (matching.length !== 1) throw Error('Missing or ambiguous authoritative inventory scope');
    result.rows = matching[0].swm;
    result.catalogRows = committedCatalog.rows;
    result.catalogScopeDigest = committedCatalog.scopeDigest; result.catalogHeadDigest = committedCatalog.headDigest;
    result.rowCommitmentsVerified = true;
    result.excludedInventoryScopes = capture.scopes.filter(e => e !== matching[0]).map(e => ({ scopeDigest: e.head.inventory_scope_digest, author: e.head.author_address, rows: e.swm.length }));
    result.excludedCatalogHeads = catalogs.filter(c => c !== current[0]).map(c => ({ headDigest: computeAuthorCatalogHeadObjectDigestV1(unsigned(c.head)), rows: c.rows.length }));
    result.headDigest = matching[0].head.current_head_digest;
    result.valid = true;
  } catch (error) { errors.push(error.message); }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  console.log(JSON.stringify(verifyInventoryScope(input.campaign, input.capture, input.catalogs, input.status)));
}
