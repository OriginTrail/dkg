import { describe, expect, it } from 'vitest';

import { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
import type { ContextGraphAuthorityIndexId } from '@origintrail-official/dkg-chain';
import {
  mapRfc64CatalogAuthorityRevisionsToLocalV1,
  projectRfc64CatalogAuthorityRevisionTargetsV1,
} from '../src/rfc64/catalog-authority-revision-projection-v1.js';

describe('RFC-64 authority revision scheduling projection', () => {
  it('indexes only durable authoritative bindings from the canonical owner', () => {
    const state = new ContextGraphBindingState();
    const authoritative = { onChainId: '9' };
    const reverseOnly = {};
    state.bindReverseCandidate(
      'reverse-only',
      reverseOnly,
      '10',
      `0x${'11'.repeat(32)}`,
    );

    expect(state.authorityIndexOnChainIdFor('local', authoritative)).toBe('9');
    expect(state.authorityIndexOnChainIdFor('11', undefined)).toBeUndefined();
    expect(state.authorityIndexOnChainIdFor('reverse-only', reverseOnly))
      .toBeUndefined();
    expect(state.authorityIndexOnChainIdFor('12', { onChainId: '012' }))
      .toBeUndefined();

    const numericLocal = {};
    state.bindReverseCandidate('11', numericLocal, '25', `0x${'25'.repeat(32)}`);
    expect(state.authorityIndexOnChainIdFor('11', numericLocal)).toBeUndefined();
  });

  it('groups bound slots and leaves unbound locals absent from the revision map', () => {
    const bindings = new Map([
      ['local-a', '9'],
      ['local-b', '9'],
    ]);
    const targets = projectRfc64CatalogAuthorityRevisionTargetsV1(
      ['local-a', 'local-b', '11', 'fallback', 'local-a'],
      (contextGraphId) => bindings.get(contextGraphId),
    );

    expect(targets.onChainContextGraphIds).toEqual(['9']);
    expect(targets.localContextGraphIdsByOnChainId).toEqual(new Map([
      ['9', ['local-a', 'local-b']],
    ]));
    expect(mapRfc64CatalogAuthorityRevisionsToLocalV1(new Map([
      ['9' as ContextGraphAuthorityIndexId, 'revision-9'],
    ]), targets.localContextGraphIdsByOnChainId)).toEqual(new Map([
      ['local-a', 'revision-9'],
      ['local-b', 'revision-9'],
    ]));
  });

  it('rejects noncanonical and zero authority bindings before scheduling a read', () => {
    for (const invalid of ['0', '09', '-1']) {
      expect(() => projectRfc64CatalogAuthorityRevisionTargetsV1(
        ['local'],
        () => invalid,
      )).toThrow('target id is invalid');
    }
  });
});
