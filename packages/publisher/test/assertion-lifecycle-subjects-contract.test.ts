import { describe, expect, it } from 'vitest';
import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { generateAssertionWrittenMetadata } from '../src/assertion-lifecycle-events.js';
import { readAssertionLifecycleSubjects } from '../src/assertion-lifecycle-subjects.js';
import { generateAssertionCreatedMetadata, generateAssertionPromotedMetadata, generateAssertionUpdatedMetadata, generateAssertionDiscardedMetadata } from '../src/metadata.js';

const meta = { contextGraphId: 'lifecycle-contract', agentAddress: '0xa32f1cc125401b55911678847426759094055b2d', assertionName: 'asset', timestamp: new Date('2026-10-01T00:00:00Z') };
const root = assertionLifecycleUri(meta.contextGraphId, meta.agentAddress, meta.assertionName);
const graph = contextGraphMetaUri(meta.contextGraphId);
const writers = [
  ['created', () => generateAssertionCreatedMetadata(meta)],
  ['written', () => generateAssertionWrittenMetadata({ ...meta, assertionGraph: 'urn:wm', quadCount: 1 })],
  ['promoted', () => generateAssertionPromotedMetadata({ ...meta, shareOperationId: 'share', rootEntities: ['urn:entity'] }).insert],
  ['updated', () => generateAssertionUpdatedMetadata({ ...meta, newMerkleHex: 'ab'.repeat(32), kcUal: 'did:dkg:fixture/1' }).insert],
  ['discarded', () => generateAssertionDiscardedMetadata(meta).insert],
] satisfies [string, () => Quad[]][];

describe('lifecycle cleanup ownership contract', () => {
  it.each(writers)('finds every %s event after its lifecycle root was removed', async (_name, generate) => {
    const store = new OxigraphStore();
    const rows = generate();
    const subjects = [...new Set(rows.map(q => q.subject).filter(s => s.startsWith(`${root}/`)))].sort();
    expect(subjects.length).toBeGreaterThan(0);
    // A failed old cleanup can delete the root first. Event-side links survive.
    await store.insert(rows.filter(q => q.subject !== root));
    const result = await readAssertionLifecycleSubjects(store, graph, root);
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') expect(result.bindings.map(row => row.s).sort()).toEqual(subjects);
    await store.close();
  });

  it.each(['wasGeneratedBy', 'wasInvalidatedBy'])('supports old inverse-only %s links without following another asset', async (predicate) => {
    const store = new OxigraphStore();
    const event = `${root}/event/legacy`, other = `${root}-other/event/legacy`;
    await store.insert([event, other].flatMap(subject => [
      { subject: root, predicate: `http://www.w3.org/ns/prov#${predicate}`, object: subject, graph },
      { subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://www.w3.org/ns/prov#Activity', graph },
    ]));
    const result = await readAssertionLifecycleSubjects(store, graph, root);
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') expect(result.bindings.map(row => row.s).sort()).toEqual([root, event].sort());
    await store.close();
  });
});
