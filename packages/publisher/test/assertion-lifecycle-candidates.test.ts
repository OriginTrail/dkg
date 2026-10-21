import { describe, expect, it, vi } from 'vitest';
import { assertionLifecycleUri, contextGraphMetaUri, MAX_ROOTLESS_KA_NUMBER_V1 } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { decodeAssertionLifecycleRecord, assertionLifecycleAuthorCandidates, readAssertionLifecycleCandidates } from '../src/assertion-lifecycle-record.js';

const CG = 'lifecycle-candidates';
const NAME = 'retained-asset';
const CHECKSUM = '0x52908400098527886E0F7030069857D2E4169EE7';
const LOWER = CHECKSUM.toLowerCase();
const MIXED = '0x52908400098527886e0F7030069857D2E4169EE7';
const DKG = 'http://dkg.io/ontology/';

async function seed(store: OxigraphStore, author: string, id: string, subGraphName?: string) {
  await store.insert([{
    subject: assertionLifecycleUri(CG, author, NAME, subGraphName),
    predicate: `${DKG}kaId`, object: `"${id}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
    graph: contextGraphMetaUri(CG),
  }]);
}

describe('retained lifecycle candidate evidence', () => {
  it('retains caller spelling and finds checksum/lowercase aliases without duplicates', () => {
    expect(assertionLifecycleAuthorCandidates(MIXED)).toEqual([MIXED, CHECKSUM, LOWER]);
    expect(assertionLifecycleAuthorCandidates(CHECKSUM)).toEqual([CHECKSUM, LOWER]);
    expect(assertionLifecycleAuthorCandidates(LOWER)).toEqual([LOWER, CHECKSUM]);
    expect(assertionLifecycleAuthorCandidates('peer-owner')).toEqual(['peer-owner']);
  });

  it('reads a case-preserved subject and its reservation in one store snapshot', async () => {
    const store = new OxigraphStore();
    await seed(store, CHECKSUM, '42');
    await store.insert([{
      subject: assertionLifecycleUri(CG, CHECKSUM, NAME), predicate: `${DKG}reservedUal`,
      object: '"did:dkg:evm:31337/author/42"', graph: contextGraphMetaUri(CG),
    }]);
    const query = vi.spyOn(store, 'query');
    const candidates = await readAssertionLifecycleCandidates(store, CG, LOWER, NAME);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ author: CHECKSUM,
      subject: assertionLifecycleUri(CG, CHECKSUM, NAME),
      record: { hasKaId: true, number: 42n, reservedUal: 'did:dkg:evm:31337/author/42' },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('VALUES ?subject'),
      { source: 'publisher.lifecycle.candidates' });
  });

  it('preserves competing subjects so recovery can reject ambiguous ownership', async () => {
    const store = new OxigraphStore();
    await seed(store, CHECKSUM, '42');
    await seed(store, LOWER, '43');
    const candidates = await readAssertionLifecycleCandidates(store, CG, MIXED, NAME);
    expect(candidates.map(c => [c.author, c.record.number])).toEqual([[CHECKSUM, 42n], [LOWER, 43n]]);
  });

  it('keeps peer ownership and subgraph scope distinct from the default graph lifecycle', async () => {
    const store = new OxigraphStore();
    await seed(store, 'peer-owner', '1');
    await seed(store, 'peer-owner', '2', 'private-subgraph');
    expect(await readAssertionLifecycleCandidates(store, CG, 'absent-peer', NAME)).toEqual([]);
    const candidates = await readAssertionLifecycleCandidates(store, CG, 'peer-owner', NAME, 'private-subgraph');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ author: 'peer-owner', record: { number: 2n } });
  });

  it.each([
    { type: 'boolean', value: false },
    { type: 'bindings', bindings: [{ p: `${DKG}kaId`, o: '"42"' }] },
    { type: 'bindings', bindings: [{ subject: 'urn:unrequested', p: `${DKG}kaId`, o: '"42"' }] },
    { type: 'bindings', bindings: [{ subject: assertionLifecycleUri(CG, LOWER, NAME), o: '"42"' }] },
    { type: 'bindings', bindings: [{ subject: assertionLifecycleUri(CG, LOWER, NAME), p: `${DKG}kaId` }] },
  ])('refuses unavailable or malformed query evidence (%#)', async result => {
    const store = new OxigraphStore();
    vi.spyOn(store, 'query').mockResolvedValue(result as Awaited<ReturnType<OxigraphStore['query']>>);
    await expect(readAssertionLifecycleCandidates(store, CG, LOWER, NAME))
      .rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_CORRUPT' });
  });

  it.each(['01', '-1', String(MAX_ROOTLESS_KA_NUMBER_V1 + 1n)])('refuses corrupt retained KA number %s', async id => {
    const store = new OxigraphStore();
    // Plain literals retain their lexical spelling; Oxigraph canonicalizes typed integers.
    await store.insert([{
      subject: assertionLifecycleUri(CG, LOWER, NAME), predicate: `${DKG}kaId`,
      object: JSON.stringify(id), graph: contextGraphMetaUri(CG),
    }]);
    await expect(readAssertionLifecycleCandidates(store, CG, LOWER, NAME))
      .rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_CORRUPT' });
  });

  it('refuses two KA numbers on the same retained lifecycle subject', async () => {
    const store = new OxigraphStore();
    await seed(store, LOWER, '42');
    await seed(store, LOWER, '43');
    await expect(readAssertionLifecycleCandidates(store, CG, LOWER, NAME))
      .rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_CORRUPT' });
  });
});

it('preserves legacy reserved-UAL whitespace normalization through the shared decoder', () => {
  const ual = 'did:dkg:evm:31337/author/42';
  const rows = [{ p: `${DKG}kaId`, o: '"42"' }, { p: `${DKG}reservedUal`, o: `"  ${ual}  "` }];
  expect(decodeAssertionLifecycleRecord(rows).reservedUal).toBe(ual);
  expect(decodeAssertionLifecycleRecord(rows, 'strict-reservation').reservedUal).toBe(ual);
});
