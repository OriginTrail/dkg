import { runAdmittedDurableGraph } from '../../src/durable-recovery-graph.js';
import type { DurableRecoveryHost } from '../../src/durable-recovery-host.js';
import { exactAssetFetchSessionPolicy } from '../../src/sync/requester/exact-durable-fetch.js';
import { createUalOnlyExactAssetSelection } from '../../src/sync/exact-assets.js';
import type { MemorySyncCheckpointStore } from '../../src/sync/checkpoint/state.js';
import type { DurableSyncContext } from '../../src/sync/requester/durable-sync.js';
import { CG, ctx, createRecoveryFixture, type RecoveryFixtureOptions, type RecoveryPeers } from './durable-recovery-fixture.js';

/** The admitted-graph boundary selects exact transport, then falls back to production paging. */
export function createAdmittedGraphHarness(serving: RecoveryPeers, options: RecoveryFixtureOptions = {}) {
  const fixture = createRecoveryFixture(serving, options);
  const { peers, materialization } = fixture;
  const round = (checkpointStore: MemorySyncCheckpointStore, remotePeerId: string,
    roundOptions: Pick<DurableSyncContext, 'settlementSliceDeadline'>,
  ) => {
    const ports = fixture.pagingPorts(checkpointStore, remotePeerId);
    const selection = createUalOnlyExactAssetSelection(peers[remotePeerId]!.current().map(f => f.ual));
    if (selection.kind !== 'ual-only') throw new Error('Expected UAL selection');
    const host: DurableRecoveryHost = {
      owner: {}, policy: () => ({}), admission: { run: request => request.work() },
      transport: { fetchPages: ports.fetchSyncPages, stream: () => ({} as ReturnType<DurableRecoveryHost['transport']['stream']>) },
      verification: { processBatch: ports.processDurableBatchInWorker, parseAndFilter: peers[remotePeerId]!.parseAndFilter },
      storeInsert: ports.storeInsert, checkpoints: { deleteCheckpoint: ports.deleteCheckpoint, setCheckpoint: ports.setCheckpoint },
      log: { info: ports.logInfo, warn: ports.logWarn, debug: ports.logDebug },
      reconcile: async () => {}, resolveOrdinaryAuthority: () => { throw new Error('supplied authority'); },
      materialization: () => ({ ...materialization, storeGraphScopedAsset: ports.storeGraphScopedAsset! }),
      heldStore: fixture.heldStore(),
    };
    return runAdmittedDurableGraph({ host, ctx, remotePeerId, contextGraphId: CG, remainingContextGraphs: 1,
      authority: { coalescing: 'owner-only', admitVerifiedPage() {}, isRegisteredPublic: () => true,
        authenticate: () => { throw new Error('supplied materialization'); } },
      options: { exactAssetFetchPolicy: exactAssetFetchSessionPolicy(selection), exactRecoveryTransportMode: 'legacy',
        signal: options.lifecycle?.signal?.(),
        settlementSliceTimeoutMs: roundOptions.settlementSliceDeadline === undefined ? undefined : 1 },
    });
  };
  return { ...fixture, round };
}
