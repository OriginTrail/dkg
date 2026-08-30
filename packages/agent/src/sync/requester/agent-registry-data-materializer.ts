// SPDX-License-Identifier: Apache-2.0

import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { getSyncCheckpointKey } from '../checkpoint/state.js';
import {
  filterOversizedSyncQuads,
  type OversizeDrop,
} from '../oversize-filter.js';
import {
  authoritativeSnapshotPage,
  reconcileAgentRegistrySnapshot,
  type AuthoritativeGraphSnapshotMaterializer,
} from './authoritative-graph-snapshot.js';
import type {
  DurableDataMaterializer,
  DurableStagedSnapshotMaterializationRequest,
} from './durable-sync.js';

export interface AgentRegistryDataMaterializerDependencies {
  readonly contextGraphId: string;
  readonly remotePeerId: string;
  readonly store: TripleStore;
  readonly snapshots: AuthoritativeGraphSnapshotMaterializer;
  readonly insertNonRegistryQuads: (
    quads: readonly Quad[],
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly recordOversizeDrops: (
    drops: readonly OversizeDrop[],
    seam: string,
  ) => void;
  readonly invalidateContextGraphList: () => void;
  readonly invalidateContextGraphMetaProjection: () => void;
}

/**
 * Owns the complete AGENTS DATA materialization policy: private resumable
 * staging, graph classification, oversize refusal, authenticated profile
 * reconciliation, atomic settlement, and cache invalidation. The lifecycle
 * coordinator only selects this strategy for the registry graph.
 */
export function createAgentRegistryDataMaterializer(
  dependencies: AgentRegistryDataMaterializerDependencies,
): Extract<DurableDataMaterializer, { mode: 'staged-snapshot' }> {
  const graphUri = contextGraphDataUri(dependencies.contextGraphId);
  const checkpointKey = getSyncCheckpointKey(
    dependencies.remotePeerId,
    dependencies.contextGraphId,
    false,
    'data',
  );
  const assertGraph = (receivedGraphUri: string): void => {
    if (receivedGraphUri !== graphUri) {
      throw new Error(`Authoritative AGENTS materializer received graph ${receivedGraphUri}`);
    }
  };

  return {
    mode: 'staged-snapshot',
    prepareFetch: (_contextGraphId, receivedGraphUri) => {
      assertGraph(receivedGraphUri);
      dependencies.snapshots.prepareFetch(checkpointKey);
    },
    materialize: async (request: DurableStagedSnapshotMaterializationRequest) => {
      assertGraph(request.graphUri);
      const registryQuads: Quad[] = [];
      const otherQuads: Quad[] = [];
      for (const quad of request.verifiedQuads) {
        (quad.graph === graphUri ? registryQuads : otherQuads).push(quad);
      }
      if (otherQuads.length > 0) {
        await dependencies.insertNonRegistryQuads(otherQuads, request.signal);
      }

      const materialized = await dependencies.snapshots.materialize({
        page: authoritativeSnapshotPage(request.page),
        verifiedQuads: registryQuads,
        retainablePrefix: request.retainablePrefix,
        completeSnapshot: request.completeSnapshot,
        transitionCheckpoint: request.transitionCheckpoint,
        commit: async (completeSnapshotQuads) => {
          const filtered = filterOversizedSyncQuads(completeSnapshotQuads);
          dependencies.recordOversizeDrops(
            filtered.dropped,
            'durable-sync:authoritative-agents',
          );
          return reconcileAgentRegistrySnapshot({
            store: dependencies.store,
            graphUri,
            remotePeerId: dependencies.remotePeerId,
            quads: filtered.kept,
            insertForwarded: (quads, options) => dependencies.store.insert(quads, options),
            authenticatedFreshness: dependencies.snapshots.profileFreshness,
            options: {
              priority: 'background',
              source: 'agent.durableSync.agentRegistryReconcile',
              signal: request.signal,
            },
            invalidate: () => {
              dependencies.invalidateContextGraphList();
              dependencies.invalidateContextGraphMetaProjection();
            },
          });
        },
      });
      return {
        kind: materialized.kind,
        committedTriples: materialized.committedTriples + otherQuads.length,
      };
    },
  };
}
