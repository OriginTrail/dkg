import { describe, expect, it } from 'vitest';
import type { Digest32V1 } from '@origintrail-official/dkg-core';

import type {
  Rfc64FinalizedSwmRetirementLifecycleReceiptV1,
} from '../src/rfc64/catalog-applied-head-coordinator-v1.js';
import {
  Rfc64FinalizedSwmRetirementLifecycleReceiptRegistryV1,
} from '../src/rfc64/finalized-swm-retirement-lifecycle-receipt-registry-v1.js';

function digest(byte: string): Digest32V1 {
  return `0x${byte.repeat(64)}` as Digest32V1;
}

function receipt(
  catalogHeadDigest: Digest32V1,
  kaUal: string,
): Rfc64FinalizedSwmRetirementLifecycleReceiptV1 {
  const inventoryDigest = digest('f');
  return Object.freeze({
    kind: 'rfc64-finalized-swm-retirement-lifecycle-receipt-v1',
    catalogHeadDigest,
    inventoryDigest,
    contextGraphId: 'otp:20430/rfc64-registry',
    kaUal,
    assertionVersion: '1',
    vmGraphIri: `urn:rfc64:vm:${kaUal}`,
    vmPostReadDigest: digest('e'),
    vmMaterializationStatus: 'materialized',
    committedHead: Object.freeze({
      kind: 'rfc64-public-catalog-native-committed-head-token-v1',
      catalogHeadDigest,
      inventoryDigest,
    }),
    swmReconciliationOutcome: 'retired',
  });
}

describe('RFC-64 finalized SWM retirement lifecycle receipt registry', () => {
  it('retains only the newest bounded set of heads and returns immutable copies', () => {
    const registry = new Rfc64FinalizedSwmRetirementLifecycleReceiptRegistryV1(2);
    const oldest = digest('1');
    const middle = digest('2');
    const newest = digest('3');
    registry.record(receipt(oldest, 'did:dkg:oldest'));
    registry.record(receipt(middle, 'did:dkg:middle'));
    registry.record(receipt(newest, 'did:dkg:newest'));

    expect(registry.read(oldest)).toEqual([]);
    expect(registry.read(middle).map(({ kaUal }) => kaUal)).toEqual(['did:dkg:middle']);
    const retained = registry.read(newest);
    expect(retained.map(({ kaUal }) => kaUal)).toEqual(['did:dkg:newest']);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained[0])).toBe(true);
    expect(Object.isFrozen(retained[0]?.committedHead)).toBe(true);
  });

  it('replaces one KA receipt within a head without evicting another head', () => {
    const registry = new Rfc64FinalizedSwmRetirementLifecycleReceiptRegistryV1(2);
    const first = digest('1');
    const second = digest('2');
    registry.record(receipt(first, 'did:dkg:b'));
    registry.record(receipt(second, 'did:dkg:c'));
    registry.record(receipt(first, 'did:dkg:a'));
    registry.record(receipt(first, 'did:dkg:b'));

    expect(registry.read(first).map(({ kaUal }) => kaUal)).toEqual([
      'did:dkg:a',
      'did:dkg:b',
    ]);
    expect(registry.read(second)).toHaveLength(1);
  });
});
