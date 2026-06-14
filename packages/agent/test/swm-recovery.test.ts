import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { recoverContextGraphSwm } from '../src/sync/requester/swm-recovery.js';

/**
 * OT-RFC-49 strip — WS-0.0 integration. `recoverContextGraphSwm` fetches a CG's
 * full current state from a peer and applies it via REPLACE (not the shared
 * incremental path's blind union), so a stale local store converges to the
 * source's value rather than accumulating a corrupt `{v1,v2}` superset.
 * Transport + verifier are mocked (no libp2p); the apply hits a real store.
 */
const CG = 'ws00-recovery';
const WS = contextGraphWorkspaceGraphUri(CG);
const WS_META = contextGraphWorkspaceMetaGraphUri(CG);
const SUBJ = 'urn:ws00r:shipment';
const STATUS = 'http://schema.org/status';
const ctx: OperationContext = { operationId: 'test', operationName: 'sync' } as never;

function page(quads: Quad[], completed = true): SyncPageResult {
  return { quads, bytesReceived: 0, resumedFromOffset: 0, nextOffset: quads.length, checkpointKey: 'k', completed };
}
async function statusValues(store: OxigraphStore): Promise<string[]> {
  const r = await store.query(`SELECT ?o WHERE { GRAPH <${WS}> { <${SUBJ}> <${STATUS}> ?o } }`);
  return r.type === 'bindings' ? r.bindings.map((b) => b['o']) : [];
}

describe('OT-RFC-49 WS-0.0 — recoverContextGraphSwm (fetch → verify → replace)', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {}))); });

  function makeDeps(store: OxigraphStore, sourceData: Quad[], sourceMeta: Quad[] = []) {
    return {
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (
        _c: OperationContext, _p: string, _cg: string, _inc: boolean,
        phase: 'data' | 'meta',
      ): Promise<SyncPageResult> => page(phase === 'data' ? sourceData : sourceMeta),
      processSharedMemoryBatch: async (dataQuads: Quad[], metaQuads: Quad[]) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        entityCreators: [...new Set(dataQuads.map((q) => q.subject))].map((entity) => ({
          dataGraph: WS, entity, creator: 'peer-source',
        })),
        droppedDataTriples: 0,
      }),
      store,
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    };
  }

  it('replaces a stale local value with the source value (no union corruption)', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([{ subject: SUBJ, predicate: STATUS, object: '"v1"', graph: WS }]);

    const result = await recoverContextGraphSwm(makeDeps(store, [
      { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS },
    ]));

    expect(result.completed).toBe(true);
    expect(result.replacedRoots).toBe(1);
    expect(await statusValues(store)).toEqual(['"v2"']); // ONLY v2 — the bug would leave {v1,v2}
  });

  it('is a clean recovery into an empty store (cold-start parity)', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const result = await recoverContextGraphSwm(makeDeps(store, [
      { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS },
    ]));
    expect(result.insertedDataQuads).toBe(1);
    expect(await statusValues(store)).toEqual(['"v2"']);
  });

  it('inserts verified meta and reports it', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const meta: Quad[] = [{ subject: 'urn:op:1', predicate: 'http://dkg.io/ontology/shareOperationId', object: '"op1"', graph: WS_META }];
    const result = await recoverContextGraphSwm(makeDeps(store, [
      { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS },
    ], meta));
    expect(result.insertedMetaQuads).toBe(1);
    const r = await store.query(`SELECT ?s WHERE { GRAPH <${WS_META}> { ?s ?p ?o } }`);
    expect(r.type === 'bindings' && r.bindings.length).toBe(1);
  });

  it('reports partial (not completed) when a phase never completes, but still applies via replace', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([{ subject: SUBJ, predicate: STATUS, object: '"v1"', graph: WS }]);
    const deps = makeDeps(store, [{ subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS }]);
    // data phase never completes and makes no progress → loop stops, partial.
    const partialDeps = {
      ...deps,
      fetchSyncPages: async (
        _c: OperationContext, _p: string, _cg: string, _inc: boolean, phase: 'data' | 'meta',
      ): Promise<SyncPageResult> =>
        phase === 'data'
          ? { ...page([{ subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS }], false), nextOffset: 0, resumedFromOffset: 0 }
          : page([]),
    };
    const result = await recoverContextGraphSwm(partialDeps);
    expect(result.completed).toBe(false);
    // even partial recovery is a replace, never a union
    expect(await statusValues(store)).toEqual(['"v2"']);
  });
});
