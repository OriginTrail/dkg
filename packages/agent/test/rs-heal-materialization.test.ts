import { describe, expect, it, vi } from 'vitest';
import type { StructuredMutation, TripleStore } from '@origintrail-official/dkg-storage';
import {
  applyRsHealMaterialization,
  supportsRsHealMaterialization,
  type RsHealMaterializationPlan,
} from '../src/rs-heal-materialization.js';

const SOURCE = 'urn:test:rs-heal:source';
const TARGET = 'urn:test:rs-heal:target';
const META = 'urn:test:rs-heal:meta';
const UAL = 'urn:test:rs-heal:ual';

function plan(): RsHealMaterializationPlan {
  return {
    dataCopy: {
      sourceGraphUris: [SOURCE],
      targetGraphUri: TARGET,
      roots: ['urn:test:rs-heal:root'],
      descendantSuffix: '/',
      excludedPredicates: [],
    },
    metadataCopy: {
      sourceGraphUris: [SOURCE],
      targetGraphUri: META,
      roots: [UAL],
      descendantSuffix: '/',
      excludedPredicates: [],
    },
    completionReset: {
      graphUri: META,
      subject: UAL,
      predicates: ['urn:test:rs-heal:version'],
      replacementQuads: [],
    },
    completionStamp: {
      graphUri: META,
      subject: UAL,
      predicates: ['urn:test:rs-heal:version'],
      replacementQuads: [{
        graph: META,
        subject: UAL,
        predicate: 'urn:test:rs-heal:version',
        object: '"1:0"',
      }],
    },
  };
}

describe('RS-heal materialization executor', () => {
  it('preserves reset, data, metadata, stamp order and store options', async () => {
    const seen: Array<{ mutation: StructuredMutation; options: unknown }> = [];
    const store = {
      structuredMutation: vi.fn(async (mutation: StructuredMutation, options: unknown) => {
        seen.push({ mutation, options });
      }),
    } as unknown as TripleStore;

    expect(supportsRsHealMaterialization(store)).toBe(true);
    await applyRsHealMaterialization(store, plan(), () => true);

    expect(seen.map(({ mutation }) => mutation.kind)).toEqual([
      'replace-subject-predicates',
      'copy-subject-projection',
      'copy-subject-projection',
      'replace-subject-predicates',
    ]);
    expect(seen.map(({ options }) => (options as { source: string }).source)).toEqual([
      'agent.swm.rsHeal.materialize.marker',
      'agent.swm.rsHeal.materialize.copy',
      'agent.swm.rsHeal.materialize.copy',
      'agent.swm.rsHeal.materialize.marker',
    ]);
  });

  it('stops before metadata and completion after currentness changes', async () => {
    let current = true;
    const seen: StructuredMutation[] = [];
    const store = {
      structuredMutation: vi.fn(async (mutation: StructuredMutation) => {
        seen.push(mutation);
        if (mutation.kind === 'copy-subject-projection') current = false;
      }),
    } as unknown as TripleStore;

    await applyRsHealMaterialization(store, plan(), () => current);
    expect(seen.map(({ kind }) => kind)).toEqual([
      'replace-subject-predicates',
      'copy-subject-projection',
    ]);
  });

  it('performs no writes when stale before the first boundary', async () => {
    const structuredMutation = vi.fn(async () => undefined);
    const store = { structuredMutation } as unknown as TripleStore;
    await applyRsHealMaterialization(store, plan(), () => false);
    expect(structuredMutation).not.toHaveBeenCalled();
  });
});
