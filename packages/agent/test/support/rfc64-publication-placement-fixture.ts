/**
 * GH#3081 — one author whose confirmed private placements run through the real post-confirmation
 * observer, the real finalized-private supervisor and the real catalog repair, plus the real async
 * publisher wired to the agent's own completion tail.
 *
 * What is real: the publisher's queue, detached execution, reconciliation walk and terminal write;
 * the agent's recovery finalizer and the tail both completion paths end in
 * (`afterConfirmedGraphScopedVmPublishV1`); the observer, the durable marker store, the supervisor
 * and the whole repair body (coverage check, successor, signature, applied-head CAS, announcement).
 *
 * What stands in for a chain: the executor reports its transaction as accepted and confirmed
 * without sending one, the two chain-proof resolvers answer `recovered`, the recovery finalizer's
 * chain normalization answers as it does for a publish that is the asset's current version (the
 * test file mocks the normalizer module for that; see {@link recoveredNamedKaPublishV1}), and the
 * agent's own finalization handler gives a staged answer about the VM content and writes none.
 * The fixture's assets have no named lifecycle record, so recovery writes its receipt without
 * stamping one, as it does for any assertion that moved on.
 *
 * Time: one clock the row moves by hand drives the publisher's job timestamps and the placement
 * timing, so a wait is exactly what the row parked.
 */
import { afterEach, vi } from 'vitest';

import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  createGraphKnowledgeAssetScope,
  createOperationContext,
  knowledgeAssetLayerGraphUri,
  type AssertionSeal,
  type Logger,
  type OperationContext,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import {
  TripleStoreAsyncLiftPublisher,
  type AsyncKnowledgeAssetVmPublishRecoveryEvidence,
  type AsyncLiftPublisherConfig,
  type KnowledgeAssetVmPublishRequest,
  type PersistedLiftJob,
  type PublishResult,
} from '@origintrail-official/dkg-publisher';

import type { DKGAgent } from '../../src/index.js';
import type { ChainReconciledKCOutcome } from '../../src/finalization-handler.js';
import type { Rfc64FinalizedPrivatePlacementRepairRequestV1 } from
  '../../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import {
  assertionSealFromQueuedKnowledgeAssetVmPublishRequest,
  isGraphScopedKnowledgeAssetVmPublishRequest,
} from '../../src/internal/knowledge-asset-vm-publish-request.js';
import {
  CatalogPlacementTimingV1,
  installCatalogPlacementTimingV1,
  type CatalogPlacementAttemptV1,
  type CatalogPlacementWaiterObserverV1,
  type FinalizedPrivatePlacementQueueStatusV1,
} from '../../src/internal/catalog-placement-timing.js';
import type {
  Rfc64FinalizedPrivatePlacementRepairStoreV1,
  Rfc64FinalizedPrivatePlacementRepairV1,
} from '../../src/rfc64/finalized-private-placement-repair-store-v1.js';
import type { AppliedCatalogHeadSnapshotV1 } from '../../src/rfc64/inventory-v1/index.js';
import {
  AUTHOR,
  AUTHOR_WALLET,
  CONTEXT_GRAPH_ID,
  NETWORK_ID,
  PROJECTION_QUADS,
  catalogScopeDigestV1,
  seedInventoryAssetV1,
  startRepairAgentV1,
} from './rfc64-local-catalog-repair-fixture.js';

type Hex = `0x${string}`;

/** Parks the code that passes through it until the row lets each entry, or all of them, go. */
export interface GateV1 {
  /** The gated code calls this and continues when its own entry is released. */
  readonly pass: () => Promise<void>;
  /** How many times the gated code has arrived, released or not. */
  readonly entries: () => number;
  /** How many entries are parked right now. */
  readonly parked: () => number;
  /** Resolves once `count` entries have arrived. */
  readonly entered: (count?: number) => Promise<void>;
  /** Let the oldest parked entry go; false when none is parked. */
  readonly releaseNext: () => boolean;
  /** Let every parked entry go and stop parking later ones. */
  readonly release: () => void;
}

/**
 * Every gate a row made, opened again when the row ends, however it ends. A row that fails or
 * times out with a placement still parked would otherwise leave its agent unable to stop. This
 * hook is registered after the repair fixture's and therefore runs before it.
 */
const openGates: GateV1[] = [];
afterEach(() => {
  for (const gate of openGates.splice(0)) gate.release();
});

export function gateV1(): GateV1 {
  const parked: Array<() => void> = [];
  const arrivals: Array<{ count: number; resolve: () => void }> = [];
  let entries = 0;
  let open = false;
  const gate: GateV1 = {
    pass: async () => {
      entries += 1;
      for (const waiter of arrivals.splice(0)) {
        if (entries >= waiter.count) waiter.resolve();
        else arrivals.push(waiter);
      }
      if (!open) await new Promise<void>((resolve) => { parked.push(resolve); });
    },
    entries: () => entries,
    parked: () => parked.length,
    entered: (count = 1) => (entries >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => { arrivals.push({ count, resolve }); })),
    releaseNext: () => {
      const next = parked.shift();
      next?.();
      return next !== undefined;
    },
    release: () => {
      open = true;
      for (const next of parked.splice(0)) next();
    },
  };
  openGates.push(gate);
  return gate;
}

/** What became of some work within a bound of real time. */
export type SettlementV1<T> =
  | Readonly<{ status: 'fulfilled'; value: T }>
  | Readonly<{ status: 'rejected'; reason: unknown }>
  | Readonly<{ status: 'pending' }>;

/**
 * What became of `work` within `ms` of real time. A row asserts on the whole answer, so work that
 * rejected cannot pass for work that completed, and work that is still pending reads `pending`
 * instead of hanging the row. The default bound is generous: it is only ever spent when the work
 * does not settle at all.
 */
export async function settledWithinV1<T>(work: Promise<T>, ms = 5_000): Promise<SettlementV1<T>> {
  let timer!: ReturnType<typeof setTimeout>;
  const pending = new Promise<SettlementV1<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'pending' }), ms);
  });
  try {
    return await Promise.race([
      work.then(
        (value): SettlementV1<T> => ({ status: 'fulfilled', value }),
        (reason: unknown): SettlementV1<T> => ({ status: 'rejected', reason }),
      ),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The value `work` completed with, for a step a row needs to have succeeded. A rejection is thrown
 * on as it is; work that is still pending after `ms` of real time fails the row by name.
 */
export async function fulfilledWithinV1<T>(work: Promise<T>, what: string, ms = 5_000): Promise<T> {
  const settlement = await settledWithinV1(work, ms);
  if (settlement.status === 'fulfilled') return settlement.value;
  if (settlement.status === 'rejected') throw settlement.reason;
  throw new Error(`${what}: still pending after ${ms} ms`);
}

/** Real event-loop turns until `condition` holds, bounded by wall clock. */
export async function untilV1(condition: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const startedAt = performance.now();
  while (!(await condition())) {
    if (performance.now() - startedAt > ms) throw new Error(`timed out waiting until ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export interface PlacementAgentV1 {
  readonly agent: DKGAgent;
  /** The fixture clock: publisher job timestamps and placement timing both read it. */
  readonly clock: { now: number };
  /** Durable finalized-private placement markers, as the supervisor lists them. */
  readonly markers: () => readonly Rfc64FinalizedPrivatePlacementRepairV1[];
  /** Rows in the author's applied catalog head, or null before the first placement. */
  readonly catalogRows: () => string | null;
  /** The finalized-private queue as `/api/status` reports it; undefined without supervisor state. */
  readonly queue: () => Readonly<FinalizedPrivatePlacementQueueStatusV1> | undefined;
  /** How often the real steps of a placement ran: the calls reach the real implementation. */
  readonly counts: () => PlacementCountsV1;
  /**
   * Park every placement inside the real repair body, where it starts to produce its successor:
   * past the coverage check and the locked state read, before the applied-head CAS, holding the
   * asset lock and the catalog mutation lock.
   */
  readonly holdPlacements: () => GateV1;
  /** What happened at the terminal boundary and after it, in order, across all assets. */
  readonly events: () => readonly string[];
  readonly record: (event: string) => void;
  /** Every placement request the observer made, in order. */
  readonly requests: () => readonly Rfc64FinalizedPrivatePlacementRepairRequestV1[];
  readonly placementLines: () => string[];
  readonly warnings: () => string[];
  /**
   * The lane the observer and the supervisor resolve. A row flips `acceptsFinalizedVmRepair` to
   * stage a transition, or sets `unavailable` to make every resolution throw it.
   */
  readonly lane: { acceptsFinalizedVmRepair: boolean; unavailable?: Error };
  /** When set, every durable marker write rejects with it. */
  failMarkerWrite: Error | undefined;
  /** Runs right after a durable marker write, before the placement is requested. */
  afterMarkerStored: (() => void) | undefined;
  /** When set, the next placement attempts reject with these errors, one each. */
  readonly failPlacements: Error[];
}

export interface PlacementCountsV1 {
  readonly repairs: number;
  readonly coverageChecks: number;
  readonly successors: number;
  readonly signatures: number;
  readonly announcements: number;
}

interface StartPlacementAgentOptionsV1 {
  readonly name: string;
  readonly dataDir?: string;
  readonly storePath?: string;
  /** Runs before the agent starts, after the fixture's own spies are in place. */
  readonly beforeStart?: (agent: DKGAgent) => void | Promise<void>;
}

/** What the agent's completion tail takes; both completion paths build it from the queued request. */
interface ConfirmedVmPublishTailInputV1 {
  readonly status: PublishResult['status'];
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly assertionCoordinate: string;
  readonly shareOperationId?: string;
  readonly seal: AssertionSeal;
  readonly assertionUri: string;
  readonly ctx: OperationContext;
  readonly publicationLabel: 'publish' | 'queued publish';
}

/**
 * The protected and private members of the agent that the fixture instruments or calls, with the
 * signatures their owning classes declare. {@link internalsOf} is the one place the fixture steps
 * over the agent's access modifiers; everything else goes through the agent's public type.
 */
interface PlacementAgentInternalsV1 {
  readonly log: Pick<Logger, 'info' | 'warn'>;
  readonly rfc64PersistenceV1: { finalizedPrivatePlacementRepairs: Rfc64FinalizedPrivatePlacementRepairStoreV1 };
  resolveRfc64CatalogAuthoringLaneV1(
    contextGraphId: string,
    subGraphName: string | null | undefined,
  ): Readonly<{ acceptsFinalizedVmRepair: boolean }> | null;
  repairObservedRfc64FinalizedPrivateCatalogPlacementV1(
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
    placement: CatalogPlacementAttemptV1,
  ): Promise<'repaired' | 'already-complete'>;
  publishRfc64FinalizedPrivateCatalogPlacementV1(
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
    placement: CatalogPlacementAttemptV1,
  ): Promise<AppliedCatalogHeadSnapshotV1 | null>;
  requestObservedRfc64FinalizedPrivateCatalogPlacementRepairV1(
    params: Readonly<{ repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>; ctx: OperationContext }>,
    observer: CatalogPlacementWaiterObserverV1,
  ): Rfc64FinalizedPrivatePlacementRepairRequestV1;
  afterConfirmedGraphScopedVmPublishV1(input: ConfirmedVmPublishTailInputV1): Promise<void>;
}

function internalsOf(agent: DKGAgent): PlacementAgentInternalsV1 {
  return agent as unknown as PlacementAgentInternalsV1;
}

/**
 * An author whose confirmed private placements go through the real repair path. The agent's real
 * open-policy lane is made a finalized-private one, and the ordinary projection is kept from
 * placing the row first, so only the confirmed placement can.
 */
export async function startPlacementAgentV1(
  options: StartPlacementAgentOptionsV1,
): Promise<PlacementAgentV1> {
  const clock = { now: 0 };
  const counted = { repairs: 0, coverageChecks: 0, successors: 0, signatures: 0, announcements: 0 };
  const events: string[] = [];
  const requests: Rfc64FinalizedPrivatePlacementRepairRequestV1[] = [];
  const lane: PlacementAgentV1['lane'] = { acceptsFinalizedVmRepair: true };
  const failPlacements: Error[] = [];
  let placementGate: GateV1 | undefined;
  const hooks: Pick<PlacementAgentV1, 'failMarkerWrite' | 'afterMarkerStored'> = {
    failMarkerWrite: undefined,
    afterMarkerStored: undefined,
  };
  const agent = await startRepairAgentV1({
    name: options.name,
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.storePath === undefined ? {} : { storePath: options.storePath }),
    autoPublish: {
      peers: [],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    },
    beforeStart: async (starting) => {
      const internals = internalsOf(starting);
      vi.spyOn(starting, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
      vi.spyOn(starting, 'reconcileRfc64PublicCatalogFromSwmInventoryV1').mockResolvedValue(null);
      const realLane = internals.resolveRfc64CatalogAuthoringLaneV1.bind(starting);
      vi.spyOn(internals, 'resolveRfc64CatalogAuthoringLaneV1').mockImplementation(
        (contextGraphId, subGraphName) => {
          if (lane.unavailable !== undefined) throw lane.unavailable;
          const resolved = realLane(contextGraphId, subGraphName);
          return resolved === null
            ? null
            : { ...resolved, acceptsFinalizedVmRepair: lane.acceptsFinalizedVmRepair };
        },
      );
      installCatalogPlacementTimingV1(starting, new CatalogPlacementTimingV1({
        clock: () => clock.now,
        logThresholdMs: 0,
      }));
      const repair = internals.repairObservedRfc64FinalizedPrivateCatalogPlacementV1.bind(starting);
      vi.spyOn(internals, 'repairObservedRfc64FinalizedPrivateCatalogPlacementV1').mockImplementation(
        (marker, placement) => {
          counted.repairs += 1;
          return repair(marker, placement);
        },
      );
      const placePrivate = internals.publishRfc64FinalizedPrivateCatalogPlacementV1.bind(starting);
      vi.spyOn(internals, 'publishRfc64FinalizedPrivateCatalogPlacementV1').mockImplementation(
        async (marker, placement) => {
          const failure = failPlacements.shift();
          if (failure !== undefined) throw failure;
          return placePrivate(marker, placement);
        },
      );
      const coverage = starting.rfc64CatalogCoversConfirmedSwmRowV1.bind(starting);
      vi.spyOn(starting, 'rfc64CatalogCoversConfirmedSwmRowV1').mockImplementation(async (params) => {
        counted.coverageChecks += 1;
        const covered = await coverage(params);
        events.push(`coverage-proof:${params.expectedRow.assertionCoordinate}:${covered}`);
        return covered;
      });
      const successor = starting.publishAuthorCatalogExactSetSuccessorV1.bind(starting);
      vi.spyOn(starting, 'publishAuthorCatalogExactSetSuccessorV1').mockImplementation(async (params) => {
        counted.successors += 1;
        await placementGate?.pass();
        return successor(params);
      });
      const signer = starting.createRfc64CatalogAuthorSignerV1.bind(starting);
      vi.spyOn(starting, 'createRfc64CatalogAuthorSignerV1').mockImplementation((authorAddress, signal) => {
        const real = signer(authorAddress, signal);
        return Object.freeze({
          address: real.address,
          signMessage: (message: Uint8Array) => {
            counted.signatures += 1;
            return real.signMessage(message);
          },
        });
      });
      const announce = starting.announceRfc64PublicCatalogHeadV1.bind(starting);
      vi.spyOn(starting, 'announceRfc64PublicCatalogHeadV1').mockImplementation((input) => {
        counted.announcements += 1;
        return announce(input);
      });
      // The observer's own request: the one whose waiter is told about the attempt that releases it.
      const requestRepair = internals.requestObservedRfc64FinalizedPrivateCatalogPlacementRepairV1.bind(starting);
      vi.spyOn(internals, 'requestObservedRfc64FinalizedPrivateCatalogPlacementRepairV1').mockImplementation(
        (params, observer) => {
          const request = requestRepair(params, observer);
          requests.push(request);
          events.push(`placement-requested:${params.repair.assertionCoordinate}:${request.accepted ? 'accepted' : 'refused'}`);
          return request;
        },
      );
      await options.beforeStart?.(starting);
    },
  });
  agent.acceptOpenContextGraphPolicyV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: AUTHOR,
  });
  // The marker store is frozen, so the row watches it through the persistence that hands it out.
  const internals = internalsOf(agent);
  const persistence = internals.rfc64PersistenceV1;
  const markerStore = persistence.finalizedPrivatePlacementRepairs;
  const watchedMarkerStore: Rfc64FinalizedPrivatePlacementRepairStoreV1 = Object.freeze({
    list: () => markerStore.list(),
    put: async (repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>) => {
      if (hooks.failMarkerWrite !== undefined) throw hooks.failMarkerWrite;
      await markerStore.put(repair);
      events.push(`marker-stored:${repair.assertionCoordinate}`);
      hooks.afterMarkerStored?.();
    },
    delete: async (repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>) => {
      await markerStore.delete(repair);
      events.push(`marker-retired:${repair.assertionCoordinate}`);
    },
  });
  persistence.finalizedPrivatePlacementRepairs = watchedMarkerStore;
  const info = vi.spyOn(internals.log, 'info');
  const warn = vi.spyOn(internals.log, 'warn');
  return Object.assign(hooks, {
    agent,
    clock,
    lane,
    failPlacements,
    markers: () => markerStore.list(),
    catalogRows: () => agent.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigestV1(),
      authorAddress: AUTHOR,
    })?.inventoryRowCount ?? null,
    queue: () => agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.finalizedPrivatePlacement,
    counts: () => ({ ...counted }),
    holdPlacements: () => {
      placementGate = gateV1();
      return placementGate;
    },
    events: () => [...events],
    record: (event: string) => { events.push(event); },
    requests: () => [...requests],
    placementLines: () => info.mock.calls
      .map(([, message]) => String(message))
      .filter((message) => message.startsWith('rfc64_catalog_placement_wait ')),
    warnings: () => warn.mock.calls.map(([, message]) => String(message)),
  });
}

/** One asset with a durable workspace row and an author-inventory row, ready to be confirmed. */
export interface PlacementAssetV1 {
  readonly suffix: string;
  readonly kaNumber: bigint;
  readonly seal: AssertionSeal;
  readonly assertionCoordinate: string;
  readonly shareOperationId: string;
  readonly txHash: Hex;
}

export async function seedPlacementAssetV1(
  agent: DKGAgent,
  suffix: string,
  kaNumber: bigint,
): Promise<PlacementAssetV1> {
  const { seal } = await seedInventoryAssetV1(agent, suffix, kaNumber);
  await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
  return Object.freeze({
    suffix,
    kaNumber,
    seal,
    assertionCoordinate: `repair-${suffix}`,
    shareOperationId: `repair-operation-${suffix}`,
    txHash: `0x${kaNumber.toString(16).padStart(64, '0')}` as Hex,
  });
}

/** One call of the real post-confirmation observer for `asset`, as a completion path makes it. */
export function observeConfirmedV1(
  agent: DKGAgent,
  asset: PlacementAssetV1,
  publicationLabel: 'publish' | 'queued publish' = 'queued publish',
): Promise<void> {
  return agent.observeRfc64ConfirmedVmV1({
    contextGraphId: CONTEXT_GRAPH_ID,
    assertionCoordinate: asset.assertionCoordinate,
    shareOperationId: asset.shareOperationId,
    seal: asset.seal,
    assertionUri: `urn:placement-fixture:${asset.assertionCoordinate}`,
    ctx: createOperationContext('publishFromSWM', `job-${asset.suffix}`),
    publicationLabel,
  });
}

/**
 * The tail a synchronous publish of `asset` awaits before it answers: `publishFromFinalizedAssertion`
 * ends in this call and returns its result right after it.
 */
export function confirmedSynchronousPublishTailV1(agent: DKGAgent, asset: PlacementAssetV1): Promise<void> {
  return internalsOf(agent).afterConfirmedGraphScopedVmPublishV1({
    status: 'confirmed',
    contextGraphId: CONTEXT_GRAPH_ID,
    assertionCoordinate: asset.assertionCoordinate,
    shareOperationId: asset.shareOperationId,
    seal: asset.seal,
    assertionUri: `urn:placement-fixture:${asset.assertionCoordinate}`,
    ctx: createOperationContext('publishFromSWM', `publish-${asset.suffix}`),
    publicationLabel: 'publish',
  });
}

/**
 * The author re-opens `asset` for editing, through the agent's own pull-from: the publisher
 * verifies the shared content against the seal, archives that seal as the recovery commitment,
 * clears the active one and seeds the draft.
 */
export async function reopenForEditingV1(agent: DKGAgent, asset: PlacementAssetV1): Promise<void> {
  const vmGraph = knowledgeAssetLayerGraphUri(
    CONTEXT_GRAPH_ID,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(asset.seal.kaUal!, asset.seal.assertionVersion!),
  );
  await agent.store.insert(PROJECTION_QUADS.map((quad) => ({ ...quad, graph: vmGraph })));
  await agent.assertion.pullFrom(CONTEXT_GRAPH_ID, asset.assertionCoordinate, 'vm', { agentAddress: AUTHOR });
}

/** The queued request a share of `asset` enqueues: its immutable seal, as the queue persists it. */
export function queuedPublishRequestV1(asset: PlacementAssetV1): KnowledgeAssetVmPublishRequest {
  const seal = canonicalGraphScopedAuthorSealFromAssertionSealV1(asset.seal);
  return {
    contextGraphId: CONTEXT_GRAPH_ID,
    name: asset.assertionCoordinate,
    agentAddress: AUTHOR,
    shareOperationId: asset.shareOperationId,
    roots: [],
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: seal.kaUal,
    assertionVersion: seal.assertionVersion,
    publicTripleCount: Number(seal.publicTripleCount),
    privateTripleCount: Number(seal.privateTripleCount),
    seal: {
      merkleRoot: seal.assertionMerkleRoot as Hex,
      authorAddress: seal.authorAddress as Hex,
      signature: { r: seal.authorAttestationR as Hex, vs: seal.authorAttestationVS as Hex },
      schemeVersion: 1,
      reservedKaId: seal.reservedKaId as `${bigint}`,
    },
    sealChainId: seal.assertedAtChainId as `${bigint}`,
    sealKav10Address: seal.assertedAtKav10Address as Hex,
    sealFinalizedAtIso: seal.assertionFinalizedAt,
    sealMerkleRoot: seal.assertionMerkleRoot as Hex,
    intentKey: `sha256:${asset.kaNumber.toString(16).padStart(64, '0')}`,
    kaNumber: asset.kaNumber.toString(),
    reservedUal: seal.kaUal,
  };
}

function recoveryEvidenceV1(
  request: KnowledgeAssetVmPublishRequest,
  txHash: Hex,
): AsyncKnowledgeAssetVmPublishRecoveryEvidence {
  const reservedKaId = request.seal.reservedKaId as `${bigint}`;
  return {
    inclusion: { txHash, blockNumber: 77, blockHash: `0x${'cd'.repeat(32)}` as Hex },
    finalization: {
      mode: 'published',
      txHash,
      ual: request.kaUal!,
      batchId: reservedKaId,
      startKAId: reservedKaId,
      endKAId: reservedKaId,
      publisherAddress: AUTHOR as Hex,
    },
    publishProof: {
      merkleRoot: request.sealMerkleRoot,
      authorAddress: request.seal.authorAddress,
      txIndex: 4,
      merkleRootCount: '1',
    },
  };
}

/**
 * What the recovery finalizer's chain normalization answers for a publish that is the asset's
 * current version. The test file installs it in place of `normalizeRecoveredNamedKaPublish`,
 * which needs a chain adapter bound to the asset's chain.
 */
export function recoveredNamedKaPublishV1(input: {
  readonly request: KnowledgeAssetVmPublishRequest;
  readonly queued: { readonly txHash: string };
  readonly recovery: AsyncKnowledgeAssetVmPublishRecoveryEvidence;
}) {
  const { request, recovery } = input;
  const facts = {
    merkleRoot: request.sealMerkleRoot,
    authorAddress: request.seal.authorAddress,
    publisherAddress: recovery.finalization.publisherAddress!,
  };
  return {
    reservedKaId: BigInt(request.seal.reservedKaId!),
    localUal: request.kaUal!,
    txHash: input.queued.txHash,
    receiptBlockNumber: recovery.inclusion.blockNumber,
    transaction: { ...facts, blockHash: recovery.inclusion.blockHash!, txIndex: recovery.publishProof.txIndex },
    materialization: { ...facts, versionBlock: recovery.inclusion.blockNumber, superseded: false },
  };
}

export interface PublicationPathV1 {
  readonly publisher: TripleStoreAsyncLiftPublisher;
  /** Enqueue the publish of `asset`; resolves to its job id. */
  readonly enqueue: (asset: PlacementAssetV1) => Promise<string>;
  /**
   * Claim and run the oldest accepted job on `walletId` until its transaction is accepted; the
   * execution continues detached, as in a publisher runtime with chain-proof recovery.
   */
  readonly broadcast: (walletId: string) => Promise<PersistedLiftJob | null>;
  /**
   * Enqueue the publish of `asset` and leave it as a held failed job whose transaction is
   * recorded: the shape of a publish that landed on chain while the node recorded a failure.
   */
  readonly failAfterBroadcast: (asset: PlacementAssetV1) => Promise<string>;
  readonly job: (jobId: string) => Promise<PersistedLiftJob | null>;
  /** Milliseconds on the fixture clock between finality observed and the terminal record. */
  readonly postFinalityWaitMs: (jobId: string) => Promise<number | null>;
  /** What the recovery finalizer's VM materialization answers; `promoted` unless a row changes it. */
  materialization: ChainReconciledKCOutcome;
}

/**
 * The real async publisher over the agent's store. Its executor ends in the agent's real
 * post-confirmation tail and its recovery finalizer is the agent's real one.
 */
export function createPublicationPathV1(
  fixture: PlacementAgentV1,
  config: Partial<AsyncLiftPublisherConfig> = {},
): PublicationPathV1 {
  const { agent, clock } = fixture;
  const internals = internalsOf(agent);
  let ids = 0;
  const queued = new Map<string, { request: KnowledgeAssetVmPublishRequest; asset: PlacementAssetV1 }>();
  const byTxHash = (txHash: string) => {
    const found = queued.get(txHash.toLowerCase());
    if (found === undefined) throw new Error(`no queued publish for transaction ${txHash}`);
    return found;
  };
  const path: Pick<PublicationPathV1, 'materialization'> = { materialization: 'promoted' };
  vi.spyOn(agent, 'getContextGraphOnChainId').mockResolvedValue('1');
  // Recovery asks the agent's own finalization handler whether the VM content is there; only that
  // answer is staged.
  vi.spyOn(agent.getOrCreateFinalizationHandler(), 'handleChainReconciledKC').mockImplementation(async () => {
    fixture.record(`vm-materialization:${path.materialization}`);
    return path.materialization;
  });

  const publisher = new TripleStoreAsyncLiftPublisher(agent.store, {
    now: () => clock.now,
    idGenerator: () => `job-${++ids}`,
    detachReceiptReconciliation: true,
    chainProofResolver: async (lookup) => {
      const { request } = byTxHash(lookup.txHash);
      return { status: 'recovered', recovery: recoveryEvidenceV1(request, lookup.txHash as Hex) };
    },
    knowledgeAssetVmPublishRecoveryResolver: async (_job, lookup) => {
      const { request } = byTxHash(lookup.txHash);
      fixture.record(`finality-observed:${request.name}`);
      return recoveryEvidenceV1(request, lookup.txHash as Hex);
    },
    ...config,
    knowledgeAssetVmPublishHandler: {
      execute: async (input): Promise<PublishResult> => {
        const { request } = input;
        if (!isGraphScopedKnowledgeAssetVmPublishRequest(request)) {
          throw new Error(`expected a graph-scoped queued publish for ${request.name}`);
        }
        const { asset } = [...queued.values()].find((entry) => entry.request.name === request.name)!;
        await input.publishOptions.onBeforeBroadcast?.({ txHash: asset.txHash, operationKind: 'create' });
        await input.publishOptions.onBroadcastAccepted?.({ txHash: asset.txHash, operationKind: 'create' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        input.publishOptions.onPublishConfirmed?.({ txHash: asset.txHash });
        // The last thing the agent's queued executor does once the publisher reports `confirmed`,
        // with the seal it rebuilds from the queued request.
        const seal = assertionSealFromQueuedKnowledgeAssetVmPublishRequest(request);
        try {
          await internals.afterConfirmedGraphScopedVmPublishV1({
            status: 'confirmed',
            contextGraphId: request.contextGraphId,
            subGraphName: request.subGraphName,
            assertionCoordinate: request.name,
            shareOperationId: request.shareOperationId,
            seal,
            assertionUri: `urn:placement-fixture:${request.name}`,
            ctx: input.publishOptions.operationCtx ?? createOperationContext('publishFromSWM'),
            publicationLabel: 'queued publish',
          });
        } catch (cause) {
          // The publisher swallows what a detached execution rejects with; the row must not.
          fixture.record(`executor-failed:${request.name}:${cause instanceof Error ? cause.message : String(cause)}`);
          throw cause;
        }
        fixture.record(`executor-settled:${request.name}`);
        // The publisher drops the result of a detached execution; recovery owns the record.
        return {
          kaId: asset.kaNumber,
          ual: request.kaUal,
          merkleRoot: seal.merkleRoot,
          kaManifest: [],
          status: 'confirmed',
        };
      },
      finalizeRecovered: async (input) => {
        await agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish(input);
        fixture.record(`recovery-finalized:${input.request.name}`);
      },
    },
  });

  const enqueue = async (asset: PlacementAssetV1): Promise<string> => {
    const request = queuedPublishRequestV1(asset);
    queued.set(asset.txHash.toLowerCase(), { request, asset });
    return publisher.enqueueKnowledgeAssetVmPublish(request);
  };
  return Object.assign(path, {
    publisher,
    enqueue,
    broadcast: (walletId: string) => publisher.processNext(walletId),
    failAfterBroadcast: async (asset: PlacementAssetV1) => {
      const jobId = await enqueue(asset);
      const walletId = `wallet-held-${jobId}`;
      await publisher.claimNext(walletId);
      await publisher.update(jobId, 'validated', {
        validation: {
          canonicalRoots: [],
          canonicalRootMap: {},
          swmQuadCount: 2,
          authorityProofRef: 'knowledge-asset-lifecycle',
          transitionType: 'CREATE',
        },
      });
      await publisher.update(jobId, 'broadcast', {
        broadcast: { txHash: asset.txHash, walletId, operationKind: 'create' },
      });
      const failed = await publisher.recordPublishFailure(jobId, {
        error: new Error('RPC endpoint temporarily unavailable'),
        failedFromState: 'broadcast',
        errorPayloadRef: `urn:dkg:test:error:${jobId}`,
      });
      if (failed.status !== 'failed') throw new Error(`expected a held failed job, got ${failed.status}`);
      return jobId;
    },
    job: (jobId: string) => publisher.getStatus(jobId),
    postFinalityWaitMs: async (jobId: string) => {
      const job = await publisher.getStatus(jobId);
      const finalizedAt = job?.timestamps.finalizedAt;
      const finalityObservedAt = job?.timestamps.finalityObservedAt;
      return finalizedAt === undefined || finalityObservedAt === undefined
        ? null
        : finalizedAt - finalityObservedAt;
    },
  });
}

/**
 * Run the publisher's reconciliation pass after pass, as its runner does while jobs are live, and
 * let one parked placement go per `placementMs` of fixture time whenever nothing else can move.
 * Returns once every job is terminal. The placements still parked then stay parked.
 */
export async function drivePublicationsV1(input: {
  readonly fixture: PlacementAgentV1;
  readonly path: PublicationPathV1;
  readonly parked: GateV1;
  readonly jobIds: readonly string[];
  readonly placementMs: number;
}): Promise<void> {
  const { fixture, path, parked, jobIds, placementMs } = input;
  const finalized = async (): Promise<boolean> => {
    for (const jobId of jobIds) {
      if ((await path.job(jobId))?.status !== 'finalized') return false;
    }
    return true;
  };
  let stop = false;
  let passStartedAt: number | undefined;
  let idlePasses = 0;
  const reconciling = (async () => {
    while (!stop) {
      passStartedAt = performance.now();
      const reconciled = await path.publisher.recover();
      passStartedAt = undefined;
      idlePasses = reconciled === 0 ? idlePasses + 1 : 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })();
  try {
    while (!(await finalized())) {
      // Nothing moves any more: a pass is stuck behind a placement, or passes settle nothing.
      await untilV1(
        () => idlePasses >= 3 || (passStartedAt !== undefined && performance.now() - passStartedAt > 250),
        'the reconciliation loop stalls or idles',
      );
      if (await finalized()) break;
      if (parked.parked() === 0) {
        // The next placement has not reached the point where it parks yet. Give it real turns: a
        // loop of store reads alone settles in microtasks and would starve the timers it needs.
        idlePasses = 0;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        continue;
      }
      fixture.clock.now += placementMs;
      parked.releaseNext();
      idlePasses = 0;
    }
  } finally {
    stop = true;
    // A row that gave up leaves no pass stuck behind a placement nobody will let go.
    if (!(await finalized().catch(() => false))) parked.release();
    await reconciling;
  }
}
