// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from 'vitest';
import { contextGraphAssertionUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { confirmedNamedAssertionSealQuads, assertionRecoverySealGraph, assertionRecoverySealSubject } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { normalizeLifecycleRepairInput } from '../src/named-ka-vm-lifecycle-evidence.js';
import { applyMaterializedConfirmedLifecycle } from '../src/named-ka-vm-lifecycle-materialization.js';
import { confirmedMaterializationFixture } from './_helpers/confirmed-materialization-fixture.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
it.each([
  ['publicTripleCount', '2'],
  ['privateTripleCount', '3'],
  ['privateMerkleRoot', `0x${'36'.repeat(32)}`],
])('rejects a named seal whose %s differs from admitted materialization', (name, object) => {
  const { input } = confirmedMaterializationFixture(true);
  const seal = { ...input.namedSeal!, [name]: object };
  expect(seal).not.toEqual(input.namedSeal);
  expect(() => normalizeLifecycleRepairInput({ ...input, namedSeal: seal })).toThrow();
});
it('rejects a differently scoped UAL even if it packs to the same author and number', () => {
  const { input } = confirmedMaterializationFixture();
  const seal = { ...input.namedSeal!, kaUal: input.materialization!.kaUal.replace('mock:31337', 'other:31337') };
  expect(seal).not.toEqual(input.namedSeal);
  expect(() => normalizeLifecycleRepairInput({ ...input, namedSeal: seal })).toThrow();
});
it.each(['active', 'archive'])('recovers legacy evidence using its original %s seal', async location => {
  const { input } = confirmedMaterializationFixture();
  const store = new OxigraphStore(); stores.push(store);
  const subject = location === 'active' ? contextGraphAssertionUri(input.contextGraphId, input.agentAddress, input.name)
    : assertionRecoverySealSubject(input.contextGraphId, input.name, input.agentAddress);
  const graph = location === 'active' ? contextGraphMetaUri(input.contextGraphId) : assertionRecoverySealGraph(input.contextGraphId);
  await store.insert(confirmedNamedAssertionSealQuads(input.namedSeal!, subject, graph));
  const { namedSeal: _seal, ...legacy } = input;
  await expect(applyMaterializedConfirmedLifecycle(store, normalizeLifecycleRepairInput(legacy), { persistence: 'process-local' })).resolves.toBeUndefined();
  expect(await store.query(`ASK { GRAPH <${contextGraphMetaUri(input.contextGraphId)}> { ?s <http://dkg.io/ontology/reservedUal> ${JSON.stringify(input.publishedUal)} } }`)).toMatchObject({ value: true });
});
it('keeps historical repair incomplete when neither its journal nor store retains the original seal', async () => {
  const { input } = confirmedMaterializationFixture();
  const store = new OxigraphStore(); stores.push(store);
  const { namedSeal: _seal, ...legacy } = input;
  await expect(applyMaterializedConfirmedLifecycle(store, normalizeLifecycleRepairInput(legacy), { persistence: 'process-local' })).rejects.toThrow('awaits its authenticated named assertion seal');
  expect(await store.query(`ASK { GRAPH <${contextGraphMetaUri(input.contextGraphId)}> { ?s <http://dkg.io/ontology/publishedUal> ?ual } }`)).toMatchObject({ value: false });
});
