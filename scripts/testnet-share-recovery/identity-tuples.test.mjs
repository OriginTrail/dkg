import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdentityTuples } from './identity-tuples.mjs';
const expected = [{name: 'asset', sealDigest: 'digest', seal: {reservedKaId: '123', kaUal: 'did:dkg:original', assertionVersion: '1'}}];
const catalog = [{assertionCoordinate: 'asset', kaId: '123', assertionVersion: '1', sealDigest: 'digest'}];
const inventory = [{assertion_coordinate: 'asset', ka_ual: 'did:dkg:original', assertion_version_u64be: '0x0000000000000001', seal_digest: 'digest'}];
test('accepts exact original tuples', () => {
  assert.deepEqual(verifyIdentityTuples(expected, catalog, inventory), {expectedCount: 1, catalogCount: 1, inventoryCount: 1,
    uniqueExpected: true, exactCatalogIdentity: true, exactInventoryIdentity: true, identityErrors: []});
});
for (const [kind, rows, fields] of [['catalog', catalog, ['assertionCoordinate', 'kaId', 'assertionVersion', 'sealDigest']],
  ['inventory', inventory, ['assertion_coordinate', 'ka_ual', 'assertion_version_u64be', 'seal_digest']]]) {
  const verify = changed => verifyIdentityTuples(expected, kind === 'catalog' ? changed : catalog, kind === 'inventory' ? changed : inventory);
  const key = kind === 'catalog' ? 'exactCatalogIdentity' : 'exactInventoryIdentity';
  for (const field of fields) test(`rejects wrong ${kind} ${field}`, () => {
    assert.equal(verify([{...rows[0], [field]: field === 'assertion_version_u64be' ? '0x02' : 'wrong'}])[key], false);
  });
  for (const [name, changed] of [['missing', []], ['duplicate', [...rows, ...rows]], ['extra', [...rows, {...rows[0], assertionCoordinate: 'extra', assertion_coordinate: 'extra'}]]]) {
    test(`rejects ${name} ${kind} row`, () => assert.equal(verify(changed)[key], false));
  }
}

test('preserves intentional baseline gaps without inventing tuple mismatches', () => {
  const result = verifyIdentityTuples(expected, [], []);
  assert.equal(result.exactCatalogIdentity, false);
  assert.equal(result.exactInventoryIdentity, false);
  assert.deepEqual(result.identityErrors, []);
});
test('exports one canonical mismatch result for wrong and unknown identities', () => {
  const result = verifyIdentityTuples(expected, [{...catalog[0], kaId:'wrong'}], [{...inventory[0], assertion_coordinate:'extra'}]);
  assert.deepEqual(result.identityErrors, [{catalog:'asset'}, {inventory:'extra'}]);
});
