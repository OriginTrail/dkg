import { createRpcTimeoutError } from '@origintrail-official/dkg-chain';
import { createStoredPrefixAcquirer } from '../../src/durable-recovery-held-store.js';
import { MemorySyncCheckpointStore } from '../../src/sync/checkpoint/state.js';
import { createUalOnlyExactAssetSelection } from '../../src/sync/exact-assets.js';
import { DurableRecoveryRunner, type DurableRecoveryRunnerDependencies } from '../../src/sync/durable-recovery-runner.js';
import { currentHeldGraphScopedAssetsConfirmer } from '../../src/sync/requester/durable-data-holdings.js';
import type { GraphOwnedRecoveryContext } from '../../src/sync/requester/graph-owned-recovery.js';
import { runDurableSyncDetailed, runGraphOwnedDurableSyncDetailed, type DurableMetaContinuation, type DurableSyncContext } from '../../src/sync/requester/durable-sync.js';
import { CG, createRecoveryFixture, type RecoveryFixtureOptions, type RecoveryPeers, type AssetFixture } from './durable-recovery-fixture.js';
export { CG, PEER, SECOND_PEER, asset, servingPeer, generation, rowsOf, type AssetFixture } from './durable-recovery-fixture.js';

interface RequesterHarnessOptions extends RecoveryFixtureOptions {
  readonly chain?: { readonly assets?: () => readonly AssetFixture[]; readonly beforeRead?: () => Promise<void> };
  readonly holdings?: { readonly unreadable?: boolean; readonly enabled?: boolean };
}

/** Requester-level rounds and restartable runner, with a simulated chain verdict. */
export function createRequesterHarness(serving: RecoveryPeers, options: RequesterHarnessOptions = {}) {
  const fixture = createRecoveryFixture(serving, options);
  const { peers, materialization, info } = fixture;
  const chain = options.chain?.assets ?? (() => Object.values(peers)[0]!.current());
  let holdingsUnreadable = options.holdings?.unreadable === true;
  let chainAnswersPerRound = Number.POSITIVE_INFINITY;
  let chainAnswersLeft = chainAnswersPerRound;
  const holdings = (binding: () => Readonly<{ onChainId?: string; generation: number }>) => currentHeldGraphScopedAssetsConfirmer({
    binding,
    authenticateHeld: async (descriptor, requiredBinding) => {
      const { ual } = descriptor;
      await options.chain?.beforeRead?.();
      if (chainAnswersLeft <= 0) throw createRpcTimeoutError('held chain check exceeded its context-graph deadline');
      chainAnswersLeft -= 1;
      const onChain = chain().find((fixture) => fixture.ual === ual)!;
      return (requiredBinding === undefined || requiredBinding === '323')
        && onChain.rootHex === descriptor.claimedRootHex && BigInt(onChain.version) === BigInt(descriptor.assertionVersion);
    },
    budget: { createGraphScopedAuthenticationDeadline: () => Date.now() + 60_000 },
  });
  const round = (checkpointStore: MemorySyncCheckpointStore, remotePeerId: string,
    roundOptions: Pick<DurableSyncContext, 'settlementSliceDeadline'> & (
      { recovery: GraphOwnedRecoveryContext; exactAssetSelectionFor?: never }
      | { recovery?: never; exactAssetSelectionFor?: DurableSyncContext['exactAssetSelectionFor'] }),
  ) => materialization.withHeldAssetFence(async fence => {
    const { recovery, ...ordinaryOptions } = roundOptions;
    const context = {
      ...fixture.pagingPorts(checkpointStore, remotePeerId), ...ordinaryOptions,
      storedPrefix: createStoredPrefixAcquirer(fixture.heldStore()?.prove, CG, fence.assertCurrent),
    } satisfies DurableSyncContext;
    if (!recovery) return runDurableSyncDetailed(context);
    const { contextGraphIds: _contextGraphIds, exactAssetSelectionFor: _exactAssetSelectionFor, ...shared } = context;
    return runGraphOwnedDurableSyncDetailed({ ...shared, contextGraphId: CG,
      recovery: { ...recovery,
        held: options.holdings?.enabled === false ? undefined : {
          confirmCurrent: holdings(fence.binding)!, assertCurrent: fence.assertCurrent,
          prove: async request => {
            if (holdingsUnreadable) throw new Error('store queue wait timeout');
            return fixture.confirmedHoldings.prove(request);
          },
        },
      },
    });
  }, options.lifecycle?.signal?.());

  /**
   * A process lifetime: a new owner and a new checkpoint store. With
   * `sliceSpent`, each round starts past its slice's soft deadline, as once
   * held-copy checks used the slice: a DATA round stops at its first complete graph.
   */
  const start = (startOptions: { exactRequests?: boolean; sliceSpent?: boolean | (() => boolean); isRunning?: () => boolean; peerIds?: () => string[]; afterSlice?: () => void } = {}) => {
    const checkpointStore = new MemorySyncCheckpointStore();
    const dependencies: DurableRecoveryRunnerDependencies = {
      checkpointStore,
      isRunning: startOptions.isRunning ?? (() => true),
      resolvePreferredPeerId: async () => undefined,
      connectRequestedPeer: async () => {},
      primeConnections: async () => {},
      liveConnectionPeerIds: startOptions.peerIds ?? (() => Object.keys(peers)),
      admitPeer: async () => true,
      isPrivateContextGraph: async () => false,
      orderPeerIds: (peerIds) => [...peerIds],
      isSyncCapable: async () => true,
      executeSlice: async (peerId, durableMetaContinuation: DurableMetaContinuation, durableRecoveryRound, durableResumeBoundary) => {
        chainAnswersLeft = chainAnswersPerRound;
        const detailed = await round(checkpointStore, peerId, {
          recovery: { meta: durableMetaContinuation, holdings: durableRecoveryRound, boundary: durableResumeBoundary },
          settlementSliceDeadline: (typeof startOptions.sliceSpent === 'function' ? startOptions.sliceSpent() : startOptions.sliceSpent) ? Date.now() : undefined,
        });
        startOptions.afterSlice?.();
        if (!('decision' in detailed)) throw new Error('Expected an owned requester round');
        return detailed;
      },
      ...(startOptions.exactRequests === false ? {} : {
        executeExactSlice: async (peerId: string, assetUals: readonly string[]) => {
          const selection = createUalOnlyExactAssetSelection(assetUals);
          const { result } = await round(checkpointStore, peerId, { exactAssetSelectionFor: () => selection });
          return { result, complete: result.complete === true };
        },
      }),
      logDebug: () => {},
      logInfo: (message) => { info.push(message); },
      logWarn: (message) => { info.push(message); },
    };
    const runner = new DurableRecoveryRunner();
    return {
      checkpointStore,
      recover: () => runner.run({ contextGraphId: CG, dependencies }),
    };
  };
  const failHoldingsReads = (fail: boolean) => { holdingsUnreadable = fail; };
  const limitChainAnswersPerRound = (answers: number) => { chainAnswersPerRound = answers; };
  return { ...fixture, start, round, failHoldingsReads, limitChainAnswersPerRound };
}

