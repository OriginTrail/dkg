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
const expected = [{ name: 'asset', sealDigest: 'digest', seal: { reservedKaId: '1', kaUal: 'did:dkg:asset', assertionVersion: '1' } }];
const row = { assertion_coordinate: 'asset', ka_ual: 'did:dkg:asset', assertion_version_u64be: '0x0000000000000001', seal_digest: 'digest' };
const catalogRows = [{ assertionCoordinate: 'asset', kaId: '1', assertionVersion: '1', sealDigest: 'digest' }];
function collect(entries) {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE rfc64_swm_author_inventory_heads_v1 (inventory_scope_digest BLOB, author_address BLOB, current_head_digest BLOB, total_rows_u64be BLOB, signed_head_envelope BLOB); CREATE TABLE rfc64_swm_author_inventory_rows_v1 (inventory_scope_digest BLOB, author_address BLOB, assertion_coordinate TEXT, ka_ual TEXT, assertion_version_u64be BLOB, seal_digest TEXT); CREATE TABLE rfc64_applied_catalog_heads_v1 (catalog_scope_digest BLOB);');
    const insert = (table, value) => db.prepare(`INSERT INTO ${table} (${Object.keys(value).join(',')}) VALUES (${Object.keys(value).map(() => '?').join(',')})`)
      .run(...Object.values(value).map(v => typeof v === 'string' && v.startsWith('0x') ? Buffer.from(v.slice(2), 'hex') : v));
    for (const entry of entries) {
      insert('rfc64_swm_author_inventory_heads_v1', entry.head);
      for (const r of entry.swm) insert('rfc64_swm_author_inventory_rows_v1', r);
    }
    return encodeInventory(collectInventoryScopes(db, campaign.contextGraphId));
  } finally { db.close(); }
}
const verify = f => verifyInventoryScope(campaign, f.capture, f.catalogs, f.status);

test('SQLite collector preserves both scopes; complete obsolete rows cannot conceal empty current inventory in either order', () => {
  const old = inventoryScopeFixture(campaign, [row], catalogRows, '0');
  const current = inventoryScopeFixture(campaign, [], catalogRows, '1');
  for (const entries of [[...old.capture.scopes, ...current.capture.scopes], [...current.capture.scopes, ...old.capture.scopes]]) {
    const capture = collect(entries), proof = verify({ ...current, capture });
    assert.equal(capture.scopes.length, 2); assert.equal(proof.valid, true); assert.equal(proof.rows.length, 0);
    assert.equal(proof.scopeDigest, current.capture.scopes[0].head.inventory_scope_digest);
    assert.equal(verifyIdentityTuples(expected, catalogRows, proof.rows).exactInventoryIdentity, false);
  }
  // Negative control: the original first-head algorithm certifies the obsolete complete set.
  const capture = collect([...old.capture.scopes, ...current.capture.scopes]);
  assert.equal(verifyIdentityTuples(expected, catalogRows, capture.scopes[0].swm).exactInventoryIdentity, true);
});

test('authoritative inventory proof accepts exact current rows and preserves intentional baseline gaps', () => {
  const f = inventoryScopeFixture(campaign, [row], catalogRows), proof = verify({ ...f, capture: collect(f.capture.scopes) });
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
    const capture = { ...collect([...old.capture.scopes, ...current.capture.scopes]), swm: old.capture.swm };
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
  const proof = verify({ ...current, catalogs, capture: collect([...old.capture.scopes, ...current.capture.scopes]) });
  assert.equal(proof.valid, true);
  const identities = verifyIdentityTuples(expected, proof.catalogRows, proof.rows);
  assert.equal(identities.exactInventoryIdentity, true); assert.equal(identities.exactCatalogIdentity, false);
  assert.equal(verifyIdentityTuples(expected, catalogs.flatMap(c => c.rows), proof.rows).exactCatalogIdentity, true,
    'negative control: unscoped catalog aggregation hides the missing current catalog row');
});


test('scope CLI reads a full capture through a pipe without synchronous EAGAIN', () => {
  const fixture = inventoryScopeFixture(campaign, Array.from({ length: 1000 }, (_, i) => ({ ...row,
    assertion_coordinate: `asset-${i}`, ka_ual: `did:dkg:asset-${i}` })), catalogRows);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./inventory-scope.mjs', import.meta.url))], {
    input: JSON.stringify({ campaign, ...fixture }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).valid, true);
});
