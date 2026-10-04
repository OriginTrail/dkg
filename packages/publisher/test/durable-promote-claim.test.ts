// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { readDurablePromoteClaim, durablePromoteClaimMatches } from '../src/durable-promote-claim.js';
import { createPromoteOperationIntent, serializePromoteOperationIntent } from '../src/promote-operation-intent.js';

const graph = 'urn:test:durable-promote-meta', subject = 'urn:test:durable-promote-lifecycle';
const idPredicate = 'http://dkg.io/ontology/shareOperationId';
const intentPredicate = 'http://dkg.io/ontology/promoteOperationIntent';
const intent = createPromoteOperationIntent({ operationId: 'original-operation', timestampMs: 1_700_000_000_000,
  confirmationRequired: true, accessPolicy: 'public', publisherPeerId: 'publisher-peer' });
const serialized = serializePromoteOperationIntent(intent);

async function fixture(ids: readonly string[] = [], intents: readonly string[] = []) {
  const store = new OxigraphStore();
  onTestFinished(() => store.close());
  await store.insert([
    ...ids.map(object => ({ subject, predicate: idPredicate, object, graph })),
    ...intents.map(object => ({ subject, predicate: intentPredicate, object, graph })),
  ]);
  return store;
}

describe('validated durable promote claim boundary', () => {
  it('distinguishes absent, legacy, and complete modern claims', async () => {
    const absent = await readDurablePromoteClaim(await fixture(), graph, subject);
    const legacy = await readDurablePromoteClaim(await fixture([JSON.stringify(intent.operationId)]), graph, subject);
    const modern = await readDurablePromoteClaim(await fixture([JSON.stringify(intent.operationId)], [JSON.stringify(serialized)]), graph, subject);
    expect(absent).toEqual({ kind: 'absent' });
    expect(legacy).toEqual({ kind: 'legacy', operationId: intent.operationId });
    expect(modern).toEqual({ kind: 'modern', operationId: intent.operationId, serializedIntent: serialized, intent });
    expect(durablePromoteClaimMatches(absent, intent)).toBe(false);
    expect(durablePromoteClaimMatches(legacy, intent)).toBe(false);
    expect(durablePromoteClaimMatches(modern, intent)).toBe(true);
  });

  it.each([
    ['conflicting IDs', ['"first"', '"second"'], [], 'KA_SHARE_OPERATION_ID_CONFLICT'],
    ['conflicting intents', ['"original-operation"'], ['"first"', '"second"'], 'KA_PROMOTE_OPERATION_INTENT_CONFLICT'],
    ['intent without ID', [], [JSON.stringify(serialized)], 'KA_PROMOTE_OPERATION_INTENT_CONFLICT'],
    ['IRI ID', ['urn:invalid:operation'], [], 'KA_SHARE_OPERATION_ID_CORRUPT'],
    ['empty ID', ['""'], [], 'KA_SHARE_OPERATION_ID_CORRUPT'],
    ['IRI intent', ['"original-operation"'], ['urn:invalid:intent'], 'KA_PROMOTE_OPERATION_INTENT_CORRUPT'],
    ['malformed envelope', ['"original-operation"'], ['"not-json"'], 'KA_PROMOTE_OPERATION_INTENT_CORRUPT'],
    ['mismatched envelope ID', ['"different-operation"'], [JSON.stringify(serialized)], 'KA_PROMOTE_OPERATION_INTENT_CORRUPT'],
  ] as const)('classifies %s once with its precise corruption error', async (_label, ids, intents, code) => {
    const claim = await readDurablePromoteClaim(await fixture(ids, intents), graph, subject);
    expect(claim).toMatchObject({ kind: 'corrupt', error: { code } });
    expect(claim).not.toHaveProperty('operationIds');
    expect(claim).not.toHaveProperty('intents');
    expect(durablePromoteClaimMatches(claim, intent)).toBe(false);
  });

  it('keeps exact serialized intent matching even for a valid reordered envelope', async () => {
    const validReordered = JSON.stringify(Object.fromEntries(Object.entries(intent).reverse()));
    const store = await fixture([JSON.stringify(intent.operationId)], [JSON.stringify(validReordered)]);
    const claim = await readDurablePromoteClaim(store, graph, subject);
    expect(claim).toMatchObject({ kind: 'modern', intent });
    expect(durablePromoteClaimMatches(claim, intent)).toBe(false);
  });

  it('classifies unreadable and missing query bindings as corruption', async () => {
    const store = await fixture();
    vi.spyOn(store, 'query').mockResolvedValueOnce({ type: 'quads', quads: [] });
    expect(await readDurablePromoteClaim(store, graph, subject))
      .toMatchObject({ kind: 'corrupt', error: { code: 'KA_LIFECYCLE_STATE_CORRUPT' } });
    vi.mocked(store.query).mockResolvedValueOnce({ type: 'bindings', bindings: [{}] });
    expect(await readDurablePromoteClaim(store, graph, subject))
      .toMatchObject({ kind: 'corrupt', error: { code: 'KA_SHARE_OPERATION_ID_CORRUPT' } });
  });
});
