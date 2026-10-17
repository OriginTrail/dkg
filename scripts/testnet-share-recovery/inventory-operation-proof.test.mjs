import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { spawnSync } from 'node:child_process';import { fileURLToPath } from 'node:url';
import { verifyInventoryOperations, faultOperationWitnesses } from './inventory-operation-proof.mjs';
import { verifyInventoryScope } from './inventory-scope.mjs';
import { inventoryScopeFixture, operationRowsFixture } from './inventory-scope-fixture.mjs';
import { verifyIdentityTuples } from './identity-tuples.mjs';
const campaign = { version: 1, arm: 'fixture', contextGraphId: 'operation-proof', author: '0x' + '11'.repeat(20), faults: [{ name: 'asset' }] };
const lifecycle = operationRowsFixture(campaign, 'asset', 'operation-A');
const originals = [{ name: 'asset', operationId: 'operation-A', valid: true }];
const fixture = operation => inventoryScopeFixture(campaign, [{ assertion_coordinate: 'asset', share_operation_id: operation }], [{ assertionCoordinate: 'asset' }]);

test('consistent signed inventory cannot substitute operationB for original lifecycle/recovery operationA', () => {
  for (const operation of ['operation-A', 'operation-B']) {
    const f = fixture(operation);
    assert.equal(verifyInventoryScope(campaign, f.capture, f.catalogs, f.status).valid, true);
    const proof = verifyInventoryOperations(campaign, ['asset'], f.capture.swm, lifecycle, originals);
    assert.equal(proof.exact, operation === 'operation-A');
  }
  const missing = verifyInventoryOperations(campaign, ['asset'], [], lifecycle, originals);
  assert.equal(missing.consistent, true); assert.equal(missing.exact, false); assert.deepEqual(missing.missing, ['asset']);
});
test('operation proof refuses ambiguous authority and replacement recovery bindings', () => {
  const inv = fixture('operation-A').capture.swm;
  for (const rows of [[], [...lifecycle, lifecycle[0]], lifecycle.map(r => ({ ...r, g: { ...r.g, value: 'urn:wrong' } })),
    lifecycle.map(r => ({ ...r, o: { ...r.o, datatype: 'http://www.w3.org/2001/XMLSchema#integer' } }))]) {
    assert.equal(verifyInventoryOperations(campaign, ['asset'], inv, rows, originals).exact, false);
  }
  for (const witness of [{ name: 'asset', operationId: 'operation-B', valid: true }, { name: 'asset', operationId: 'operation-A', valid: false }]) {
    assert.equal(verifyInventoryOperations(campaign, ['asset'], inv, lifecycle, [witness]).exact, false);
  }
  assert.equal(verifyInventoryOperations(campaign, ['asset'], inv, lifecycle, faultOperationWitnesses(campaign, [])).exact, false);
});
test('actual main identity command rejects a self-consistent wrong operation and exports the failure', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-operation-'));
  try {
    const root = path.join(cwd, '.tmp/2963/evidence/fixture'); fs.mkdirSync(path.join(root, 'final'), { recursive: true });
    const f = fixture('operation-B'), row = f.capture.swm[0], cat = f.catalogs[0].rows[0];
    const expected = [{ name: 'asset', sealDigest: row.seal_digest, seal: { kaUal: row.ka_ual, assertionVersion: '1', reservedKaId: cat.kaId } }];
    // The old tuple predicate alone incorrectly certifies exactly this internally consistent capture.
    assert.equal(verifyIdentityTuples(expected, f.catalogs[0].rows, f.capture.swm).exactInventoryIdentity, true);
    const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
    for (const [name, value] of [['campaign-manifest.json', campaign], ['seal-proof.json', expected], ['final/inventory.json', f.capture],
      ['final/catalogs.json', f.catalogs], ['final/-api-status.json', f.status], ['final/rdf.json', { results: { bindings: lifecycle } }],
      ['fault-identity-proof.json', [{ name: 'asset', originalOperationId: 'operation-A', captureComplete: true, originalSealOperationAndContentPreserved: true }]]]) write(name, value);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./identity-proof.mjs', import.meta.url)), 'fixture', 'final'], { cwd, encoding: 'utf8' });
    assert.equal(run.status, 1, run.stderr);
    const proof = JSON.parse(fs.readFileSync(path.join(root, 'identity-proof.json')));
    assert.equal(proof.inventoryScope.valid, true); assert.equal(proof.exactInventoryIdentity, false);
    assert.equal(proof.operations.consistent, false); assert.equal(proof.expectedCount, 1); assert.equal(proof.inventoryCount, 1);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
