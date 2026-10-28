import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { DKGPublisher } from '@origintrail-official/dkg-publisher';
import type { CompleteNamedPublishFinalization } from './named-publish-finalization.js';
import type { FinalizedAssertionRecordingContext } from './internal/agent-publish-options.js';
import { readFinalizedAssertionReservation, FinalizedAssertionReservationError, type FinalizedAssertionReservation as SealedReservation } from './internal/finalized-assertion-reservation.js';
import { readNamedPublishFinalization } from './named-publish-finalization.js';
// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import type { ChainAdapter, OnChainPublishResult } from '@origintrail-official/dkg-chain';
import {
  ASSERTION_PUBLISH_RECEIPT_PREDICATES,
  LegacyKnowledgeAssetReadOnlyError,
  buildAssertionPublishReceiptQuads,
} from '@origintrail-official/dkg-core';
import {
  withMaterializationLock,
  readPreparedMintAdoption,
  prepareMintAdoption,
  withAssertionLifecycleWriteLease,
  assertionLifecycleWriteLockKey,
  graphScopeTargetsChain,
  type PreparedMintAdoption,
  type PublishResult,
  type AssertionLifecycleWriteLease,
} from '@origintrail-official/dkg-publisher';
import type { AssertionHistoryDescriptor, DKGAgent } from './dkg-agent.js';
import { resolveConfirmedGraphScopedVm } from './confirmed-graph-scoped-vm-resolver.js';
import type { PublishedNamedKaVmLifecycleWriter } from './named-ka-vm-lifecycle.js';
import { sealChainTargetMismatch } from './seal-chain-target.js';

/** The mint was recorded but the lifecycle did not complete; retrying resumes it. */
export const KA_MINT_RECONCILE_INCOMPLETE_CODE = 'KA_MINT_RECONCILE_INCOMPLETE';
/** This node's state cannot complete the reconcile; retrying does not change that. */
export const KA_MINT_RECONCILE_REFUSED_CODE = 'KA_MINT_RECONCILE_REFUSED';

export interface KnowledgeAssetMintReconcileInput {
  contextGraphId: string;
  name: string;
  subGraphName?: string;
  /** Hint: the transaction believed to have minted the asset. */
  txHash?: string;
  /** Which resident author's asset to record when several authors use this name. */
  selectedAuthorAgentAddress?: string;
}

export type KnowledgeAssetMintReconcileResult =
  | { status: 'already-published'; ual: string }
  | {
    status: 'adopted';
    ual: string;
    kaId: string;
    txHash: string;
    blockNumber: number;
    tokenAmount?: string;
  };

/** The agent internals reconcile writes through. */
export interface KnowledgeAssetMintReconcileHost {
  readonly store: TripleStore;
  readonly resolveAuthor: OmitThisParameter<DKGAgent['resolveFinalizedAssertionPublishAuthor']>;
  readonly history: DKGAgent['assertion']['history'];
  readonly getContextGraphOnChainId: OmitThisParameter<DKGAgent['getContextGraphOnChainId']>;
  readonly loadSelectedSwmQuads: OmitThisParameter<DKGAgent['_loadSelectedSWMQuads']>;
  readonly hasSwmShareComplete: DKGPublisher['hasSwmShareComplete'];
  readonly clearSwmShareComplete: DKGPublisher['clearSwmShareComplete'];
  readonly chain: ChainAdapter;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly stampPublishedLifecycle: PublishedNamedKaVmLifecycleWriter;
  readonly completeFinalization: CompleteNamedPublishFinalization;
  recordMint(target: Target, evidence: PreparedMintAdoption, recording: FinalizedAssertionRecordingContext): Promise<PublishResult>;
}

interface Target {
  contextGraphId: string;
  name: string;
  subGraphName?: string;
  agentAddress: string;
  txHash?: string;
}

const bareRoot = (root: string) => root.toLowerCase().replace(/^0x/, '');

const refused = (message: string) => Object.assign(new Error(message), { code: KA_MINT_RECONCILE_REFUSED_CODE });

/** Recorded means the lifecycle names the sealed root as its VM version and the asset's UAL as published, not a derived status. */
function isRecorded(lifecycle: AssertionHistoryDescriptor | null | undefined, sealRoot: string, ual: string): boolean {
  return lifecycle?.vmCurrentAssertion !== undefined && bareRoot(lifecycle.vmCurrentAssertion) === sealRoot
    && lifecycle.publishedUal === ual;
}

/**
 * Record one named asset whose publish transaction mined after the node
 * stopped waiting for it, so it stays `swm-shared` and every `vm/publish`
 * retry reverts `KaIdAlreadyMinted`.
 *
 * The seal and its UAL must name the chain and deployment this node points
 * at. The seal's reserved id is looked up on that chain and its mint verified
 * against the seal, including that no update has superseded it. No transaction, ACK
 * request or member ciphertext is sent. While the share is still resident,
 * the dedicated recording operation verifies the mint and
 * consumes the share. A publish-owned checkpoint proves that content recording,
 * content cleanup and finalization gossip completed; its retained catalog obligation
 * must then transfer to a durable owner before the lifecycle can be terminal.
 * Without a checkpoint, a consumed share is ambiguous and refuses, VM pointer
 * or marker absence notwithstanding: a queued publish stamps that pointer
 * before gossip, and a promote retry may then clear the marker. Retrying resumes the explicit checkpoint without
 * sending another mint.
 */
export async function reconcileLateMint(
  host: KnowledgeAssetMintReconcileHost,
  input: KnowledgeAssetMintReconcileInput,
): Promise<KnowledgeAssetMintReconcileResult> {
  const { contextGraphId, name, subGraphName } = input;
  const agentAddress = await host.resolveAuthor(contextGraphId, name, {
    subGraphName,
    ...(input.selectedAuthorAgentAddress === undefined ? {} : { selectedAuthorAgentAddress: input.selectedAuthorAgentAddress }),
  });
  const target: Target = { contextGraphId, name, subGraphName, agentAddress, txHash: input.txHash };
  const reservation = await readSealedReservation(host, target);
  const { ual } = reservation.scope;
  // Chain evidence only means something for the chain the reservation names,
  // compared as the publish path compares it (exact label or EIP-155 alias).
  const evmChainId = typeof host.chain.getEvmChainId === 'function' ? await host.chain.getEvmChainId() : undefined;
  if (!graphScopeTargetsChain(reservation.scope.chainId, host.chain.chainId, evmChainId)) {
    throw refused(`The UAL ${ual} of "${name}" belongs to chain ${reservation.scope.chainId}, not ${host.chain.chainId}.`);
  }
  const chainTargetMismatch = await sealChainTargetMismatch(host.chain, reservation.seal);
  if (chainTargetMismatch) throw refused(`Cannot record "${name}": ${chainTargetMismatch}`);
  const sealRoot = bareRoot(ethers.hexlify(reservation.seal.merkleRoot));
  const lifecycle = () => host.history(contextGraphId, name, { agentAddress, subGraphName });
  // A minted version is complete only with its publish receipt; the publish
  // path writes that receipt best-effort, so a missing one is completed here.
  const complete = async (state: AssertionHistoryDescriptor | null | undefined) => isRecorded(state, sealRoot, ual)
    && (BigInt(reservation.scope.assertionVersion) !== 1n || await hasPublishReceipt(host, reservation))
    && (await readNamedPublishFinalization(host.store, reservation)).kind === 'complete'
    && !(await host.hasSwmShareComplete(contextGraphId, name, agentAddress, subGraphName));

  const before = await lifecycle();
  if (await complete(before)) return { status: 'already-published', ual };
  const vmPointer = before?.vmCurrentAssertion === undefined ? undefined : bareRoot(before.vmCurrentAssertion);
  if (vmPointer !== undefined && vmPointer !== sealRoot) {
    throw refused(`The lifecycle of "${name}" already records VM version ${vmPointer}, not the sealed ${sealRoot}.`);
  }
  const readableShare = async (current: AssertionHistoryDescriptor | null | undefined) => {
    // A promote retry can clear the marker after checking VM content without
    // sending finalization. Only a publish-owned checkpoint certifies that step.
    const progress = await readNamedPublishFinalization(host.store, reservation);
    const share = progress.kind !== 'legacy'
      ? 'consumed' : await shareState(host, reservation, target, current?.vmCurrentAssertion !== undefined);
    if (share === 'interrupted') {
      throw refused(`An interrupted publish consumed the share of "${name}", or its VM lifecycle was already stamped, ` +
        'but no publish-owned checkpoint proves its finalization gossip completed. A cleared share marker ' +
        'does not prove completion; reconcile changes nothing.');
    }
    return share;
  };
  // Refuse an already interrupted local publish before any chain lookup, then
  // recheck under the lease after evidence preparation to cover concurrent changes.
  await readableShare(before);
  const onChainId = await host.getContextGraphOnChainId(contextGraphId);
  if (!onChainId || !/^\d+$/.test(onChainId)) throw refused(`Context graph "${contextGraphId}" has no on-chain id.`);
  const expected = { kaId: reservation.kaId, merkleRoot: reservation.seal.merkleRoot,
    contextGraphId: BigInt(onChainId), authorAddress: reservation.seal.authorAddress };
  // Slow evidence preparation is outside the lease; each body revalidates it inside.
  const evidence = await prepareMintAdoption(host.chain, expected, target.txHash);
  const lock = assertionLifecycleWriteLockKey(contextGraphId, name, agentAddress, subGraphName);
  const mint = await withAssertionLifecycleWriteLease(host.writeLocks, lock, async heldLifecycle => {
    const lockedReservation = await assertReservationUnchanged(host, reservation, target);
    const current = await lifecycle();
    const share = await readableShare(current);
    return share === 'resident'
      ? recordThroughPublish(host, target, evidence, heldLifecycle, lockedReservation)
      : withMaterializationLock(lockedReservation.metaGraph, lockedReservation.scope.ual, async () =>
        completeRecordedLifecycle(host, lockedReservation, target,
          await readPreparedMintAdoption(evidence, host.chain, expected), heldLifecycle));
  });

  const after = await lifecycle();
  if (!(await complete(after))) {
    throw Object.assign(new Error(
      `The mint of "${name}" was verified but its lifecycle or publish receipt is not complete ` +
        `(VM version ${after?.vmCurrentAssertion ?? 'none'}, publishedUal ${after?.publishedUal ?? 'none'}, ` +
        `expected ${sealRoot} and ${ual}). Retry the reconcile.`,
    ), { code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
  }
  return {
    status: 'adopted',
    ual,
    kaId: String(mint.kaId ?? mint.batchId),
    txHash: mint.txHash,
    blockNumber: mint.blockNumber,
    ...(mint.tokenAmount === undefined ? {} : { tokenAmount: mint.tokenAmount.toString() }),
  };
}

async function readSealedReservation(host: KnowledgeAssetMintReconcileHost, target: Target): Promise<SealedReservation> {
  try { return await readFinalizedAssertionReservation(host.store, target, 'agent.reconcileLateMint.seal'); }
  catch (error) {
    if (error instanceof FinalizedAssertionReservationError || error instanceof LegacyKnowledgeAssetReadOnlyError)
      throw refused(error.message);
    throw error;
  }
}

/** The publish receipt (transaction and block) a confirmed mint leaves on the assertion. */
async function hasPublishReceipt(host: KnowledgeAssetMintReconcileHost, { assertionUri, metaGraph }: SealedReservation): Promise<boolean> {
  const result = await host.store.query(
    `ASK { GRAPH <${metaGraph}> { <${assertionUri}> <${ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_TX}> ?tx } }`,
    { source: 'agent.reconcileLateMint.receipt' },
  );
  return result.type === 'boolean' && result.value;
}

/** A resident share is safe to record; all other legacy states require positive finalization evidence. */
async function shareState(
  host: KnowledgeAssetMintReconcileHost,
  { seal, scope }: SealedReservation,
  target: Target,
  vmStamped: boolean,
): Promise<'resident' | 'interrupted'> {
  if (!(await host.hasSwmShareComplete(target.contextGraphId, target.name, target.agentAddress, target.subGraphName))) {
    return 'interrupted';
  }
  if (vmStamped) return 'interrupted';
  if (seal.publicTripleCount === 0) return 'resident';
  const shared = await host.loadSelectedSwmQuads(target.contextGraphId, 'all', target.subGraphName, {
    kind: 'named-lifecycle',
    identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) },
  });
  return shared.length > 0 ? 'resident' : 'interrupted';
}

/** Under the lifecycle write lock: the seal and lifecycle still describe the reservation reconcile verified. */
async function assertReservationUnchanged(
  host: KnowledgeAssetMintReconcileHost,
  { seal, scope }: Pick<SealedReservation, 'seal' | 'scope'>,
  target: Target,
): Promise<SealedReservation> {
  let current: SealedReservation;
  try {
    current = await readSealedReservation(host, target);
  } catch (error) {
    if ((error as { code?: string }).code !== KA_MINT_RECONCILE_REFUSED_CODE) throw error;
    throw refused(`The seal of "${target.name}" was removed while reconcile waited, for example by pull-from; nothing was written.`);
  }
  const sealRoot = bareRoot(ethers.hexlify(seal.merkleRoot));
  if (current.scope.ual !== scope.ual || current.scope.assertionVersion !== scope.assertionVersion
    || bareRoot(ethers.hexlify(current.seal.merkleRoot)) !== sealRoot) {
    throw refused(`The seal of "${target.name}" changed while reconcile waited; nothing was written.`);
  }
  const lifecycle = await host.history(target.contextGraphId, target.name, {
    agentAddress: target.agentAddress,
    subGraphName: target.subGraphName,
  });
  for (const pointer of [lifecycle?.vmCurrentAssertion, lifecycle?.wmCurrentAssertion, lifecycle?.swmCurrentAssertion]) {
    if (pointer !== undefined && bareRoot(pointer) !== sealRoot) {
      throw refused(`The lifecycle of "${target.name}" changed while reconcile waited; nothing was written.`);
    }
  }
  return current;
}

async function recordThroughPublish(host: KnowledgeAssetMintReconcileHost, target: Target,
  evidence: PreparedMintAdoption, heldLifecycle: AssertionLifecycleWriteLease, reservation: SealedReservation): Promise<OnChainPublishResult> {
  const published = await host.recordMint(target, evidence, { heldLifecycle, reservation });
  if (published.status !== 'confirmed' || !published.onChainResult) {
    throw Object.assign(new Error(`Recording the mint of "${target.name}" ended ${published.status}. Retry the reconcile.`), {
      code: KA_MINT_RECONCILE_INCOMPLETE_CODE,
    });
  }
  return published.onChainResult;
}

/**
 * Complete the lifecycle of a mint whose VM content an earlier attempt
 * already recorded, without the consumed share. The local record must verify
 * against the sealed root, and the mint must pass the same checks as
 * adoption, revalidated after acquiring the shared materialization lock. The caller
 * holds that lock through receipt, finalization and lifecycle completion so an
 * UpdateHandler or publisher cannot replace the verified VM record mid-flight. The receipt is written
 * before the lifecycle is stamped, because the stamp is what makes later
 * attempts report the asset published.
 */
async function completeRecordedLifecycle(
  host: KnowledgeAssetMintReconcileHost,
  { seal, scope, kaId, assertionUri, metaGraph }: SealedReservation,
  target: Target,
  mint: OnChainPublishResult,
  heldLifecycle: AssertionLifecycleWriteLease,
): Promise<OnChainPublishResult> {
  const record = await resolveConfirmedGraphScopedVm(host.store, {
    contextGraphId: target.contextGraphId,
    ual: scope.ual,
    assertionVersion: BigInt(scope.assertionVersion),
    merkleRoot: seal.merkleRoot,
    kaId,
    batchId: kaId,
    subGraphName: target.subGraphName,
  });
  const envelope = record.status === 'verified' ? record.envelope : undefined;
  if (!envelope || envelope.publicTripleCount !== seal.publicTripleCount
    || envelope.privateTripleCount !== (seal.privateTripleCount ?? 0)) {
    throw refused(
      `The share of "${target.name}" is no longer resident and this node holds no verified record of the sealed content ` +
        `(${record.status === 'invalid' ? record.reason : record.status}), so there is nothing to complete.`,
    );
  }
  if (envelope.transactionHash !== undefined && envelope.transactionHash.toLowerCase() !== mint.txHash.toLowerCase()) {
    throw refused(`The local record of "${target.name}" names transaction ${envelope.transactionHash}, not the mint ${mint.txHash}.`);
  }
  await host.store.insert(buildAssertionPublishReceiptQuads({
    assertionUri, metaGraph, txHash: mint.txHash, blockNumber: BigInt(mint.blockNumber),
  }));
  const finalization = await host.completeFinalization({
    contextGraphId: target.contextGraphId, subGraphName: target.subGraphName,
    assertionCoordinate: target.name, seal, assertionUri,
  });
  if (finalization === 'pending') throw Object.assign(new Error('Named publish catalog finalization remains pending; retry to finish it'),
    { code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
  await host.stampPublishedLifecycle({
    contextGraphId: target.contextGraphId,
    agentAddress: target.agentAddress,
    name: target.name,
    subGraphName: target.subGraphName,
    publishedUal: scope.ual,
    merkleRoot: ethers.hexlify(seal.merkleRoot),
    packedKaId: kaId,
  });
  await host.clearSwmShareComplete(target.contextGraphId, target.name, target.agentAddress, target.subGraphName, heldLifecycle);
  return mint;
}
