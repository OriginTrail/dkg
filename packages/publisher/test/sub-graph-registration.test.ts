/**
 * The shared check of a complete sub-graph registration and the operation that
 * makes one, used by every path that registers a sub-graph it learns of from
 * replicated data (live shared-memory writes, gossip publishes, shared-memory
 * sync).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  SharedMemoryHandler,
  ensureSubGraphRegistration,
  generateSubGraphRegistration,
  hasSubGraphRegistration,
  type SubGraphRegistration,
} from '../src/index.js';
import { encodeRootlessWorkspaceRequest } from './_helpers/rootless-workspace.js';

const CG = '0x1111111111111111111111111111111111111111/sub-graph-registration';
const META = `did:dkg:context-graph:${CG}/_meta`;
const SUB_GRAPH = `did:dkg:context-graph:${CG}/notes`;

function registration(createdBy: string, timestamp = new Date(0)): SubGraphRegistration {
  return { contextGraphId: CG, subGraphName: 'notes', createdBy, timestamp };
}

async function registrationRows(store: OxigraphStore): Promise<string[]> {
  const result = await store.query(`SELECT ?p ?o WHERE { GRAPH <${META}> { <${SUB_GRAPH}> ?p ?o } }`);
  const rows = result.type === 'bindings' ? result.bindings : [];
  return rows.map((row) => `${String(row['p'])} ${String(row['o'])}`).sort();
}

describe('sub-graph registration', () => {
  const stores: OxigraphStore[] = [];
  const newStore = () => {
    const store = new OxigraphStore();
    stores.push(store);
    return store;
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it('registers a sub-graph without a registration and returns the quads it inserted', async () => {
    const store = newStore();

    const outcome = await ensureSubGraphRegistration(store, registration('12D3KooWAuthor'));

    expect(outcome).toEqual({
      registered: true,
      quads: generateSubGraphRegistration(registration('12D3KooWAuthor')),
    });
    expect(await hasSubGraphRegistration(store, CG, 'notes')).toBe(true);
    expect(await registrationRows(store)).toHaveLength(outcome.quads.length);
  });

  it('leaves a complete registration as it is, so a repeated call changes nothing', async () => {
    const store = newStore();
    await ensureSubGraphRegistration(store, registration('12D3KooWFirst'));
    const before = await registrationRows(store);

    const outcome = await ensureSubGraphRegistration(store, registration('12D3KooWSecond', new Date(1_000)));

    expect(outcome).toEqual({ registered: false, quads: [] });
    expect(await registrationRows(store)).toEqual(before);
  });

  it('counts a registration as complete only with its type, its name and its creator', async () => {
    const store = newStore();
    await store.insert(generateSubGraphRegistration(registration('12D3KooWFirst'))
      .filter((quad) => quad.predicate !== 'http://dkg.io/ontology/createdBy'));

    expect(await hasSubGraphRegistration(store, CG, 'notes')).toBe(false);
    expect((await ensureSubGraphRegistration(store, registration('12D3KooWAuthor'))).registered).toBe(true);
    expect(await hasSubGraphRegistration(store, CG, 'notes')).toBe(true);
    expect(await hasSubGraphRegistration(store, CG, 'other')).toBe(false);
  });

  it('labels the registration check with the caller\'s source, when it names one', async () => {
    const store = newStore();
    const query = vi.spyOn(store, 'query');

    await ensureSubGraphRegistration(store, registration('12D3KooWAuthor'), { source: 'test.subGraphRegistration' });
    await hasSubGraphRegistration(store, CG, 'notes');

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]).toEqual({ source: 'test.subGraphRegistration' });
    expect(query.mock.calls[1]).toHaveLength(1);
  });

  it('registers the sub-graph of a live shared-memory write once and hands the inserted quads on', async () => {
    const store = newStore();
    const dirty: Quad[] = [];
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: new Map(),
      markContextGraphMetaDirtyFromQuads: (quads) => { dirty.push(...quads); },
    });
    const write = (subject: string, shareOperationId: string) => encodeRootlessWorkspaceRequest({
      contextGraphId: CG,
      subGraphName: 'notes',
      nquads: new TextEncoder().encode(`<${subject}> <http://schema.org/name> "${subject}" <did:dkg:context-graph:${CG}> .`),
      publisherPeerId: '12D3KooWWriter',
      shareOperationId,
      timestampMs: Date.now(),
    });

    expect((await handler.handle(write('urn:note:1', 'live-write-1'), '12D3KooWWriter')).applied).toBe(true);
    const registered = await registrationRows(store);
    expect(registered).toContain('http://dkg.io/ontology/createdBy did:dkg:agent:12D3KooWWriter');
    expect(dirty.filter((quad) => quad.subject === SUB_GRAPH)).toHaveLength(registered.length);

    expect((await handler.handle(write('urn:note:2', 'live-write-2'), '12D3KooWWriter')).applied).toBe(true);
    expect(await registrationRows(store)).toEqual(registered);
    expect(dirty.filter((quad) => quad.subject === SUB_GRAPH)).toHaveLength(registered.length);
  });
});
