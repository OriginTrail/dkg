// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from 'vitest';
import { ASSERTION_SEAL_PREDICATES, contextGraphAssertionUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { assertionRecoverySealGraph, assertionRecoverySealSubject } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { normalizeLifecycleRepairInput } from '../src/named-ka-vm-lifecycle-evidence.js';
import { applyMaterializedConfirmedLifecycle } from '../src/named-ka-vm-lifecycle-materialization.js';
import { confirmedMaterializationFixture } from './_helpers/confirmed-materialization-fixture.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
it.each([
  ['publicTripleCount', '"2"^^<http://www.w3.org/2001/XMLSchema#integer>'],
  ['privateTripleCount', '"3"^^<http://www.w3.org/2001/XMLSchema#integer>'],
  ['privateMerkleRoot', `"${'36'.repeat(32)}"^^<http://www.w3.org/2001/XMLSchema#hexBinary>`],
])('rejects a named seal whose %s differs from admitted materialization', (name, object) => {
  const { input } = confirmedMaterializationFixture(true);
  const quads = input.namedSealQuads!.map(q => q.predicate === `http://dkg.io/ontology/${name}` ? { ...q, object } : q);
  expect(quads).not.toEqual(input.namedSealQuads);
  expect(() => normalizeLifecycleRepairInput({ ...input, namedSealQuads: quads })).toThrow();
});
it('rejects a differently scoped UAL even if it packs to the same author and number', () => {
  const { input } = confirmedMaterializationFixture();
  const quads = input.namedSealQuads!.map(q => q.predicate === ASSERTION_SEAL_PREDICATES.KA_UAL
    ? { ...q, object: `<${input.materialization!.kaUal.replace('mock:31337', 'other:31337')}>` } : q);
  expect(quads).not.toEqual(input.namedSealQuads);
  expect(() => normalizeLifecycleRepairInput({ ...input, namedSealQuads: quads })).toThrow();
});
it.each(['active', 'archive'])('recovers legacy evidence using its original %s seal', async location => {
  const { input } = confirmedMaterializationFixture();
  const store = new OxigraphStore(); stores.push(store);
  const subject = location === 'active' ? contextGraphAssertionUri(input.contextGraphId, input.agentAddress, input.name)
    : assertionRecoverySealSubject(input.contextGraphId, input.name, input.agentAddress);
  const graph = location === 'active' ? contextGraphMetaUri(input.contextGraphId) : assertionRecoverySealGraph(input.contextGraphId);
  await store.insert(input.namedSealQuads!.map(q => ({ ...q, subject, graph })));
  const { namedSealQuads: _seal, ...legacy } = input;
  await expect(applyMaterializedConfirmedLifecycle(store, normalizeLifecycleRepairInput(legacy), { persistence: 'process-local' })).resolves.toBeUndefined();
  expect(await store.query(`ASK { GRAPH <${contextGraphMetaUri(input.contextGraphId)}> { ?s <http://dkg.io/ontology/reservedUal> ${JSON.stringify(input.publishedUal)} } }`)).toMatchObject({ value: true });
});
it('keeps historical repair incomplete when neither its journal nor store retains the original seal', async () => {
  const { input } = confirmedMaterializationFixture();
  const store = new OxigraphStore(); stores.push(store);
  const { namedSealQuads: _seal, ...legacy } = input;
  await expect(applyMaterializedConfirmedLifecycle(store, normalizeLifecycleRepairInput(legacy), { persistence: 'process-local' })).rejects.toThrow('awaits its authenticated named assertion seal');
  expect(await store.query(`ASK { GRAPH <${contextGraphMetaUri(input.contextGraphId)}> { ?s <http://dkg.io/ontology/publishedUal> ?ual } }`)).toMatchObject({ value: false });
});
