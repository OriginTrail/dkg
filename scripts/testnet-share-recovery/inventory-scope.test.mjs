import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defineCampaign } from './campaign-manifest.mjs';
import { createRequire } from 'node:module';
import { collectInventoryScopes, encodeInventory, verifyInventoryScope } from './inventory-scope.mjs';
import { inventoryScopeFixture } from './inventory-scope-fixture.mjs';
import { verifyIdentityTuples } from './identity-tuples.mjs';
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
const Database = require('better-sqlite3');
const campaign = { ...defineCampaign('fixture'), contextGraphId: 'test-scope', author: '0x' + '11'.repeat(20) };
const kaId = ((BigInt(campaign.author) << 96n) | 1n).toString(), sealDigest = '0x' + '44'.repeat(32);
const kaUal = `did:dkg:base:84532/${campaign.author}/1`;
const expected = [{ name: 'asset', sealDigest, seal: { reservedKaId: kaId, kaUal, assertionVersion: '1' } }];
const row = { assertion_coordinate: 'asset', ka_ual: kaUal, assertion_version_u64be: '0x0000000000000001', seal_digest: sealDigest };
const catalogRows = [{ assertionCoordinate: 'asset', kaId, assertionVersion: '1', sealDigest }];
function collect(entries, applied) {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE rfc64_swm_author_inventory_heads_v1 (inventory_scope_digest BLOB, author_address BLOB, current_head_digest BLOB, total_rows_u64be BLOB, signed_head_envelope BLOB); CREATE TABLE rfc64_swm_author_inventory_rows_v1 (inventory_scope_digest BLOB, author_address BLOB, assertion_coordinate TEXT, ka_ual TEXT, assertion_version_u64be BLOB, share_operation_id TEXT, projection_digest BLOB, public_triple_count_u64be BLOB, private_triple_count_u64be BLOB, seal_digest BLOB, shared_at_u64be BLOB, expires_at_u64be BLOB); CREATE TABLE rfc64_applied_catalog_heads_v1 (catalog_scope_digest BLOB, author_address BLOB, current_catalog_head_digest BLOB);');
    const insert = (table, value) => db.prepare(`INSERT INTO ${table} (${Object.keys(value).join(',')}) VALUES (${Object.keys(value).map(() => '?').join(',')})`)
      .run(...Object.values(value).map(v => typeof v === 'string' && v.startsWith('0x') ? Buffer.from(v.slice(2), 'hex') : v));
    for (const entry of entries) {
      insert('rfc64_swm_author_inventory_heads_v1', entry.head);
      for (const r of entry.swm) insert('rfc64_swm_author_inventory_rows_v1', r);
    }
    for (const r of applied) insert('rfc64_applied_catalog_heads_v1', r);
    return encodeInventory(collectInventoryScopes(db, campaign.contextGraphId));
  } finally { db.close(); }
}
const verify = f => verifyInventoryScope(campaign, f.capture, f.catalogs, f.status);

test('SQLite collector preserves both scopes; complete obsolete rows cannot conceal empty current inventory in either order', () => {
  const old = inventoryScopeFixture(campaign, [row], catalogRows, '0');
  const current = inventoryScopeFixture(campaign, [], catalogRows, '1');
  for (const entries of [[...old.capture.scopes, ...current.capture.scopes], [...current.capture.scopes, ...old.capture.scopes]]) {
    const capture = collect(entries, current.capture.applied), proof = verify({ ...current, capture });
    assert.equal(capture.scopes.length, 2); assert.equal(proof.valid, true); assert.equal(proof.rows.length, 0);
    assert.equal(proof.scopeDigest, current.capture.scopes[0].head.inventory_scope_digest);
    assert.equal(verifyIdentityTuples(expected, catalogRows, proof.rows).exactInventoryIdentity, false);
  }
  // Negative control: the original first-head algorithm certifies the obsolete complete set.
  const capture = collect([...old.capture.scopes, ...current.capture.scopes], current.capture.applied);
  assert.equal(verifyIdentityTuples(expected, catalogRows, capture.scopes[0].swm).exactInventoryIdentity, true);
});

test('authoritative inventory proof accepts exact current rows and preserves intentional baseline gaps', () => {
  const f = inventoryScopeFixture(campaign, [row], catalogRows), proof = verify({ ...f, capture: collect(f.capture.scopes, f.capture.applied) });
  assert.equal(proof.valid, true); assert.equal(verifyIdentityTuples(expected, catalogRows, proof.rows).exactInventoryIdentity, true);
  const baseline = inventoryScopeFixture(campaign, [], []);
  baseline.status.value.rfc64Catalog.contextGraphs[0].phase = 'known-incomplete';
  const missing = verify(baseline);
  assert.equal(missing.valid, true); assert.equal(verifyIdentityTuples(expected, [], missing.rows).exactInventoryIdentity, false);
});

test('scope proof rejects wrong author, stale authority, ambiguous/missing scope and mismatched head/row provenance', () => {
  for (const mutate of [
    f => { f.capture.scopes = []; }, f => { f.capture.scopes.push(structuredClone(f.capture.scopes[0])); },
    f => { f.capture.coverage = 'legacy-selected-scope'; },
    f => { f.capture.scopes[0].head.author_address = '0x' + '22'.repeat(20); },
    f => { f.capture.scopes[0].head.inventory_scope_digest = '0x' + '22'.repeat(32); },
    f => { f.capture.scopes[0].swm[0].inventory_scope_digest = '0x' + '22'.repeat(32); },
    f => { f.capture.scopes[0].swm[0].author_address = '0x' + '22'.repeat(20); },
    f => { f.status.value.rfc64Catalog.contextGraphs[0].authorityFreshness = 'stale'; },
    f => { f.status.value.rfc64Catalog.contextGraphs[0].authorityState = 'pending'; },
    f => { f.status.value.rfc64Catalog.contextGraphs[0].authorityEra = '1'; },
    f => { f.status.value.rfc64Catalog.contextGraphs[0].phase = 'reconciling'; },
    f => { f.status.value.rfc64Catalog.contextGraphs[0].expectedCatalogHeadDigest = '0x' + '22'.repeat(32); },
    f => { f.status.value.rfc64Catalog.contextGraphs[0].authorHeadCount = 2; },
    f => { f.status.value.rfc64Catalog.contextGraphs[0].appliedCatalogHeadDigest = '0x' + '22'.repeat(32); },
    f => { f.catalogs[0].head.payload.authorAddress = '0x' + '22'.repeat(20); },
  ]) {
    const f = inventoryScopeFixture(campaign, [row], catalogRows); mutate(f);
    const proof = verify(f); assert.equal(proof.valid, false); assert.ok(proof.errors.length);
  }
});


test('identity entry point recomputes current scope rather than trusting a stale flat inventory export', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-scope-'));
  try {
    const old = inventoryScopeFixture(campaign, [row], catalogRows, '0');
    const current = inventoryScopeFixture(campaign, [], catalogRows, '1');
    const capture = { ...collect([...old.capture.scopes, ...current.capture.scopes], current.capture.applied), swm: old.capture.swm };
    const dir = path.join(cwd, '.tmp/2963/evidence/fixture'); fs.mkdirSync(path.join(dir, 'fixed-deadline'), { recursive: true });
    for (const [name, value] of [['campaign-manifest.json', campaign], ['seal-proof.json', expected],
      ['fixed-deadline/inventory.json', capture], ['fixed-deadline/catalogs.json', current.catalogs], ['fixed-deadline/-api-status.json', current.status]]) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    }
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./identity-proof.mjs', import.meta.url)), 'fixture', 'fixed-deadline'], { cwd, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const proof = JSON.parse(fs.readFileSync(path.join(dir, 'identity-proof.json')));
    assert.equal(proof.exactInventoryIdentity, false, 'obsolete complete scope hid empty current inventory');
    assert.equal(proof.expectedCount, 1); assert.equal(proof.inventoryCount, 0); assert.equal(proof.inventoryScope.valid, true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});


test('obsolete catalog rows cannot conceal an empty authoritative catalog', () => {
  const old = inventoryScopeFixture(campaign, [row], catalogRows, '0');
  const current = inventoryScopeFixture(campaign, [row], [], '1');
  const catalogs = [...old.catalogs, ...current.catalogs];
  const proof = verify({ ...current, catalogs, capture: collect([...old.capture.scopes, ...current.capture.scopes], current.capture.applied) });
  assert.equal(proof.valid, true);
  const identities = verifyIdentityTuples(expected, proof.catalogRows, proof.rows);
  assert.equal(identities.exactInventoryIdentity, true); assert.equal(identities.exactCatalogIdentity, false);
  assert.equal(verifyIdentityTuples(expected, catalogs.flatMap(c => c.rows), proof.rows).exactCatalogIdentity, true,
    'negative control: unscoped catalog aggregation hides the missing current catalog row');
});


test('scope CLI reads a full capture through a pipe without synchronous EAGAIN', () => {
  const fixture = inventoryScopeFixture(campaign, Array.from({ length: 1000 }, (_, i) => ({ ...row,
    assertion_coordinate: `asset-${i}`, ka_ual: `did:dkg:base:84532/${campaign.author}/${i + 1}` })), catalogRows);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./inventory-scope.mjs', import.meta.url))], {
    input: JSON.stringify({ campaign, ...fixture }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).valid, true);
});


test('unchanged heads reject same-count row substitutions and incomplete object commitments', () => {
  for (const mutate of [
    f => { f.capture.scopes[0].swm[0].seal_digest = '0x' + '55'.repeat(32); },
    f => { f.capture.scopes[0].swm[0].share_operation_id = 'other-operation'; },
    f => { f.catalogs[0].rows[0].sealDigest = '0x' + '55'.repeat(32); },
    f => { f.catalogs[0].objects.find(o => o.objectType === 'AuthorCatalogBucketV1').payload.rows[0].sealDigest = '0x' + '55'.repeat(32); },
    f => { f.catalogs[0].objects.find(o => o.objectType === 'AuthorCatalogDirectoryNodeV1').payload.entries[0].byteLength = '1'; },
    f => { f.catalogs[0].objects.pop(); },
    f => { f.catalogs[0].objects.push(structuredClone(f.catalogs[0].objects[0])); },
    f => { f.capture.applied[0].author_address = '0x' + '22'.repeat(20); },
    f => { f.capture.applied[0].catalog_scope_digest = '0x' + '22'.repeat(32); },
    f => { f.capture.applied[0].current_catalog_head_digest = '0x' + '22'.repeat(32); },
    f => { f.capture.applied.push(structuredClone(f.capture.applied[0])); },
  ]) {
    const f = inventoryScopeFixture(campaign, [row], catalogRows);
    const heads = JSON.stringify([f.capture.scopes[0].head, f.catalogs[0].head, f.status]);
    mutate(f); assert.equal(JSON.stringify([f.capture.scopes[0].head, f.catalogs[0].head, f.status]), heads);
    const proof = verify(f); assert.equal(proof.valid, false, 'certified rows or applied keys outside unchanged head commitments');
    assert.ok(proof.errors.length);
  }
});

test('SQLite applied-head lookup must match the selected author and full catalog scope', () => {
  const f = inventoryScopeFixture(campaign, [row], catalogRows);
  for (const key of ['author_address', 'catalog_scope_digest']) {
    const applied = structuredClone(f.capture.applied); applied[0][key] = key === 'author_address' ? '0x' + '22'.repeat(20) : '0x' + '22'.repeat(32);
    const capture = collect(f.capture.scopes, applied);
    assert.equal(verify({ ...f, capture }).valid, false);
  }
});

test('catalog proof verifies every child of a multi-level directory and its committed byte length', async () => {
  const { computeAuthorCatalogScopeDigestV1, computeAuthorCatalogDirectoryNodeObjectDigestV1,
    canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1, computeAuthorCatalogHeadObjectDigestV1 } = await import('../../packages/core/dist/index.js');
  const build = badLength => {
    const f = inventoryScopeFixture(campaign, [], []), head = f.catalogs[0].head;
    const keys = ['networkId', 'contextGraphId', 'authorAddress', 'era', 'governanceChainId', 'governanceContractAddress', 'ownershipTransitionDigest', 'subGraphName'];
    const scope = { ...Object.fromEntries(keys.map(k => [k, head.payload[k]])), bucketCount: '512' };
    const scopeDigest = computeAuthorCatalogScopeDigestV1(scope);
    const node = payload => ({ ...head, objectType: 'AuthorCatalogDirectoryNodeV1', payload });
    const leaves = [0, 256].map(first => node({ catalogScopeDigest: scopeDigest, era: '0', level: '0', firstBucketId: String(first),
      entries: Array.from({ length: 256 }, (_, i) => ({ bucketId: String(first + i), rowCount: '0', byteLength: '0', bucketDigest: '0x' + '00'.repeat(32) })) }));
    const root = node({ catalogScopeDigest: scopeDigest, era: '0', level: '1', firstBucketId: '0', entries: leaves.map((leaf, i) => ({
      firstBucketId: String(i * 256), bucketSpan: '256', rowCount: '0',
      byteLength: String(canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1(leaf.payload, '512').byteLength + (badLength && i === 1 ? 1 : 0)),
      childDigest: computeAuthorCatalogDirectoryNodeObjectDigestV1(leaf, '512'),
    })) });
    head.payload = { ...head.payload, bucketCount: '512', directoryHeight: '1', directoryRootDigest: computeAuthorCatalogDirectoryNodeObjectDigestV1(root, '512') };
    const headDigest = computeAuthorCatalogHeadObjectDigestV1(head);
    f.catalogs[0].objects = [head, root, ...leaves];
    f.capture.applied = [{ catalog_scope_digest: scopeDigest, author_address: campaign.author, current_catalog_head_digest: headDigest }];
    Object.assign(f.status.value.rfc64Catalog.contextGraphs[0], { expectedCatalogHeadDigest: headDigest, appliedCatalogHeadDigest: headDigest });
    return f;
  };
  assert.equal(verify(build(false)).valid, true);
  assert.equal(verify(build(true)).valid, false);
});
