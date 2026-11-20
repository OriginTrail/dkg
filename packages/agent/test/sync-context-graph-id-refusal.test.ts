// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { QueryResult, TripleStore } from '@origintrail-official/dkg-storage';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import { syncContextGraphIdRefusal } from '../src/sync/auth/sync-context-graph-id.js';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';

const KEPT = '0x1111111111111111111111111111111111111111/kept-cg';
const keeps = (...ids: string[]) => (id: string) => ids.includes(id);

describe('syncContextGraphIdRefusal', () => {
  it.each([
    `${KEPT}/_private`,
    `${KEPT}/_meta`,
    `${KEPT}/_shared_memory`,
    `${KEPT}/_shared_memory_meta`,
    `${KEPT}/_working_memory`,
    `${KEPT}/sub/_private`,
    `${KEPT}/context/7/_meta`,
    `${KEPT}//_private`,
  ])('refuses %s, a reserved partition of a kept context graph', (id) => {
    expect(syncContextGraphIdRefusal(id, keeps(KEPT))).toBe('reserved-partition-segment');
  });

  it('refuses a reserved partition segment whether or not the shorter id is kept', () => {
    expect(syncContextGraphIdRefusal('legacy-cg/_private', keeps())).toBe('reserved-partition-segment');
  });

  it.each([
    `${KEPT}/sub`,
    `${KEPT}/context/7`,
    `${KEPT}/`,
  ])('refuses %s, a sub-graph of a kept context graph that is not kept itself', (id) => {
    expect(syncContextGraphIdRefusal(id, keeps(KEPT))).toBe('nested-context-graph-id');
  });

  it('serves a nested id this node keeps itself, such as a child context graph', () => {
    expect(syncContextGraphIdRefusal(`${KEPT}/child`, keeps(KEPT, `${KEPT}/child`))).toBeUndefined();
  });

  it('serves a legacy id with a reserved segment only when it is kept and no shorter id is', () => {
    expect(syncContextGraphIdRefusal('legacy/_v1', keeps('legacy/_v1'))).toBeUndefined();
    expect(syncContextGraphIdRefusal('legacy/_v1', keeps('legacy/_v1', 'legacy'))).toBe('reserved-partition-segment');
  });

  it.each([
    'agents',
    'ontology',
    'hbad-5',
    KEPT,
    '0x2222222222222222222222222222222222222222/other-cg',
    'did:dkg:context-graph:acme.example/v1',
  ])('leaves %s to authorization', (id) => {
    expect(syncContextGraphIdRefusal(id, keeps(KEPT))).toBeUndefined();
  });

  it.each([
    ['a non-string', 42],
    ['an empty id', ''],
    ['an id over 256 characters', 'a'.repeat(257)],
    ['disallowed characters', `${KEPT}> <x`],
    ['a dot-dot segment', `${KEPT}/../other`],
  ])('refuses %s', (_label, id) => {
    expect(syncContextGraphIdRefusal(id, keeps(KEPT))).toBe('invalid-context-graph-id');
  });
});

/** The receiver `authorizeSyncRequest` needs before it reaches the private-graph checks. */
function authorizer(options: { kept: string[]; privateIds: string[] }) {
  const isPrivateContextGraph = vi.fn(async (id: string) => options.privateIds.includes(id));
  const receiver = {
    keepsContextGraphLocally: (id: string) => options.kept.includes(id),
    isPrivateContextGraph,
  };
  const authorize = (request: SyncRequestEnvelope, peerId: string, opts: { signal?: AbortSignal } = {}) =>
    ContextGraphResolveMethods.prototype.authorizeSyncRequest.call(receiver as never, request, peerId, opts);
  return { authorize, isPrivateContextGraph };
}

function envelope(contextGraphId: string): SyncRequestEnvelope {
  return { contextGraphId, includeSharedMemory: false, phase: 'data', offset: 0, limit: 10 };
}

describe('authorizeSyncRequest', () => {
  it('refuses an id naming a kept private context graph\'s partition before looking up any policy', async () => {
    const { authorize, isPrivateContextGraph } = authorizer({ kept: [KEPT], privateIds: [KEPT] });

    await expect(authorize(envelope(`${KEPT}/_private`), 'peer')).resolves.toBe(false);
    await expect(authorize(envelope(`${KEPT}/_meta`), 'peer')).resolves.toBe(false);
    await expect(authorize(envelope(`${KEPT}/context/7`), 'peer')).resolves.toBe(false);
    expect(isPrivateContextGraph).not.toHaveBeenCalled();
  });

  it('still authorizes a public context graph by its own policy', async () => {
    const { authorize, isPrivateContextGraph } = authorizer({ kept: [KEPT], privateIds: [] });

    await expect(authorize(envelope(KEPT), 'peer')).resolves.toBe(true);
    expect(isPrivateContextGraph).toHaveBeenCalledWith(KEPT, expect.anything());
  });
});

describe('sync responder', () => {
  const PRIVATE_GRAPH = `did:dkg:context-graph:${KEPT}/_private`;
  const META_GRAPH = `did:dkg:context-graph:${KEPT}/_meta`;
  const noopLog = (_ctx: OperationContext, _message: string) => {};

  function responder(authorize: (request: SyncRequestEnvelope, peerId: string, opts: { signal?: AbortSignal }) => Promise<boolean>) {
    const readGraphs: string[] = [];
    const store: TripleStore = {
      query: async (sparql: string) => {
        readGraphs.push(sparql);
        return sparql.includes('SELECT ?s ?p ?o WHERE')
          ? { type: 'bindings', bindings: [{ s: '<urn:test:s>', p: 'http://schema.org/name', o: '"secret"' }] } satisfies QueryResult
          : { type: 'bindings', bindings: [] } satisfies QueryResult;
      },
      insert: async () => {},
      delete: async () => {},
      deleteByPattern: async () => 0,
      hasGraph: async () => true,
      createGraph: async () => {},
      dropGraph: async () => {},
      listGraphs: async () => [`did:dkg:context-graph:${KEPT}`, PRIVATE_GRAPH, META_GRAPH],
      deleteBySubjectPrefix: async () => 0,
      countQuads: async (graph?: string) => {
        if (graph) readGraphs.push(graph);
        return graph ? 1 : 0;
      },
      close: async () => {},
    };
    let handler: ((data: Uint8Array, peerId: string, options?: { signal?: AbortSignal }) => Promise<Uint8Array>) | null = null;
    registerSyncHandler({
      register: (_protocol, registered) => { handler = registered; },
      protocolSync: '/origintrail/dkg/sync/1.0.0',
      syncDeniedResponse: 'sync-denied',
      syncPageSize: 500,
      sharedMemoryTtlMs: 0,
      store,
      peerId: 'self-peer',
      parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
      authorizeSyncRequest: authorize,
      logWarn: noopLog,
      logDebug: noopLog,
    });
    return {
      readGraphs,
      async request(contextGraphId: string): Promise<string> {
        if (!handler) throw new Error('sync handler not registered');
        const bytes = await handler(new TextEncoder().encode(JSON.stringify(envelope(contextGraphId))), 'remote-peer');
        return new TextDecoder().decode(bytes);
      },
    };
  }

  it.each([`${KEPT}/_private`, `${KEPT}/_meta`])(
    'denies %s and reads none of the kept context graph\'s reserved graphs',
    async (id) => {
      const { authorize } = authorizer({ kept: [KEPT], privateIds: [KEPT] });
      const sync = responder(authorize);

      await expect(sync.request(id)).resolves.toBe('sync-denied');
      expect(sync.readGraphs.filter((read) => read.includes(PRIVATE_GRAPH) || read.includes(META_GRAPH))).toEqual([]);
    },
  );
});
