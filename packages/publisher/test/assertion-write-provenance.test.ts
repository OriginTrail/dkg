import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, assertionLifecycleUri, contextGraphMetaUri, generateEd25519Keypair, toAgentDid } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { generateSubGraphRegistration } from '../src/metadata.js';

const CG = 'write-provenance';
const AUTHOR = `0x${'11'.repeat(20)}`;
const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';
const NAME = 'draft';

async function fixture(provenanceEvents = true, subGraphName?: string) {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store, chain: new MockChainAdapter(), eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(), provenanceEvents,
  });
  if (subGraphName) await store.insert(generateSubGraphRegistration({
    contextGraphId: CG, subGraphName, createdBy: AUTHOR, timestamp: new Date(),
  }));
  await publisher.assertionCreate(CG, NAME, AUTHOR, subGraphName);
  return { store, publisher };
}

async function writeEvents(store: OxigraphStore) {
  const result = await store.query(`SELECT ?event ?actor ?time ?assertion ?graph ?count WHERE {
    GRAPH <${contextGraphMetaUri(CG)}> {
      ?event a <${DKG}AssertionWritten>, <${PROV}Activity> ;
        <${PROV}wasAssociatedWith> ?actor ; <${PROV}startedAtTime> ?time ;
        <${PROV}used> ?assertion ; <${DKG}assertionGraph> ?graph ; <${DKG}quadCount> ?count .
    }
  } ORDER BY ?event`);
  if (result.type !== 'bindings') throw new Error('expected event bindings');
  return result.bindings;
}

describe('assertion write provenance', () => {
  it.each([undefined, 'science'])('records each successful write in scope %s, including repeated payloads', async (sub) => {
    const { store, publisher } = await fixture(true, sub);
    const payload = [{ subject: 'urn:write:entity', predicate: 'http://schema.org/name', object: '"First"' }];
    const startedAt = Date.now();
    await publisher.assertionWrite(CG, NAME, AUTHOR, payload, sub);
    await publisher.assertionWrite(CG, NAME, AUTHOR, payload, sub);
    await publisher.assertionWrite(CG, NAME, AUTHOR, [
      ...payload, { subject: 'urn:write:entity', predicate: 'http://schema.org/description', object: '"Second"' },
    ], sub);
    const finishedAt = Date.now();
    const data = await publisher.assertionQuery(CG, NAME, AUTHOR, sub);
    expect(data).toHaveLength(2);
    const events = await writeEvents(store);
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.event)).size).toBe(3);
    expect(events.map((event) => Number(String(event.count).match(/\d+/)?.[0])).sort()).toEqual([1, 1, 2]);
    for (const event of events) {
      expect(event.actor).toBe(toAgentDid(AUTHOR));
      expect(event.assertion).toBe(assertionLifecycleUri(CG, AUTHOR, NAME, sub));
      const writtenGraph = await store.query(`ASK { GRAPH <${event.graph}> {
        <urn:write:entity> <http://schema.org/name> "First" ; <http://schema.org/description> "Second"
      } }`);
      expect(writtenGraph).toEqual({ type: 'boolean', value: true });
      const lexicalTime = String(event.time).match(/^"([^"]+)"/)?.[1];
      expect(lexicalTime).toBeDefined();
      expect(Date.parse(lexicalTime!)).toBeGreaterThanOrEqual(startedAt);
      expect(Date.parse(lexicalTime!)).toBeLessThanOrEqual(finishedAt);
      expect(event.time).toContain('http://www.w3.org/2001/XMLSchema#dateTime');
      expect(event.count).toContain('http://www.w3.org/2001/XMLSchema#integer');
    }
  });

  it('does not record a successful write when the payload insert rejects', async () => {
    const { store, publisher } = await fixture();
    const insert = store.insert.bind(store);
    vi.spyOn(store, 'insert').mockImplementation(async (quads) => {
      if (quads.some((quad) => quad.subject === 'urn:write:rejected')) throw new Error('payload insert failed');
      await insert(quads);
    });
    await expect(publisher.assertionWrite(CG, NAME, AUTHOR, [{
      subject: 'urn:write:rejected', predicate: 'http://schema.org/name', object: '"Rejected"',
    }])).rejects.toThrow('payload insert failed');
    expect(await publisher.assertionQuery(CG, NAME, AUTHOR)).toEqual([]);
    expect(await writeEvents(store)).toEqual([]);
  });

  it('respects lite provenance policy while still writing payload and lifecycle metadata', async () => {
    const { store, publisher } = await fixture(false);
    await publisher.assertionWrite(CG, NAME, AUTHOR, [{
      subject: 'urn:write:lite', predicate: 'http://schema.org/name', object: '"Lite"',
    }]);
    expect(await publisher.assertionQuery(CG, NAME, AUTHOR)).toHaveLength(1);
    expect(await writeEvents(store)).toEqual([]);
    const lifecycle = await store.query(`ASK { GRAPH <${contextGraphMetaUri(CG)}> {
      <${assertionLifecycleUri(CG, AUTHOR, NAME)}> <${DKG}state> "created"
    } }`);
    expect(lifecycle).toEqual({ type: 'boolean', value: true });
  });
});
