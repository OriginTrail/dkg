import { MockChainAdapter } from '@origintrail-official/dkg-chain';

import type {
  OrdinalOutcome,
  OrdinalRecoveryTarget,
  PendingOrdinalRecoveryResult,
} from '../../src/chain-reconciler.js';
import type { VmReconcileRotationRecord } from '../../src/dkg-agent-types.js';
import { DKGAgent } from '../../src/index.js';
import type {
  VmRecoveryUalDisposition,
} from '../../src/vm-recovery-provider-policy.js';
import type { VmRecoveryChainFootprint } from '../../src/vm-recovery-types.js';

interface TestPeerId {
  toString(): string;
}

interface ExactFetchResult {
  result: {
    fetchedDataTriples: number;
    fetchedMetaTriples: number;
    insertedTriples: number;
    failedPeers: number;
    failedPhases: number;
    deferredBackpressure: number;
  };
  disposition: VmRecoveryUalDisposition;
}

/**
 * Typed view of the private host seams exercised by exact-VM recovery tests.
 *
 * The production methods intentionally remain private. Keeping the one
 * unavoidable test-only cast here prevents each recovery suite from growing
 * a subtly different `Record<string, any>` model of the host.
 */
export interface VmRecoveryHostInternals {
  node: {
    peerId: string;
    libp2p: {
      getConnections(): Array<{ remotePeer: TestPeerId }>;
    };
  };
  preferredSyncPeers: Map<string, string>;
  vmReconcileFetchCooldownAt: Map<string, number>;
  vmReconcileRotationState: Map<string, VmReconcileRotationRecord>;
  vmReconcileRotationNow(): number;
  vmReconcileRotationSlotKey(target: OrdinalRecoveryTarget): string;
  resolveCuratorPeerIdsForCg(
    contextGraphId: string,
    options?: {
      maxPeerIds?: number;
      pagePeerIds?: number;
      afterPeerId?: string;
      signal?: AbortSignal;
      isCurrent?: () => boolean;
    },
  ): Promise<{
    peerIds: string[];
    curatorIsLocal: boolean;
    legacyTripleResolved: boolean;
    lookupFailed?: boolean;
    overflowed?: boolean;
    nextPageAfterPeerId?: string;
  }>;
  ensurePeerConnected(peerId: string, options?: { signal?: AbortSignal }): Promise<void>;
  selectCatchupPeers(peers: TestPeerId[]): TestPeerId[];
  waitForSyncProtocol(peer: TestPeerId, signal?: AbortSignal): Promise<boolean>;
  ensurePeerAdmittedForRecovery(
    peerId: string,
    context?: unknown,
    operation?: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  readVmReconcileRecoveryFootprint(
    onChainCgId: bigint,
    target: OrdinalRecoveryTarget,
    signal?: AbortSignal,
  ): Promise<Readonly<{ byteSize: bigint; merkleLeafCount: bigint }> | undefined>;
  syncExactKnowledgeAssetsFromPeerDetailed(
    peerId: string,
    contextGraphId: string,
    uals: string[],
    options?: { signal?: AbortSignal; isCurrent?: () => boolean },
  ): Promise<ExactFetchResult>;
  reconcileChainOrdinal(
    localCgId: string,
    onChainCgId: bigint,
    ordinal: number,
    headBlock: number | undefined,
    options?: {
      isTargetCurrent?: () => boolean;
      deferActiveFetch?: boolean;
      recoveryFootprint?: VmRecoveryChainFootprint;
    },
  ): Promise<OrdinalOutcome>;
  recoverVmReconcileBatch(
    localCgId: string,
    onChainCgId: bigint,
    targets: readonly OrdinalRecoveryTarget[],
    headBlock: number | undefined,
    isTargetCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<PendingOrdinalRecoveryResult>;
}

export interface VmRecoveryExactFetch {
  readonly peerId: string;
  readonly uals: readonly string[];
}

export interface VmRecoveryHostHarness<TTarget extends OrdinalRecoveryTarget> {
  readonly agent: DKGAgent;
  readonly chainAdapter: MockChainAdapter;
  readonly contextGraphId: bigint;
  readonly internals: VmRecoveryHostInternals;
  readonly targets: readonly TTarget[];
  readonly fetched: VmRecoveryExactFetch[];
  readonly recovered: Set<number>;
  maxActiveFetches(): number;
  run(): Promise<PendingOrdinalRecoveryResult>;
}

export interface VmRecoveryHostHarnessOptions<TTarget extends OrdinalRecoveryTarget> {
  readonly name: string;
  readonly localCgId: string;
  readonly peers: readonly string[];
  readonly targetCount: number;
  readonly targetForOrdinal: (ordinal: number) => TTarget;
  readonly onFetch: (
    peerId: string,
    targets: readonly TTarget[],
    recovered: Set<number>,
    signal?: AbortSignal,
  ) => VmRecoveryUalDisposition | Promise<VmRecoveryUalDisposition>;
}

export async function createVmRecoveryHostHarness<
  TTarget extends OrdinalRecoveryTarget,
>(
  options: VmRecoveryHostHarnessOptions<TTarget>,
): Promise<VmRecoveryHostHarness<TTarget>> {
  const chainAdapter = new MockChainAdapter();
  const { contextGraphId } = await chainAdapter.createOnChainContextGraph({
    accessPolicy: 0,
    publishPolicy: 1,
  });
  if (contextGraphId !== 1n) {
    throw new Error(`unexpected mock context graph id ${contextGraphId}`);
  }

  const agent = await DKGAgent.create({ name: options.name, chainAdapter });
  const internals = agent as unknown as VmRecoveryHostInternals;
  const connected = options.peers.map((peerId): TestPeerId => ({
    toString: () => peerId,
  }));
  internals.node = {
    peerId: `12D3KooW${options.name}Local`,
    libp2p: {
      getConnections: () => connected.map((remotePeer) => ({ remotePeer })),
    },
  };
  const preferredPeer = options.peers[0];
  if (preferredPeer) internals.preferredSyncPeers.set(options.localCgId, preferredPeer);
  internals.resolveCuratorPeerIdsForCg = async () => ({
    peerIds: [...options.peers],
    curatorIsLocal: false,
    legacyTripleResolved: false,
  });
  internals.ensurePeerConnected = async () => undefined;
  internals.selectCatchupPeers = (peers) => peers;
  internals.waitForSyncProtocol = async () => true;
  internals.ensurePeerAdmittedForRecovery = async () => true;

  const targets = Array.from(
    { length: options.targetCount },
    (_, ordinal) => options.targetForOrdinal(ordinal),
  );
  const targetsByUal = new Map(targets.map((target) => [target.ual, target]));
  const fetched: VmRecoveryExactFetch[] = [];
  const recovered = new Set<number>();
  let activeFetches = 0;
  let maxActiveFetches = 0;

  internals.readVmReconcileRecoveryFootprint = async () => ({
    byteSize: 1_024n,
    merkleLeafCount: 8n,
  });
  internals.syncExactKnowledgeAssetsFromPeerDetailed = async (
    peerId,
    _contextGraphId,
    uals,
    requestOptions,
  ) => {
    activeFetches += 1;
    maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
    try {
      const requested = uals.map((ual) => {
        const target = targetsByUal.get(ual);
        if (!target) throw new Error(`unexpected UAL ${ual}`);
        return target;
      });
      fetched.push({ peerId, uals: [...uals] });
      const disposition = await options.onFetch(
        peerId,
        requested,
        recovered,
        requestOptions?.signal,
      );
      return {
        result: {
          fetchedDataTriples: disposition === 'found' ? requested.length : 0,
          fetchedMetaTriples: disposition === 'found' ? requested.length * 8 : 0,
          insertedTriples: disposition === 'found' ? requested.length * 9 : 0,
          failedPeers: disposition === 'incomplete' ? 1 : 0,
          failedPhases: 0,
          deferredBackpressure: 0,
        },
        disposition,
      };
    } finally {
      activeFetches -= 1;
    }
  };
  internals.reconcileChainOrdinal = async (
    _localCgId,
    _onChainCgId,
    ordinal,
    _headBlock,
    reconcileOptions,
  ) => recovered.has(ordinal)
    ? { status: 'reconciled', blockNumber: 100 }
    : {
        status: 'pending',
        recovery: {
          ...targets[ordinal]!,
          recoveryFootprint: reconcileOptions?.recoveryFootprint,
        },
      };

  return {
    agent,
    chainAdapter,
    contextGraphId,
    internals,
    targets,
    fetched,
    recovered,
    maxActiveFetches: () => maxActiveFetches,
    run: () => internals.recoverVmReconcileBatch(
      options.localCgId,
      contextGraphId,
      targets,
      100,
      () => true,
    ),
  };
}
