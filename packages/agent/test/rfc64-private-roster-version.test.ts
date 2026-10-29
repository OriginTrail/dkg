// SPDX-License-Identifier: Apache-2.0

// The roster generation of a private graph, as a node reads it from the graph's
// own metadata on a real store. The curator replaces its value when the roster
// changes. A member holds what a sync stored: the generation of its own
// approval, and beside it the newer one of a later change.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';

import { DKGAgent } from '../src/dkg-agent.js';

const CG = '0xabc/private-roster';
const SUBJECT = contextGraphDataGraphUri(CG);
const META = contextGraphMetaGraphUri(CG);
const ROSTER_VERSION = 'https://dkg.network/ontology#rfc64RosterVersion';
const INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

const generation = (lexical: string): Quad => ({
  subject: SUBJECT,
  predicate: ROSTER_VERSION,
  object: `"${lexical}"^^<${INTEGER}>`,
  graph: META,
});

const stores: OxigraphStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

async function nodeHolding(quads: readonly Quad[]) {
  const store = new OxigraphStore();
  stores.push(store);
  if (quads.length > 0) await store.insert([...quads]);
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.store = store;
  agent.getExplicitAccessPolicy = async () => 'private';
  agent.invalidateListContextGraphsCache = () => {};
  return { agent, store };
}

async function storedGenerations(store: OxigraphStore): Promise<string[]> {
  const result = await store.query(
    `SELECT ?version WHERE { GRAPH <${META}> { <${SUBJECT}> <${ROSTER_VERSION}> ?version } }`,
  );
  if (result.type !== 'bindings') throw new Error('expected bindings');
  return result.bindings.map((row) => String(row['version']).match(/^"([0-9]+)"/u)![1]!).sort();
}

describe('the roster generation of a private graph', () => {
  it('keeps only the newest generation after sequential and stale replayed sync pages', async () => {
    const { agent, store } = await nodeHolding([]);
    for (const version of ['1', '2', '3', '2']) {
      await agent.insertSyncedQuadsAndInvalidateListCache([generation(version)]);
    }
    expect(await storedGenerations(store)).toEqual(['3']);
    expect(await agent.readRfc64PrivateRosterVersionV1(CG)).toBe('3');
  });

  it('removes older legacy generations on the next sync without hiding a malformed value', async () => {
    const { agent, store } = await nodeHolding([
      generation('1'), generation('2'), { ...generation('0'), object: '"bad"' },
    ]);
    await agent.insertSyncedQuadsAndInvalidateListCache([generation('3')]);
    const held = await store.query(`SELECT ?version WHERE { GRAPH <${META}> { <${SUBJECT}> <${ROSTER_VERSION}> ?version } }`);
    expect(held.type === 'bindings' ? held.bindings.map(row => row.version).sort() : []).toEqual([
      `"3"^^<${INTEGER}>`, '"bad"',
    ]);
    await expect(agent.readRfc64PrivateRosterVersionV1(CG)).rejects.toThrow('not canonical');
  });

  it.each(['"2"@en', 'urn:invalid:roster', '"10000000000000"', '"007"'])(
    'does not erase malformed or out-of-lane evidence %s during compaction', async (object) => {
      const { agent, store } = await nodeHolding([generation('1'), { ...generation('2'), object }]);
      await agent.insertSyncedQuadsAndInvalidateListCache([generation('3')]);
      const rows = await store.query(`SELECT ?v WHERE { GRAPH <${META}> { <${SUBJECT}> <${ROSTER_VERSION}> ?v } }`);
      expect(rows.type === 'bindings' ? rows.bindings : []).toHaveLength(2);
      await expect(agent.readRfc64PrivateRosterVersionV1(CG)).rejects.toThrow('RFC-64 private roster version');
    },
  );

  it('invalidates cached graph facts even when post-insert compaction fails', async () => {
    const { agent, store } = await nodeHolding([]);
    const invalidated = vi.fn();
    agent.invalidateListContextGraphsCache = invalidated;
    vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('backend unavailable'));
    await expect(agent.insertSyncedQuadsAndInvalidateListCache([generation('2')])).rejects.toThrow('backend unavailable');
    expect(invalidated).toHaveBeenCalledOnce();
    expect(await agent.readRfc64PrivateRosterVersionV1(CG)).toBe('2');
  });

  it('adds no cleanup query for unrelated or foreign-subject metadata', async () => {
    const { agent, store } = await nodeHolding([generation('1')]);
    const updated = vi.spyOn(store, 'update');
    await agent.insertSyncedQuadsAndInvalidateListCache([
      { ...generation('2'), subject: 'urn:another:subject' },
      { ...generation('2'), graph: `${META}/other` },
      { ...generation('2'), predicate: 'urn:another:predicate' },
    ]);
    expect(updated).not.toHaveBeenCalled();
    expect(await storedGenerations(store)).toEqual(['1']);
  });

  it('is 0 while the metadata holds none', async () => {
    const { agent } = await nodeHolding([]);

    expect(await agent.readRfc64PrivateRosterVersionV1(CG)).toBe('0');
  });

  it('is the one generation the metadata holds', async () => {
    const { agent } = await nodeHolding([generation('1791911793700')]);

    expect(await agent.readRfc64PrivateRosterVersionV1(CG)).toBe('1791911793700');
  });

  // A member is approved at one generation. The roster changes, and a sync of
  // the graph stores the newer generation beside the one the member held.
  it('is the newest when a sync stored a later generation beside an earlier one', async () => {
    const { agent } = await nodeHolding([
      generation('1791911793700'),
      generation('1791911808810'),
    ]);

    expect(await agent.readRfc64PrivateRosterVersionV1(CG)).toBe('1791911808810');
  });

  it('compares generations as numbers, not as text', async () => {
    const { agent } = await nodeHolding([generation('9'), generation('10'), generation('2')]);

    expect(await agent.readRfc64PrivateRosterVersionV1(CG)).toBe('10');
  });

  // A plain literal: the store keeps its text, where it rewrites a typed integer.
  it('still refuses a generation that is not canonical, also beside a valid one', async () => {
    const { agent } = await nodeHolding([
      generation('1791911793700'),
      { ...generation('0'), object: '"007"' },
    ]);

    await expect(agent.readRfc64PrivateRosterVersionV1(CG))
      .rejects.toThrow('RFC-64 private roster version is not canonical');
  });

  it('still refuses a generation outside its lane, also beside a valid one', async () => {
    const { agent } = await nodeHolding([generation('1791911793700'), generation('10000000000000')]);

    await expect(agent.readRfc64PrivateRosterVersionV1(CG))
      .rejects.toThrow('RFC-64 private roster version exceeds its generation lane');
  });

  it('advances past the newest and leaves one generation in the metadata', async () => {
    const { agent, store } = await nodeHolding([
      generation('1791911793700'),
      generation('9999999999990'),
    ]);

    const next = await agent.advanceRfc64PrivateRosterVersionV1(CG);

    expect(next).toBe('9999999999991');
    expect(await storedGenerations(store)).toEqual(['9999999999991']);
    expect(await agent.readRfc64PrivateRosterVersionV1(CG)).toBe('9999999999991');
  });
});
