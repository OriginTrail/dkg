import {
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';

import type { SyncPageResult } from '../../src/sync/requester/page-fetch.js';
import { createSharedMemorySnapshotMaterializer } from
  '../../src/sync/requester/swm-snapshot-materializer.js';

export const CG = 'ws00-recovery';
export const WS = contextGraphWorkspaceGraphUri(CG);
export const WS_META = contextGraphWorkspaceMetaGraphUri(CG);
export const SUBJ = 'urn:ws00r:shipment';
export const STATUS = 'http://schema.org/status';
export const CTX: OperationContext = {
  operationId: 'test',
  operationName: 'sync',
} as never;
export const DKG = 'http://dkg.io/ontology/';
export const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
export const UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/7';
export const UAL_2 = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/8';

export class MemorySnapshotStore implements WorkspacePublicSnapshotStore {
  readonly snapshots = new Map<string, Quad[]>();

  async putSnapshot(input: { readonly digest: string; readonly quads: readonly Quad[] }) {
    this.snapshots.set(input.digest, input.quads.map((quad) => ({ ...quad })));
    return { ref: input.digest, byteLength: 0 };
  }

  async getSnapshot(ref: string): Promise<Quad[] | null> {
    return this.snapshots.get(ref)?.map((quad) => ({ ...quad })) ?? null;
  }
}

export function recoveryPage(quads: Quad[], completed = true): SyncPageResult {
  return {
    quads,
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: quads.length,
    checkpointKey: 'k',
    completed,
  };
}

export async function recoveryStatusValues(store: OxigraphStore): Promise<string[]> {
  const result = await store.query(
    `SELECT ?o WHERE { GRAPH <${WS}> { <${SUBJ}> <${STATUS}> ?o } }`,
  );
  return result.type === 'bindings'
    ? result.bindings.map((binding) => binding['o'])
    : [];
}

export function completeRecoveryApplyDeps(
  store: OxigraphStore,
  writeLocks = new Map<string, Promise<void>>(),
) {
  const snapshotMaterializer = createSharedMemorySnapshotMaterializer({
    store,
    writeLocks,
    invalidateListContextGraphsCache: () => undefined,
  });
  const ownership = new Map<string, Map<string, string>>();
  return {
    writeLocks,
    snapshotMaterializer,
    replaceMetaForRoots: async () => undefined,
    replaceMetaForGraphAssets: (assets: Parameters<
      typeof snapshotMaterializer.replaceMetaForGraphAssets
    >[0]) => snapshotMaterializer.replaceMetaForGraphAssets(assets),
    ensureOwnedMap: (key: string) => {
      let owned = ownership.get(key);
      if (owned === undefined) {
        owned = new Map();
        ownership.set(key, owned);
      }
      return owned;
    },
  };
}

export function makeRecoveryDeps(
  store: OxigraphStore,
  sourceData: Quad[],
  sourceMeta: Quad[] = [],
) {
  return {
    ctx: CTX,
    remotePeerId: 'peer-source',
    contextGraphId: CG,
    deadline: Number.MAX_SAFE_INTEGER,
    fetchSyncPages: async (
      _ctx: OperationContext,
      _peerId: string,
      _contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ): Promise<SyncPageResult> => recoveryPage(
      phase === 'data' ? sourceData : sourceMeta,
    ),
    processSharedMemoryBatch: async (dataQuads: Quad[], metaQuads: Quad[]) => ({
      verifiedData: dataQuads,
      verifiedMeta: metaQuads,
      entityCreators: [...new Set(sourceData.map((quad) => quad.subject))]
        .map((entity) => ({ dataGraph: WS, entity, creator: 'peer-source' })),
      droppedDataTriples: 0,
    }),
    ...completeRecoveryApplyDeps(store),
    store,
    ensureContextGraph: async () => {},
    setCheckpoint: () => {},
    deleteCheckpoint: () => {},
  };
}
