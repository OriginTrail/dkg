import { describe, expect, it } from 'vitest';

import { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
import {
  mapRfc64CatalogAuthorityRevisionsToLocalV1,
  projectRfc64CatalogAuthorityRevisionTargetsV1,
} from '../src/rfc64/catalog-authority-revision-projection-v1.js';

describe('RFC-64 authority revision scheduling projection', () => {
  it('keeps authoritative and legacy numeric bindings inside the canonical owner', () => {
    const state = new ContextGraphBindingState();
    const authoritative = { onChainId: '9' };
    const reverseOnly = {};
    state.bindReverseCandidate(
      'reverse-only',
      reverseOnly,
      '10',
      `0x${'11'.repeat(32)}`,
    );

    expect(state.authorityIndexSchedulingBindingFor('local', authoritative)).toEqual({
      localContextGraphId: 'local',
      onChainId: '9',
      provenance: 'authoritative',
    });
    expect(state.authorityIndexSchedulingBindingFor('11', undefined)).toEqual({
      localContextGraphId: '11',
      onChainId: '11',
      provenance: 'legacy-numeric-id',
    });
    expect(state.authorityIndexSchedulingBindingFor('reverse-only', reverseOnly))
      .toBeUndefined();
    expect(state.authorityIndexSchedulingBindingFor('12', { onChainId: '012' }))
      .toBeUndefined();
  });

  it('groups duplicate slots, retains fallback ids, and maps revisions back to locals', () => {
    const bindings = new Map([
      ['local-a', { localContextGraphId: 'local-a', onChainId: '9', provenance: 'authoritative' as const }],
      ['local-b', { localContextGraphId: 'local-b', onChainId: '9', provenance: 'authoritative' as const }],
      ['11', { localContextGraphId: '11', onChainId: '11', provenance: 'legacy-numeric-id' as const }],
    ]);
    const targets = projectRfc64CatalogAuthorityRevisionTargetsV1(
      ['local-a', 'local-b', '11', 'fallback', 'local-a'],
      (contextGraphId) => bindings.get(contextGraphId),
    );

    expect(targets.onChainContextGraphIds).toEqual([9n, 11n]);
    expect(targets.localContextGraphIdsByOnChainId).toEqual(new Map([
      ['9', ['local-a', 'local-b']],
      ['11', ['11']],
    ]));
    expect(targets.fallbackContextGraphIds).toEqual(new Set(['fallback']));
    expect(mapRfc64CatalogAuthorityRevisionsToLocalV1([
      { contextGraphId: '9', revision: 'revision-9' },
      { contextGraphId: '11', revision: 'revision-11' },
    ], targets.localContextGraphIdsByOnChainId)).toEqual(new Map([
      ['local-a', 'revision-9'],
      ['local-b', 'revision-9'],
      ['11', 'revision-11'],
    ]));
  });
});
