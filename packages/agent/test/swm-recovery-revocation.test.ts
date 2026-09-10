import { afterEach, describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  generateKnowledgeAssetShareMetadata,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';

import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { recoverContextGraphSwm } from '../src/sync/requester/swm-recovery.js';
import {
  CG,
  CTX,
  DKG,
  MemorySnapshotStore,
  STATUS,
  SUBJ,
  UAL,
  WS,
  WS_META,
  XSD_INTEGER,
  completeRecoveryApplyDeps,
  makeRecoveryDeps,
  recoveryPage,
  recoveryStatusValues,
} from './_helpers/swm-recovery-fixture.js';

describe('SWM recovery lease revocation', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  });

  it('does not report a final private apply as complete when revoked mid-commit', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([{ subject: SUBJ, predicate: STATUS, object: '"v1"', graph: WS }]);
    const revoked = new Error('selection revoked during final recovery commit');
    const controller = new AbortController();
    let current = true;
    const insert = store.insert.bind(store);
    store.insert = async (quads) => {
      const result = await insert(quads);
      current = false;
      controller.abort(revoked);
      return result;
    };

    await expect(recoverContextGraphSwm({
      ...makeRecoveryDeps(store, [
        { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS },
      ]),
      recoveryGuard: {
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) throw revoked;
        },
      },
    })).rejects.toBe(revoked);

    // The admitted replacement drains coherently, but the revoked invocation
    // cannot be counted as a completed recovery target by its caller.
    expect(await recoveryStatusValues(store)).toEqual(['"v2"']);
  });

  it('finishes an admitted exact graph and metadata replacement after revocation', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const assertionGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.SharedWorkingMemory,
      createGraphKnowledgeAssetScope(UAL, 1),
    );
    const operationId = 'rootless-mid-commit-revocation';
    const operationSubject = `urn:dkg:share:${CG}:${operationId}`;
    const headSubject = `${UAL}#dkg-swm-head`;
    const payload: Quad[] = [
      { subject: 'urn:rootless:atomic', predicate: STATUS, object: '"v2"', graph: '' },
    ];
    const digest = workspacePublicQuadsDigest(payload);
    const sourceMeta: Quad[] = [
      ...generateKnowledgeAssetShareMetadata({
        shareOperationId: operationId,
        contextGraphId: CG,
        kaUal: UAL,
        assertionVersion: 1,
        publicTripleCount: payload.length,
        privateTripleCount: 0,
        publisherPeerId: 'peer-source',
        timestamp: new Date(0),
      }, WS_META),
      {
        subject: operationSubject,
        predicate: `${DKG}publicQuadsDigest`,
        object: `"${digest}"`,
        graph: WS_META,
      },
      {
        subject: headSubject,
        predicate: `${DKG}contentScopeVersion`,
        object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`,
        graph: WS_META,
      },
      { subject: headSubject, predicate: `${DKG}kaUal`, object: UAL, graph: WS_META },
      {
        subject: headSubject,
        predicate: `${DKG}assertionVersion`,
        object: `"1"^^<${XSD_INTEGER}>`,
        graph: WS_META,
      },
      {
        subject: headSubject,
        predicate: `${DKG}assertionGraph`,
        object: assertionGraph,
        graph: WS_META,
      },
      {
        subject: headSubject,
        predicate: `${DKG}shareOperationId`,
        object: `"${operationId}"`,
        graph: WS_META,
      },
    ];
    await store.insert([{
      subject: 'urn:rootless:atomic',
      predicate: STATUS,
      object: '"stale"',
      graph: assertionGraph,
    }]);

    const revoked = new Error('selection revoked during graph replacement');
    const controller = new AbortController();
    let current = true;
    const replaceGraph = store.replaceGraph.bind(store);
    store.replaceGraph = async (graphUri, quads, options) => {
      const result = await replaceGraph(graphUri, quads, options);
      if (graphUri === assertionGraph) {
        current = false;
        controller.abort(revoked);
      }
      return result;
    };

    await expect(recoverContextGraphSwm({
      ctx: CTX,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_ctx, _peer, _cg, _swm, phase): Promise<SyncPageResult> => {
        if (phase === 'meta') return recoveryPage(sourceMeta);
        if (phase === 'snapshot') return recoveryPage(payload);
        return recoveryPage([]);
      },
      processSharedMemoryBatch: async (_dataQuads, metaQuads) => ({
        verifiedData: [],
        verifiedMeta: metaQuads,
        entityCreators: [],
        droppedDataTriples: 0,
      }),
      ...completeRecoveryApplyDeps(store),
      store,
      publicSnapshotStore: new MemorySnapshotStore(),
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
      recoveryGuard: {
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) throw revoked;
        },
      },
    })).rejects.toBe(revoked);

    // Revocation prevents the next recovery phase, but cannot strand the
    // already-admitted graph swap without its matching metadata.
    expect(await store.countQuads(assertionGraph)).toBe(payload.length);
    expect(await store.countQuads(WS_META)).toBe(sourceMeta.length);
    const recovered = await store.query(
      `SELECT ?o WHERE { GRAPH <${assertionGraph}> { <urn:rootless:atomic> <${STATUS}> ?o } }`,
    );
    expect(recovered.type === 'bindings' ? recovered.bindings : [])
      .toEqual([{ o: '"v2"' }]);
  });
});
