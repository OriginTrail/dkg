import type { Quad } from '@origintrail-official/dkg-storage';

const DKG_NS = 'http://dkg.io/ontology/';
const MERKLE_ROOT_PREDICATE = `${DKG_NS}merkleRoot`;

export type DurableSyncLifecycleAction = 'request' | 'response' | 'receive' | 'apply' | 'skip' | 'failure';

export interface DurableSyncLifecycleEvent {
  assetUal: string;
  event: string;
  action: DurableSyncLifecycleAction;
  result: string;
  source: string;
  contextGraphId: string;
  remotePeerId: string;
  fetchedMetaCount: number;
  fetchedDataCount: number;
  insertedMetaCount?: number;
  insertedDataCount?: number;
  rejectedKcs?: number;
  reason?: string;
}

export interface DurableSyncLifecycleCounts {
  fetchedMetaCount: number;
  fetchedDataCount: number;
  rejectedKcs?: number;
}

export interface DurableSyncLifecycleScope {
  assetUals: string[];
  recordVerified(counts: DurableSyncLifecycleCounts): void;
  recordSkip(counts: DurableSyncLifecycleCounts & { reason: string }): void;
  recordApply(counts: DurableSyncLifecycleCounts & {
    insertedMetaCount: number;
    insertedDataCount: number;
  }): void;
}

export interface DurableSyncLifecycleObserver {
  scopeFromVerifiedMeta(input: {
    contextGraphId: string;
    remotePeerId: string;
    verifiedMeta: readonly Quad[];
  }): DurableSyncLifecycleScope;
  recordFailure(input: {
    assetUals: readonly string[];
    contextGraphId: string;
    remotePeerId: string;
    fetchedMetaCount: number;
    fetchedDataCount: number;
    reason: string;
  }): void;
}

export function createDurableSyncKaLifecycleObserver(
  emit: (event: DurableSyncLifecycleEvent) => void,
): DurableSyncLifecycleObserver {
  const emitForAssets = (
    assetUals: readonly string[],
    input: Omit<DurableSyncLifecycleEvent, 'assetUal' | 'source'>,
  ) => {
    for (const assetUal of assetUals) {
      emit({
        assetUal,
        source: 'durable-sync',
        ...input,
      });
    }
  };

  return {
    scopeFromVerifiedMeta(input) {
      const assetUals = publishedAssetUalsFromMeta(input.verifiedMeta);
      return {
        assetUals,
        recordVerified(counts) {
          emitForAssets(assetUals, {
            event: 'sync_request',
            action: 'request',
            result: 'sent',
            contextGraphId: input.contextGraphId,
            remotePeerId: input.remotePeerId,
            ...counts,
          });
          emitForAssets(assetUals, {
            event: 'sync_response',
            action: 'response',
            result: 'fetched',
            contextGraphId: input.contextGraphId,
            remotePeerId: input.remotePeerId,
            ...counts,
          });
          emitForAssets(assetUals, {
            event: 'sync_receive',
            action: 'receive',
            result: 'verified',
            contextGraphId: input.contextGraphId,
            remotePeerId: input.remotePeerId,
            ...counts,
          });
        },
        recordSkip(counts) {
          emitForAssets(assetUals, {
            event: 'sync_skip',
            action: 'skip',
            result: 'deferred',
            contextGraphId: input.contextGraphId,
            remotePeerId: input.remotePeerId,
            ...counts,
          });
        },
        recordApply(counts) {
          emitForAssets(assetUals, {
            event: 'sync_apply',
            action: 'apply',
            result: 'inserted',
            contextGraphId: input.contextGraphId,
            remotePeerId: input.remotePeerId,
            ...counts,
          });
        },
      };
    },
    recordFailure(input) {
      emitForAssets(input.assetUals, {
        event: 'sync_failure',
        action: 'failure',
        result: 'failed',
        contextGraphId: input.contextGraphId,
        remotePeerId: input.remotePeerId,
        fetchedMetaCount: input.fetchedMetaCount,
        fetchedDataCount: input.fetchedDataCount,
        reason: input.reason,
      });
    },
  };
}

function publishedAssetUalsFromMeta(metaQuads: readonly Quad[]): string[] {
  const out = new Set<string>();
  for (const quad of metaQuads) {
    if (quad.predicate === MERKLE_ROOT_PREDICATE && quad.subject.startsWith('did:dkg:')) {
      out.add(quad.subject);
    }
  }
  return [...out];
}
