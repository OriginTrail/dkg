// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { BULK_GRAPH_PROTOCOL, BULK_GRAPH_MAX_ASSETS, bulkGraphTransportOptions, createOperationContext,
  } from '@origintrail-official/dkg-core';
import type { DKGAgent } from './dkg-agent.js';
import type { PublicSnapshotEvidence } from './public-snapshot-evidence.js';
import { type BulkGraphRequest } from './sync/bulk-graph-contract.js';
import { exchangeBulkGraphVerified, type BulkGraphMetrics } from './sync/requester/bulk-graph-stream.js';
import { materializeVerifiedGraphScopedGroup } from './sync/requester/graph-scoped-group.js';

/** One explicit public job, one configured supplier. No background or private sync policy changes. */
export async function recoverPublicSnapshotBulk(agent: DKGAgent, options: {
  contextGraphId: string; onChainId: string; peers: readonly string[]; uals: readonly string[];
  evidence: PublicSnapshotEvidence; signal: AbortSignal; assertCurrent: () => void;
  deadline: number; dataDir: string | undefined;
  shouldQuarantineCommitted: () => boolean; onCommitted: () => void;
  log: (message: string) => void;
}): Promise<{ committed: Set<string>; chunks: BulkGraphMetrics[] }> {
  const { contextGraphId, signal, assertCurrent } = options;
  if (!options.dataDir) throw new Error('Bulk snapshot requires an isolated persistent data directory');
  let supplier: string | undefined;
  for (const peer of options.peers) {
    await agent.ensurePeerConnected(peer, { signal }); assertCurrent();
    if ((await agent.getPeerProtocols(peer)).includes(BULK_GRAPH_PROTOCOL)) { supplier = peer; break; }
  }
  if (!supplier) throw new Error('Configured cores do not support bulk graph v1');
  const committed = new Set<string>(), chunks: BulkGraphMetrics[] = [];
  const ctx = createOperationContext('sync');
  while (committed.size < options.uals.length) {
    assertCurrent();
    const request: BulkGraphRequest = { version: 1, contextGraphId,
      snapshotDigest: options.evidence.snapshot.snapshotDigest,
      assetUals: options.uals.filter(ual => !committed.has(ual)).slice(0, BULK_GRAPH_MAX_ASSETS) };
    const result = await exchangeBulkGraphVerified(agent.router, supplier, request,
      bulkGraphTransportOptions(Math.max(1, options.deadline - Date.now()), signal),
      {
        stagingRoot: join(options.dataDir!, 'bulk-snapshot-staging'),
        verification: { contextGraphId, assetUals: request.assetUals, ctx,
          parseAndFilter: (text, graph, cg) => agent.getOrCreateSyncVerifyWorker().parseAndFilter(text, graph, cg),
          processDurableBatchInWorker: agent.processDurableBatchInWorker.bind(agent),
        },
        commit: async (assets, commitSignal) => {
          assertCurrent();
          const authenticated = assets.map(asset => options.evidence.authenticate(asset).asset);
          const outcomes = await materializeVerifiedGraphScopedGroup({ store: agent.store, assets: authenticated,
            options: { priority: 'background', source: 'agent.publicSnapshot.bulkGroup', signal: commitSignal },
            assertCurrent: () => { commitSignal.throwIfAborted(); assertCurrent(); },
            shouldQuarantineCommitted: options.shouldQuarantineCommitted,
          });
          if (outcomes.some(outcome => outcome !== 'applied')) throw new Error('Bulk group was quarantined after graph binding changed');
          options.onCommitted();
          for (const asset of authenticated) await agent.reconcileAfterGraphScopedMaterialization(asset, ctx);
        },
        onMetrics: metrics => options.log(`Bulk snapshot progress ${JSON.stringify(metrics)}`),
      });
    if (!result.committedAssetUals.length) throw new Error('Bulk snapshot made no durable progress');
    for (const ual of result.committedAssetUals) committed.add(ual);
    chunks.push(result.metrics);
  }
  return { committed, chunks };
}
