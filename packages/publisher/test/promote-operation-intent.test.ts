import { describe, expect, it } from 'vitest';
import {
  createPromoteOperationIntent,
  parsePromoteOperationIntent,
  serializePromoteOperationIntent,
  type PromoteOperationIntent,
} from '../src/promote-operation-intent.js';

const PUBLIC_INTENT: PromoteOperationIntent = {
  version: 1,
  operationId: 'operation-1',
  timestampMs: 1_700_000_000_000,
  confirmationRequired: false,
  accessPolicy: 'public',
  allowedPeers: [],
};

describe('durable promote operation intent v1 codec', () => {
  it('preserves the exact existing v1 JSON and RDF-literal round trip', () => {
    const intent = createPromoteOperationIntent({
      operationId: 'operation-1', timestampMs: 1_700_000_000_000,
      publisherPeerId: ' publisher ', confirmationRequired: true,
      accessPolicy: 'allowList', allowedPeers: ['peer-b', ' peer-a ', 'peer-b', ''],
    });
    const serialized = serializePromoteOperationIntent(intent);
    expect(serialized).toBe('{"version":1,"operationId":"operation-1","timestampMs":1700000000000,"publisherPeerId":"publisher","confirmationRequired":true,"accessPolicy":"allowList","allowedPeers":["peer-a","peer-b"]}');
    expect(parsePromoteOperationIntent(JSON.parse(JSON.stringify(serialized)), 'operation-1'))
      .toEqual(intent);
  });

  it.each(['public', 'ownerOnly'] as const)('creates a %s envelope with an omitted blank publisher', (accessPolicy) => {
    const intent = createPromoteOperationIntent({
      operationId: 'operation-1', timestampMs: 1_700_000_000_000,
      publisherPeerId: ' ', confirmationRequired: false, accessPolicy,
    });
    expect(intent).toEqual({ ...PUBLIC_INTENT, accessPolicy });
    expect(parsePromoteOperationIntent(serializePromoteOperationIntent(intent), 'operation-1'))
      .toEqual(intent);
  });

  it('owns the canonical peer array without retaining the caller array', () => {
    const allowedPeers = ['peer-b', 'peer-a'];
    const intent = createPromoteOperationIntent({
      ...PUBLIC_INTENT, accessPolicy: 'allowList', allowedPeers,
    });
    allowedPeers.push('peer-c');
    expect(intent.allowedPeers).toEqual(['peer-a', 'peer-b']);
  });

  it.each([
    ['allowList', [], 'allowList policy requires allowedPeers'],
    ['public', ['peer-a'], 'allowedPeers requires allowList policy'],
    ['ownerOnly', ['peer-a'], 'allowedPeers requires allowList policy'],
  ] as const)('preserves the creation error for inconsistent %s peers', (accessPolicy, allowedPeers, message) => {
    expect(() => createPromoteOperationIntent({ ...PUBLIC_INTENT, accessPolicy, allowedPeers }))
      .toThrow(message);
  });

  it.each([
    ['malformed JSON', '{'],
    ['null', 'null'],
    ['array', '[]'],
    ['missing envelope', '{}'],
    ['wrong version', JSON.stringify({ ...PUBLIC_INTENT, version: 2 })],
    ['wrong operation', JSON.stringify({ ...PUBLIC_INTENT, operationId: 'other' })],
    ['missing timestamp', JSON.stringify({ ...PUBLIC_INTENT, timestampMs: undefined })],
    ['zero timestamp', JSON.stringify({ ...PUBLIC_INTENT, timestampMs: 0 })],
    ['fractional timestamp', JSON.stringify({ ...PUBLIC_INTENT, timestampMs: 1.5 })],
    ['unsafe timestamp', JSON.stringify({ ...PUBLIC_INTENT, timestampMs: Number.MAX_SAFE_INTEGER + 1 })],
    ['string timestamp', JSON.stringify({ ...PUBLIC_INTENT, timestampMs: '1700000000000' })],
    ['blank publisher', JSON.stringify({ ...PUBLIC_INTENT, publisherPeerId: '' })],
    ['noncanonical publisher', JSON.stringify({ ...PUBLIC_INTENT, publisherPeerId: ' publisher ' })],
    ['invalid confirmation', JSON.stringify({ ...PUBLIC_INTENT, confirmationRequired: 'true' })],
    ['unknown policy', JSON.stringify({ ...PUBLIC_INTENT, accessPolicy: 'unknown' })],
    ['missing peers', JSON.stringify({ ...PUBLIC_INTENT, allowedPeers: undefined })],
    ['public with peers', JSON.stringify({ ...PUBLIC_INTENT, allowedPeers: ['peer-a'] })],
    ['allow-list without peers', JSON.stringify({ ...PUBLIC_INTENT, accessPolicy: 'allowList' })],
    ['nonstring peers', JSON.stringify({ ...PUBLIC_INTENT, accessPolicy: 'allowList', allowedPeers: [1] })],
    ['duplicate peers', JSON.stringify({ ...PUBLIC_INTENT, accessPolicy: 'allowList', allowedPeers: ['a', 'a'] })],
    ['unsorted peers', JSON.stringify({ ...PUBLIC_INTENT, accessPolicy: 'allowList', allowedPeers: ['b', 'a'] })],
    ['noncanonical peers', JSON.stringify({ ...PUBLIC_INTENT, accessPolicy: 'allowList', allowedPeers: [' a '] })],
  ])('retains the corruption contract for %s', (_label, serialized) => {
    expect(() => parsePromoteOperationIntent(serialized, 'operation-1'))
      .toThrow(expect.objectContaining({ code: 'KA_PROMOTE_OPERATION_INTENT_CORRUPT' }));
  });

  it('validates creation and serialization through the same schema', () => {
    expect(() => createPromoteOperationIntent({ ...PUBLIC_INTENT, timestampMs: 0 }))
      .toThrow(expect.objectContaining({ code: 'KA_PROMOTE_OPERATION_INTENT_CORRUPT' }));
    expect(() => serializePromoteOperationIntent({ ...PUBLIC_INTENT, timestampMs: 0 }))
      .toThrow(expect.objectContaining({ code: 'KA_PROMOTE_OPERATION_INTENT_CORRUPT' }));
  });
});
