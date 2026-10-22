// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import type { ChainAdapter, OnChainPublishResult } from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  buildAssertionPublishReceiptQuads,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  parseAssertionSealQuads,
  type AssertionSeal,
} from '@origintrail-official/dkg-core';
import { adoptExistingMint, assertionLifecycleWriteLockKey, withKeyedLocks } from '@origintrail-official/dkg-publisher';
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
  readonly chain: ChainAdapter;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly stampPublishedLifecycle: PublishedNamedKaVmLifecycleWriter;
}

interface Target {
  contextGraphId: string;
  name: string;
  subGraphName?: string;
  agentAddress: string;
  txHash?: string;
}

interface SealedReservation {
  seal: AssertionSeal & { publicTripleCount: number };
  scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  kaId: bigint;
  assertionUri: string;
  metaGraph: string;
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
 * the synchronous publish path records the mint in adopt-only mode and
 * consumes the share. Once a publish has consumed the share and finished its
 * post-publish steps, only the lifecycle is left, and it is completed from
 * the verified VM record. A share consumed by a publish that stopped before
 * its finalization gossip and catalog transition refuses: those cannot be
 * finished from the VM record alone. Either way the reconcile succeeds only
 * once the lifecycle names the sealed root and the asset's UAL as published,
 * so an interrupted attempt is resumed by retrying.
 */
export async function reconcileLateMint(
  agent: DKGAgent,
  host: KnowledgeAssetMintReconcileHost,
  input: KnowledgeAssetMintReconcileInput,
): Promise<KnowledgeAssetMintReconcileResult> {
  const { contextGraphId, name, subGraphName } = input;
  const agentAddress = await agent.resolveFinalizedAssertionPublishAuthor(contextGraphId, name, { subGraphName });
  const target: Target = { contextGraphId, name, subGraphName, agentAddress, txHash: input.txHash };
  const reservation = await readSealedReservation(agent, target);
  const { ual } = reservation.scope;
  // Chain evidence only means something for the chain the reservation names.
  if (reservation.scope.chainId !== host.chain.chainId) {
    throw refused(`The UAL ${ual} of "${name}" belongs to chain ${reservation.scope.chainId}, not ${host.chain.chainId}.`);
  }
  const chainTargetMismatch = await sealChainTargetMismatch(host.chain, reservation.seal);
  if (chainTargetMismatch) throw refused(`Cannot record "${name}": ${chainTargetMismatch}`);
  const sealRoot = bareRoot(ethers.hexlify(reservation.seal.merkleRoot));
  const lifecycle = () => agent.assertion.history(contextGraphId, name, { agentAddress, subGraphName });

  const before = await lifecycle();
  if (isRecorded(before, sealRoot, ual)) return { status: 'already-published', ual };
  const vmPointer = before?.vmCurrentAssertion === undefined ? undefined : bareRoot(before.vmCurrentAssertion);
  if (vmPointer !== undefined && vmPointer !== sealRoot) {
    throw refused(`The lifecycle of "${name}" already records VM version ${vmPointer}, not the sealed ${sealRoot}.`);
  }
  // A VM pointer means an earlier attempt recorded the mint, consumed the share
  // and passed its finalization gossip; publishing again would plan an update.
  const share = vmPointer === undefined ? await shareState(agent, reservation, target) : 'consumed';
  if (share === 'interrupted') {
    throw refused(
      `An interrupted publish consumed the share of "${name}" before its finalization gossip and catalog transition. ` +
        'Reconcile cannot finish those from the VM record alone, so it leaves the asset unrecorded.',
    );
  }
  const mint = share === 'resident'
    ? await recordThroughPublish(agent, target)
    : await completeRecordedLifecycle(agent, host, reservation, target);

  const after = await lifecycle();
  if (!isRecorded(after, sealRoot, ual)) {
    throw Object.assign(new Error(
      `The mint of "${name}" was verified but its lifecycle is not complete ` +
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

async function readSealedReservation(agent: DKGAgent, target: Target): Promise<SealedReservation> {
  const assertionUri = contextGraphAssertionUri(target.contextGraphId, target.agentAddress, target.name, target.subGraphName);
  const metaGraph = contextGraphMetaUri(target.contextGraphId);
  const meta = await agent.store.query(
    `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`,
    { source: 'agent.reconcileLateMint.seal' },
  );
  const seal = parseAssertionSealQuads(meta.type === 'quads' ? meta.quads : [], assertionUri);
  if (!seal || seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION || seal.kaUal === undefined
    || seal.assertionVersion === undefined || seal.publicTripleCount === undefined) {
    throw refused(`"${target.name}" in context graph "${target.contextGraphId}" is not finalized as a graph-scoped asset.`);
  }
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  const kaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
  if (seal.reservedKaId !== undefined && seal.reservedKaId !== kaId) {
    throw refused(`The seal of "${target.name}" reserves KA ${seal.reservedKaId}, not its UAL's ${kaId}.`);
  }
  return { seal: { ...seal, publicTripleCount: seal.publicTripleCount }, scope, kaId, assertionUri, metaGraph };
}

/**
 * Where the complete share a publish consumes stands: still `resident`;
 * `consumed` by a publish that went on to clear the share marker, which it
 * does only after its finalization gossip; or `interrupted`, consumed while
 * the marker stayed set because that publish stopped before those steps.
 */
async function shareState(
  agent: DKGAgent,
  { seal, scope }: SealedReservation,
  target: Target,
): Promise<'resident' | 'consumed' | 'interrupted'> {
  if (!(await agent.publisher.hasSwmShareComplete(target.contextGraphId, target.name, target.agentAddress, target.subGraphName))) {
    return 'consumed';
  }
  if (seal.publicTripleCount === 0) return 'resident';
  const shared = await agent._loadSelectedSWMQuads(target.contextGraphId, 'all', target.subGraphName, {
    kind: 'named-lifecycle',
    identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) },
  });
  return shared.length > 0 ? 'resident' : 'interrupted';
}

async function recordThroughPublish(agent: DKGAgent, target: Target): Promise<OnChainPublishResult> {
  const published = await agent.publishFromFinalizedAssertion(target.contextGraphId, target.name, {
    subGraphName: target.subGraphName,
    agentAddress: target.agentAddress,
    adoptExistingMint: target.txHash === undefined ? {} : { txHash: target.txHash },
  });
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
 * adoption. The receipt is written before the lifecycle is stamped, because
 * the stamp is what makes later attempts report the asset published.
 */
async function completeRecordedLifecycle(
  agent: DKGAgent,
  host: KnowledgeAssetMintReconcileHost,
  { seal, scope, kaId, assertionUri, metaGraph }: SealedReservation,
  target: Target,
): Promise<OnChainPublishResult> {
  const onChainContextGraphId = await agent.getContextGraphOnChainId(target.contextGraphId);
  if (!onChainContextGraphId || !/^\d+$/.test(onChainContextGraphId)) {
    throw refused(`Context graph "${target.contextGraphId}" has no on-chain id.`);
  }
  const lock = assertionLifecycleWriteLockKey(target.contextGraphId, target.name, target.agentAddress, target.subGraphName);
  return withKeyedLocks(host.writeLocks, [lock], async () => {
    const record = await resolveConfirmedGraphScopedVm(agent.store, {
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
    const mint = await adoptExistingMint(host.chain, {
      kaId,
      merkleRoot: seal.merkleRoot,
      contextGraphId: BigInt(onChainContextGraphId),
      authorAddress: seal.authorAddress,
    }, { txHash: target.txHash });
    if (envelope.transactionHash !== undefined && envelope.transactionHash.toLowerCase() !== mint.txHash.toLowerCase()) {
      throw refused(`The local record of "${target.name}" names transaction ${envelope.transactionHash}, not the mint ${mint.txHash}.`);
    }
    await agent.store.insert(buildAssertionPublishReceiptQuads({
      assertionUri, metaGraph, txHash: mint.txHash, blockNumber: BigInt(mint.blockNumber),
    }));
    await host.stampPublishedLifecycle({
      contextGraphId: target.contextGraphId,
      agentAddress: target.agentAddress,
      name: target.name,
      subGraphName: target.subGraphName,
      publishedUal: scope.ual,
      merkleRoot: ethers.hexlify(seal.merkleRoot),
      packedKaId: kaId,
    });
    return mint;
  });
}
