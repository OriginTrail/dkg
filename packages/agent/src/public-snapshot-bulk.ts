// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { BULK_GRAPH_PROTOCOL, BULK_GRAPH_MAX_ASSETS, bulkGraphTransportOptions, createOperationContext,
  } from '@origintrail-official/dkg-core';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import type { PublicSnapshotRecoveryOptions, PublicSnapshotRecoveryResult } from './public-snapshot-recovery.js';
import { type BulkGraphRequest } from './sync/bulk-graph-contract.js';
import { exchangeBulkGraphVerified, type BulkGraphMetrics } from './sync/requester/bulk-graph-stream.js';
import { materializeVerifiedGraphScopedGroup } from './sync/requester/graph-scoped-group.js';

export type PublicSnapshotBulkHost = Pick<DurableRecoveryHost, 'verification' | 'reconcile'> & {
  readonly store: Parameters<typeof materializeVerifiedGraphScopedGroup>[0]['store'];
  readonly router: Pick<ProtocolRouter, 'probeProtocol' | 'withDuplexStream'>;
  ensurePeerConnected(peer: string, options: { signal: AbortSignal }): Promise<void>;
};

/** One explicit public job, one configured supplier. No background or private sync policy changes. */
export async function recoverPublicSnapshotBulk(agent: PublicSnapshotBulkHost, options: PublicSnapshotRecoveryOptions & {
  deadline: number; dataDir: string | undefined;
  shouldQuarantineCommitted: () => boolean; onCommitted: () => void;
  log: (message: string) => void;
}): Promise<PublicSnapshotRecoveryResult> {
  const { contextGraphId, signal, assertCurrent } = options;
  if (!options.dataDir) throw new Error('Bulk snapshot requires an isolated persistent data directory');
  signal.throwIfAborted(); assertCurrent();
  if (!options.uals.length) return { committed: new Set(), bulkChunks: [] };
  async function* suppliers() {
    for await (const peers of options.peerBatches()) for (const peer of peers) {
      signal.throwIfAborted(); assertCurrent();
      try {
        await agent.ensurePeerConnected(peer, { signal });
        signal.throwIfAborted(); assertCurrent();
        const remaining = options.deadline - Date.now();
        if (remaining <= 0) throw new Error('Bulk snapshot deadline exceeded');
        const supported = await agent.router.probeProtocol(peer, BULK_GRAPH_PROTOCOL, Math.min(3_000, remaining), signal) === 'supported';
        signal.throwIfAborted(); assertCurrent();
        if (supported) yield peer;
      } catch {
        signal.throwIfAborted(); assertCurrent();
        if (Date.now() >= options.deadline) throw new Error('Bulk snapshot deadline exceeded');
      }
    }
  }
  let committedCount = 0;
  const chunks: BulkGraphMetrics[] = [];
  const ctx = createOperationContext('sync');
  let failure: unknown;
  let materialized = false;
  for await (const supplier of suppliers()) {
    try {
      while (committedCount < options.uals.length) {
        assertCurrent();
        const request: BulkGraphRequest = { version: 1, contextGraphId,
          snapshotDigest: options.evidence.snapshot.snapshotDigest,
          assetUals: options.uals.slice(committedCount, committedCount + BULK_GRAPH_MAX_ASSETS) };
        const result = await exchangeBulkGraphVerified(agent.router, supplier, request,
          bulkGraphTransportOptions(Math.max(1, options.deadline - Date.now()), signal),
          {
            stagingRoot: join(options.dataDir!, 'bulk-snapshot-staging'),
            verification: { contextGraphId, ctx,
              parseAndFilter: agent.verification.parseAndFilter,
              processDurableBatchInWorker: agent.verification.processBatch,
            },
            commit: async (assets, commitSignal) => {
              assertCurrent();
              const authenticated = assets.map(asset => options.evidence.authenticate(asset).asset);
              const outcome = await materializeVerifiedGraphScopedGroup({ store: agent.store, assets: authenticated,
                options: { priority: 'background', source: 'agent.publicSnapshot.bulkGroup', signal: commitSignal },
                assertCurrent: () => { commitSignal.throwIfAborted(); assertCurrent(); },
                shouldQuarantineCommitted: options.shouldQuarantineCommitted,
              });
              if (outcome !== 'applied') throw new Error('Bulk group was quarantined after graph binding changed');
              materialized = true;
              return authenticated;
            },
            reconcile: async (authenticated, commitSignal) => {
              options.onCommitted();
              commitSignal.throwIfAborted(); assertCurrent();
              await Promise.all(authenticated.map(asset => agent.reconcile(asset, ctx)));
            },
            onMetrics: metrics => options.log(`Bulk snapshot progress ${JSON.stringify(metrics)}`),
          });
        if (!result.committedAssetUals.length) throw new Error('Bulk snapshot made no durable progress');
        committedCount += result.committedAssetUals.length;
        chunks.push(result.metrics);
      }
      return { committed: new Set(options.uals.slice(0, committedCount)), bulkChunks: chunks };
    } catch (error) {
      signal.throwIfAborted(); assertCurrent();
      // An empty/refusing host is only a discovery hint. Once a group has been
      // applied, preserve any failure as terminal rather than replay partial work.
      if (materialized || Date.now() >= options.deadline) throw error;
      failure = error;
    }
  }
  throw new Error(failure ? 'Configured cores did not supply bulk graph v1 content' : 'Configured cores do not support bulk graph v1', { cause: failure });
}
