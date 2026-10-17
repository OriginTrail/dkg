import { test } from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { spawnSync } from 'node:child_process';import { fileURLToPath } from 'node:url';
import { verifyInventoryProjections } from './inventory-projection-proof.mjs';
import { verifyInventoryScope } from './inventory-scope.mjs';
import { verifyIdentityTuples } from './identity-tuples.mjs';
import { projectionProofFixture } from './projection-proof-fixture.mjs';
import { inventoryScopeFixture } from './inventory-scope-fixture.mjs';
const campaign = { version: 1, arm: 'fixture', contextGraphId: 'projection-proof', author: '0x' + '11'.repeat(20), faults: [] };
const mutations = [
  ['valid', () => {}],
  ['public count', inv => { inv.public_triple_count_u64be = '0x0000000000000009'; }],
  ['private count', inv => { inv.private_triple_count_u64be = '0x0000000000000001'; }],
  ['inventory projection', inv => { inv.projection_digest = '0x' + '11'.repeat(32); }],
  ['catalog projection', (_inv, cat) => { cat.projectionDigest = cat.transfer.projectionDigest = '0x' + '22'.repeat(32); }],
  ['transfer blob', (_inv, cat) => { cat.transfer.blobDigest = '0x' + '33'.repeat(32); }],
  ['transfer chunks', (_inv, cat) => { cat.transfer.chunkTreeRoot = '0x' + '44'.repeat(32); }],
];
for (const [label, mutate] of mutations) test(`main identity command binds ${label} to original sealed payload despite self-consistent heads`, () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-proof-'));
  try {
    const f = projectionProofFixture(campaign, 'asset', 'operation-A', mutate);
    assert.equal(verifyInventoryScope(campaign, f.capture, f.catalogs, f.status).valid, true);
    const old = verifyIdentityTuples(f.expected, f.catalogs[0].rows, f.capture.swm);
    assert.equal(old.exactInventoryIdentity && old.exactCatalogIdentity, true, 'negative control requires accepted old identity tuples');
    const root = path.join(cwd, '.tmp/2963/evidence/fixture');fs.mkdirSync(path.join(root, 'final'), { recursive: true });
    for (const [name, value] of [['campaign-manifest.json', campaign], ['seal-proof.json', f.expected], ['fault-identity-proof.json', []],
      ['final/inventory.json', f.capture], ['final/catalogs.json', f.catalogs], ['final/-api-status.json', f.status], ['final/rdf.json', { results: { bindings: f.rdf } }]]) {
      fs.writeFileSync(path.join(root, name), JSON.stringify(value));
    }
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./identity-proof.mjs', import.meta.url)), 'fixture', 'final'], { cwd, encoding: 'utf8' });
    assert.equal(run.status, label === 'valid' ? 0 : 1, run.stderr);
    const proof = JSON.parse(fs.readFileSync(path.join(root, 'identity-proof.json')));
    assert.equal(proof.inventoryScope.valid, true);assert.equal(proof.operations.exact, true);
    assert.equal(proof.projections.consistent, label === 'valid');
    assert.equal(proof.exactInventoryIdentity && proof.exactCatalogIdentity, label === 'valid');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
test('missing baseline rows remain incomplete and changed captured payload cannot certify a projection', () => {
  const f = projectionProofFixture(campaign);
  const absent = inventoryScopeFixture(campaign, [], []);
  const missing = verifyInventoryProjections(campaign, f.expected, absent.capture.swm, [], f.rdf);
  assert.equal(missing.consistent, true);assert.equal(missing.exactInventory, false);assert.equal(missing.exactCatalog, false);
  const changed = structuredClone(f.rdf);changed.find(r => r.p.value === 'urn:value').o.value = 'changed';
  assert.equal(verifyInventoryProjections(campaign, f.expected, f.capture.swm, f.catalogs[0].rows, changed).consistent, false);
});
