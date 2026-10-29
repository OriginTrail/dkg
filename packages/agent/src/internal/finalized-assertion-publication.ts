// SPDX-License-Identifier: Apache-2.0
import { assertConfirmedCatalogSealAdmissionV1 } from './confirmed-catalog-obligation.js';
import { ConfirmedCatalogObligationErrorV1, observeConfirmedPublicationWithRecoveryV1 } from '../confirmed-catalog-obligation-error.js';
import { completeNamedPublishFinalization } from './complete-named-publish-finalization.js';
import { completeNamedMint } from './named-mint-completion.js';
import { ethers } from 'ethers';
import { contextGraphAssertionUri, contextGraphMetaUri, assertionLifecycleUri,
  GRAPH_KA_CONTENT_SCOPE_VERSION, createOperationContext,
  type Logger, type OperationContext } from '@origintrail-official/dkg-core';
import { GraphManager, PrivateContentStore, type SharedMemoryGraphScope, type TripleStore } from '@origintrail-official/dkg-storage';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { assertAssertionLifecycleWriteLease, assertionLifecycleWriteLockKey, resolveKnowledgeAssetWorkspaceHead,
  skolemizeKnowledgeAssetParts, computePrivateRootV10 as computePrivateRoot, computeFlatKCRootV10 as computeFlatKCRoot,
  KA_ID_PRED, VM_CURRENT_ASSERTION_PRED, WM_CURRENT_ASSERTION_PRED,
  type DKGPublisher, type PublishResult, type SharedMemoryMintRecordingOptions } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from '../dkg-agent.js';
import { readFinalizedAssertionReservation } from './finalized-assertion-reservation.js';
import { planKnowledgeAssetVmPublication } from './knowledge-asset-vm-publish-request.js';
import { sealChainTargetMismatch } from '../seal-chain-target.js';
import { beginNamedPublishFinalization } from '../named-publish-finalization.js';
import type { AgentSharedMemoryPublishOptions, FinalizedAssertionPublishOptions, FinalizedAssertionRecordingContext } from './agent-publish-options.js';

/** Selection never constructs execution capabilities for either operation. */
export interface FinalizedAssertionSelectionHost {
  readonly store: TripleStore;
  readonly publisher: DKGPublisher;
  readonly chain: ChainAdapter;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly admitConfirmedCatalogPublicationV1: OmitThisParameter<DKGAgent['admitConfirmedCatalogPublicationV1']>;
  readonly resolveFinalizedAssertionPublishAuthor: OmitThisParameter<DKGAgent['resolveFinalizedAssertionPublishAuthor']>;
}
interface FinalizedAssertionLifecycleHost {
  readonly log: Logger;
  readonly publishedNamedKaVmLifecycleWriter: DKGAgent['publishedNamedKaVmLifecycleWriter'];
}
export interface FinalizedAssertionMintHost extends FinalizedAssertionLifecycleHost {
  readonly store: TripleStore;
  readonly observeRfc64ConfirmedVmV1: OmitThisParameter<DKGAgent['observeRfc64ConfirmedVmV1']>;
  readonly transferRfc64ConfirmedVmV1: OmitThisParameter<DKGAgent['transferRfc64ConfirmedVmV1']>;
  catalogRequired(contextGraphId: string, subGraphName?: string): boolean;
}
export interface FinalizedAssertionUpdateContentHost {
  readonly store: TripleStore;
  readonly _loadSelectedSWMQuads: OmitThisParameter<DKGAgent['_loadSelectedSWMQuads']>;
}
export interface FinalizedAssertionUpdateHost extends FinalizedAssertionLifecycleHost, FinalizedAssertionUpdateContentHost {
  readonly _buildPrecomputedUpdateAttestationForSeal: OmitThisParameter<DKGAgent['_buildPrecomputedUpdateAttestationForSeal']>;
  readonly update: OmitThisParameter<DKGAgent['update']>;
  readonly _stampPointerIfDivergedFromVm: OmitThisParameter<DKGAgent['_stampPointerIfDivergedFromVm']>;
  readonly observeRfc64ConfirmedVmV1: OmitThisParameter<DKGAgent['observeRfc64ConfirmedVmV1']>;
  retireLegacySwm(contextGraphId: string, kaUal: string, assertionVersion: string,
    subGraphName: string | undefined, ctx: OperationContext): Promise<boolean>;
}

export async function selectFinalizedAssertionPublication(host: FinalizedAssertionSelectionHost, contextGraphId: string, name: string,
  opts: FinalizedAssertionPublishOptions | undefined, recording?: FinalizedAssertionRecordingContext) {
  const catalogObligationRequired = host.admitConfirmedCatalogPublicationV1({ contextGraphId, assertionCoordinate: name, subGraphName: opts?.subGraphName });
  const agentAddress = await host.resolveFinalizedAssertionPublishAuthor(contextGraphId, name, opts);
  const publisher = opts?.publisherOverride ?? host.publisher;
  const assertionUri = contextGraphAssertionUri(
    contextGraphId,
    agentAddress,
    name,
    opts?.subGraphName,
  );
  const metaGraph = contextGraphMetaUri(contextGraphId);

  if (recording?.reservation) {
    assertAssertionLifecycleWriteLease(recording.heldLifecycle, host.writeLocks,
      assertionLifecycleWriteLockKey(contextGraphId, name, agentAddress, opts?.subGraphName));
    if (recording?.reservation.assertionUri !== assertionUri || recording?.reservation.metaGraph !== metaGraph)
      throw new Error('Prepared reservation belongs to a different assertion');
  }
  const { seal, scope: graphScope, kaId: packedKaId } = recording?.reservation
    ?? await readFinalizedAssertionReservation(host.store,
      { contextGraphId, name, agentAddress, subGraphName: opts?.subGraphName }, 'agent.vmPublish.seal');

  assertConfirmedCatalogSealAdmissionV1(catalogObligationRequired, seal);
  const chainTargetMismatch = await sealChainTargetMismatch(host.chain, seal);
  if (chainTargetMismatch) throw new Error(`publishFromFinalizedAssertion: ${chainTargetMismatch}`);

  if (!(await publisher.hasSwmShareComplete(contextGraphId, name, agentAddress, opts?.subGraphName))) {
    throw Object.assign(
      new Error(
        `Cannot publish "${name}" in context graph "${contextGraphId}": it is not a complete full share ` +
          `resident in Shared Memory (a subset/partial share, an explicitly-unsealed share, or an ` +
          `already-consumed/published share). Seal and share the full asset (entities:"all") before publishing.`,
      ),
      { code: 'PUBLISH_NOT_FULL_SHARE' },
    );
  }
  const rfc64WorkspaceHead = await resolveKnowledgeAssetWorkspaceHead({
    store: host.store,
    graphManager: new GraphManager(host.store),
    contextGraphId,
    kaUal: graphScope.ual,
    subGraphName: opts?.subGraphName,
  });

  const lifecycleUri = assertionLifecycleUri(contextGraphId, agentAddress, name, opts?.subGraphName);
  const pointerRes = await host.store.query(
    `SELECT ?vm ?kaNum WHERE { GRAPH <${metaGraph}> {
      OPTIONAL { <${lifecycleUri}> <${VM_CURRENT_ASSERTION_PRED}> ?vm }
      OPTIONAL { <${lifecycleUri}> <${KA_ID_PRED}> ?kaNum }
    } } LIMIT 1`,
    { source: 'agent.vmPublish.lifecyclePointer' },
  );
  const stripLit = (v?: string) => v?.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
  const pointerRow = pointerRes.type === 'bindings' ? pointerRes.bindings[0] : undefined;
  const vmCurrent = stripLit(pointerRow?.['vm']);
  const operationPlan = planKnowledgeAssetVmPublication({
    vmCurrentAssertion: vmCurrent,
    pricingPolicy: opts?.pricingPolicy,
  });
  const stampedNumberStr = stripLit(pointerRow?.['kaNum']);

  if (
    stampedNumberStr !== undefined
    && stampedNumberStr !== ''
    && BigInt(stampedNumberStr) !== BigInt(graphScope.kaNumber)
  ) {
    throw new Error(
      `Lifecycle kaId number ${stampedNumberStr} does not match graph-scoped UAL number ${graphScope.kaNumber}`,
    );
  }
  // Both operations share one sealed identity/scope/lifecycle context. Only the
  // discriminated operation plan determines which execution boundary accepts it.
  const sharedMemoryScope: SharedMemoryGraphScope = { kind: 'named-lifecycle',
    identity: { agentAddress: graphScope.agentAddress, kaNumber: BigInt(graphScope.kaNumber) } };
  const context = { contextGraphId, name, opts, agentAddress, publisher, assertionUri, metaGraph, seal, graphScope,
    packedKaId, rfc64WorkspaceHead, lifecycleUri, catalogObligationRequired, sharedMemoryScope,
    newMerkleHexBare: ethers.hexlify(seal.merkleRoot).slice(2),
    recoveredReservedKaId: seal.reservedKaId ?? packedKaId, privateMerkleRoot: seal.privateMerkleRoot };
  return operationPlan.kind === 'update'
    ? { ...context, kind: 'update' as const, operationPlan }
    : { ...context, kind: 'mint' as const, operationPlan };
}
type FinalizedAssertionSelection = Awaited<ReturnType<typeof selectFinalizedAssertionPublication>>;
type FinalizedAssertionPublicationContext = Omit<FinalizedAssertionSelection, 'kind' | 'operationPlan'>;
type FinalizedAssertionMintPlan = Extract<FinalizedAssertionSelection, { kind: 'mint' }>;
type FinalizedAssertionUpdatePlan = Extract<FinalizedAssertionSelection, { kind: 'update' }>;

export async function prepareFinalizedAssertionUpdateContent(host: FinalizedAssertionUpdateContentHost, selected: FinalizedAssertionUpdatePlan) {
  const { contextGraphId, opts, graphScope, seal, sharedMemoryScope } = selected;
  const scopedSwmQuads = await host._loadSelectedSWMQuads(
    contextGraphId,
    'all',
    opts?.subGraphName,
    sharedMemoryScope,
  );
  const privateStore = new PrivateContentStore(host.store, new GraphManager(host.store));
  const scopedPrivateQuads = await privateStore.getKnowledgeAssetPrivateTriples(
    contextGraphId,
    graphScope,
    opts?.subGraphName,
  );
  if (scopedSwmQuads.length === 0 && scopedPrivateQuads.length === 0) {
    throw new Error(
      `No quads in shared memory for context graph ${contextGraphId} matching graph-scoped ` +
        `KA ${graphScope.ual} (neither public nor private content is present)`,
    );
  }
  const canonicalParts = await skolemizeKnowledgeAssetParts(
    scopedSwmQuads,
    scopedPrivateQuads,
    { allowCanonicalSkolemTerms: true },
  );
  const canonicalSwmQuads = canonicalParts.publicQuads;
  const canonicalPrivateQuads = canonicalParts.privateQuads;
  if (canonicalSwmQuads.length !== seal.publicTripleCount) {
    throw new Error(
      `Graph-scoped SWM triple count mismatch for ${graphScope.ual}: ` +
        `seal=${seal.publicTripleCount}, store=${canonicalSwmQuads.length}`,
    );
  }
  if (canonicalPrivateQuads.length !== seal.privateTripleCount) {
    throw new Error(
      `Graph-scoped private triple count mismatch for ${graphScope.ual}: ` +
        `seal=${seal.privateTripleCount}, store=${canonicalPrivateQuads.length}`,
    );
  }
  const privateMerkleRoot = computePrivateRoot(canonicalPrivateQuads);
  const privateRootMatches = seal.privateMerkleRoot === undefined
    ? privateMerkleRoot === undefined
    : privateMerkleRoot !== undefined
      && seal.privateMerkleRoot.length === privateMerkleRoot.length
      && seal.privateMerkleRoot.every((byte, index) => byte === privateMerkleRoot[index]);
  if (!privateRootMatches) {
    throw new Error(
      `Graph-scoped private Merkle root mismatch for ${graphScope.ual}: ` +
        `seal=${seal.privateMerkleRoot ? ethers.hexlify(seal.privateMerkleRoot) : '(none)'}, ` +
        `store=${privateMerkleRoot ? ethers.hexlify(privateMerkleRoot) : '(none)'}`,
    );
  }
  const swmMerkleRoot = computeFlatKCRoot(
    canonicalSwmQuads,
    privateMerkleRoot ? [privateMerkleRoot] : [],
  );
  if (
    swmMerkleRoot.length !== seal.merkleRoot.length
    || !swmMerkleRoot.every((byte, index) => byte === seal.merkleRoot[index])
  ) {
    throw new Error(
      `Graph-scoped SWM Merkle root mismatch for ${graphScope.ual}: ` +
        `seal=${ethers.hexlify(seal.merkleRoot)}, store=${ethers.hexlify(swmMerkleRoot)}`,
    );
  }

  return { ...selected, canonicalSwmQuads, canonicalPrivateQuads, privateMerkleRoot };
}
type PreparedFinalizedAssertionContent = Awaited<ReturnType<typeof prepareFinalizedAssertionUpdateContent>>;

/** Named lifecycle planning carries the sealed target; publisher owns mint content loading and validation. */
export function finalizedAssertionMintPlan(selected: FinalizedAssertionMintPlan): FinalizedAssertionMintPlan {
  return selected;
}

export function finalizedMintContentOptions(prepared: FinalizedAssertionMintPlan, pricingPolicy: AgentSharedMemoryPublishOptions['pricingPolicy']): SharedMemoryMintRecordingOptions & { publisherOverride: DKGPublisher } {
  const { opts, publisher, recoveredReservedKaId, sharedMemoryScope, graphScope, seal, privateMerkleRoot } = prepared;
  return {
        operationCtx: opts?.operationCtx,
        onPhase: opts?.onPhase,
        subGraphName: opts?.subGraphName,
        accessPolicy: prepared.rfc64WorkspaceHead?.access.accessPolicy,
        allowedPeers: prepared.rfc64WorkspaceHead ? [...prepared.rfc64WorkspaceHead.access.allowedPeers] : undefined,
        publisherPeerId: prepared.rfc64WorkspaceHead?.publisherPeerId,
        pricingPolicy,
        reservedKaId: recoveredReservedKaId,
        sharedMemoryScope,
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: graphScope.ual,
        assertionVersion: graphScope.assertionVersion,
        publicTripleCount: seal.publicTripleCount,
        ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
        privateTripleCount: seal.privateTripleCount ?? 0,
        precomputedAttestation: {
          expectedMerkleRoot: seal.merkleRoot,
          authorAddress: seal.authorAddress,
          signature: { r: seal.authorAttestationR, vs: seal.authorAttestationVS },
          schemeVersion: seal.authorSchemeVersion,
          reservedKaId: recoveredReservedKaId ?? 0n,
        },
        publisherOverride: publisher,
  };
}

export function finalizedMintOptions(prepared: FinalizedAssertionMintPlan, pricingPolicy: AgentSharedMemoryPublishOptions['pricingPolicy']): AgentSharedMemoryPublishOptions {
  return { ...finalizedMintContentOptions(prepared, pricingPolicy),
    publisherNodeIdentityIdOverride: prepared.opts?.publisherNodeIdentityIdOverride, publishEpochs: prepared.opts?.publishEpochs };
}

async function stampFinalizedPublicationLifecycle(host: FinalizedAssertionLifecycleHost, prepared: FinalizedAssertionPublicationContext, result: PublishResult): Promise<boolean> {
  const { contextGraphId, name, opts, publisher, agentAddress, packedKaId, lifecycleUri, newMerkleHexBare } = prepared;
  const ctx = opts?.operationCtx ?? createOperationContext('publishFromSWM');
  if (result.status === 'confirmed' && opts?.clearSharedMemoryAfter === true)
    await publisher.clearRemainingSharedMemory(contextGraphId, opts?.subGraphName, ctx);
  if (result.status !== 'confirmed' && result.status !== 'tentative') return false;
  try {
    const vmKaId = result.onChainResult ? packedKaId ?? result.onChainResult.kaId ?? result.kaId : undefined;
    await host.publishedNamedKaVmLifecycleWriter({ contextGraphId, agentAddress, name, subGraphName: opts?.subGraphName,
      publishedUal: result.ual, merkleRoot: newMerkleHexBare,
      ...(vmKaId === undefined || vmKaId === null ? {} : { packedKaId: BigInt(vmKaId) }),
    });
    return true;
  } catch (err) {
    host.log.warn(ctx, `Failed to stamp VM lifecycle marker for <${lifecycleUri}>: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function consumeFinalizedPublicationShare(host: Pick<FinalizedAssertionLifecycleHost, 'log'>, prepared: FinalizedAssertionPublicationContext,
  result: PublishResult): Promise<void> {
  if (result.status !== 'confirmed') return;
  const { contextGraphId, name, opts, publisher, agentAddress, lifecycleUri } = prepared;
  try {
    await publisher.clearSwmShareComplete(contextGraphId, name, agentAddress, opts?.subGraphName);
  } catch (err) {
    host.log.warn(opts?.operationCtx ?? createOperationContext('publishFromSWM'),
      `Failed to clear swmShareComplete after confirmed publish of <${lifecycleUri}>: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function finalizedPublicationIdentity(prepared: FinalizedAssertionPublicationContext) {
  const { contextGraphId, name, opts, rfc64WorkspaceHead, seal, assertionUri } = prepared;
  return { contextGraphId, subGraphName: opts?.subGraphName, assertionCoordinate: name,
    shareOperationId: rfc64WorkspaceHead?.shareOperationId, seal, assertionUri };
}

async function observeFinalizedPublicationCatalog(host: Pick<FinalizedAssertionMintHost, 'observeRfc64ConfirmedVmV1'>,
  prepared: FinalizedAssertionPublicationContext, result: PublishResult): Promise<void> {
  return observeConfirmedPublicationWithRecoveryV1({ ...finalizedPublicationIdentity(prepared),
    status: result.status, confirmedTransaction: result.onChainResult, catalogObligationRequired: prepared.catalogObligationRequired,
    ctx: prepared.opts?.operationCtx ?? createOperationContext('publishFromSWM'), publicationLabel: 'publish',
  }, host.observeRfc64ConfirmedVmV1);
}

/** Original publication alone creates the checkpoint; the completion protocol needs no resident content. */
export async function completeFinalizedAssertionMint(host: FinalizedAssertionMintHost, prepared: FinalizedAssertionMintPlan,
  result: PublishResult): Promise<void> {
  if (result.status !== 'confirmed') {
    await stampFinalizedPublicationLifecycle(host, prepared, result); return;
  }
  const { opts, assertionUri, metaGraph, seal, contextGraphId, graphScope, packedKaId, publisher, name, agentAddress } = prepared;
  const ctx = opts?.operationCtx ?? createOperationContext('publishFromSWM');
  const checkpointReady = await createFinalizedAssertionMintCheckpoint(host, prepared);
  if (opts?.clearSharedMemoryAfter === true) await publisher.clearRemainingSharedMemory(contextGraphId, opts?.subGraphName, ctx);
  const completion = await completeNamedMint({ store: host.store, stampPublishedLifecycle: host.publishedNamedKaVmLifecycleWriter,
    completeFinalization: input => completeNamedPublishFinalization(host, input),
    clearShareMarker: () => publisher.clearSwmShareComplete(contextGraphId, name, agentAddress, opts?.subGraphName),
  }, { reservation: { seal, scope: graphScope, kaId: packedKaId, assertionUri, metaGraph },
    contextGraphId, name, agentAddress, subGraphName: opts?.subGraphName, receipt: result.onChainResult }, {
    consumeShare: checkpointReady, failureMode: 'continue',
  });
  if (completion.status === 'incomplete') {
    for (const { stage, error } of completion.failures)
      host.log.warn(ctx, `Failed named-mint ${stage} completion for <${assertionUri}>: ${error instanceof Error ? error.message : String(error)}`);
    const obligationFailure = completion.failures.find(failure => failure.error instanceof ConfirmedCatalogObligationErrorV1);
    if (obligationFailure) throw obligationFailure.error;
  }
  // Failure to persist our recovery checkpoint cannot waive the admitted catalog obligation.
  if (!checkpointReady) await observeFinalizedPublicationCatalog(host, prepared, result);
}

/** Created only after resident content recording, cleanup and gossip have completed. */
export async function createFinalizedAssertionMintCheckpoint(host: Pick<FinalizedAssertionMintHost, 'store' | 'log' | 'catalogRequired'>,
  prepared: FinalizedAssertionMintPlan): Promise<boolean> {
  const { opts, assertionUri, seal, rfc64WorkspaceHead, contextGraphId } = prepared;
  const ctx = opts?.operationCtx ?? createOperationContext('publishFromSWM');
  // Only the original path proves content recording, cleanup and gossip. Resume may never create this proof.
  const ready = () => beginNamedPublishFinalization(host.store,
    { assertionUri, seal, shareOperationId: rfc64WorkspaceHead?.shareOperationId },
    () => prepared.catalogObligationRequired || host.catalogRequired(contextGraphId, opts?.subGraphName));
  let checkpointReady = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await ready(); checkpointReady = true; break; }
    catch (err) { host.log.warn(ctx, `Failed to write publish checkpoint for <${assertionUri}>: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return checkpointReady;
}

export async function publishFinalizedAssertionUpdate(host: FinalizedAssertionUpdateHost, prepared: PreparedFinalizedAssertionContent): Promise<PublishResult> {
  const { contextGraphId, opts, publisher, packedKaId, seal, graphScope, canonicalSwmQuads, canonicalPrivateQuads,
    privateMerkleRoot, sharedMemoryScope, lifecycleUri, operationPlan, newMerkleHexBare, metaGraph } = prepared;
  if (operationPlan.kind !== 'update') throw new Error('Expected a finalized update plan');
    // ── UPDATE PATH ──
    // The name already has a confirmed VM version. Reuse its kaId and call
    // the on-chain update primitive. The publisher's update path recomputes
    // the merkle from the SWM-selected quads and requires a
    // precomputedUpdateAttestation over (kaId, newMerkleRoot, author); we
    // mint it here from the seal's merkle using the seal's author signer.
    const updateQuads = canonicalSwmQuads;
    const updateAttestation = await host._buildPrecomputedUpdateAttestationForSeal(
      packedKaId,
      seal,
      publisher,
    );
    const result = await host.update(
      packedKaId,
      contextGraphId,
      updateQuads.map((q) => ({ ...q, graph: '' })),
      canonicalPrivateQuads.map((q) => ({ ...q, graph: '' })),
      {
        operationCtx: opts?.operationCtx,
        onPhase: opts?.onPhase,
        precomputedUpdateAttestation: updateAttestation,
        publisherOverride: publisher,
        subGraphName: opts?.subGraphName,
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: graphScope.ual,
        assertionVersion: graphScope.assertionVersion,
        publicTripleCount: seal.publicTripleCount,
        ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
        privateTripleCount: seal.privateTripleCount,
      },
    );

    // #1099: the update primitive (`publisher.update`) has no SWM-drain of
    // its own — only the mint path's `publishFromSharedMemory` cleans SWM
    // after chain confirmation. Without this, every edit-loop update left
    // the re-shared SWM copy in place forever (locally AND on every replica
    // that mirrored the share), so SWM and VM permanently disagreed.
    if (result.status === 'confirmed') {
      try {
        await publisher.clearPublishedKnowledgeAssetSwm(
          contextGraphId,
          sharedMemoryScope,
          opts?.subGraphName,
          opts?.operationCtx ?? createOperationContext('publishFromSWM'),
          graphScope.ual,
          graphScope.assertionVersion,
        );
        await host.retireLegacySwm(
          contextGraphId,
          graphScope.ual,
          graphScope.assertionVersion,
          opts?.subGraphName,
          opts?.operationCtx ?? createOperationContext('publishFromSWM'),
        );
      } catch (err) {
        host.log.warn(
          opts?.operationCtx ?? createOperationContext('publishFromSWM'),
          `Failed to clear SWM after confirmed update of <${lifecycleUri}>: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }


  if (await stampFinalizedPublicationLifecycle(host, prepared, result)) {
    try {
      const priorBare = operationPlan.vmCurrentAssertion.replace(/^0x/, '');
      const priorUri = `${lifecycleUri}#assertion-${priorBare}`;
      await host._stampPointerIfDivergedFromVm(lifecycleUri, WM_CURRENT_ASSERTION_PRED, newMerkleHexBare, metaGraph);
      await host.store.insert([
        { subject: lifecycleUri, predicate: 'http://www.w3.org/ns/prov#wasRevisionOf', object: priorUri, graph: metaGraph },
        { subject: priorUri, predicate: VM_CURRENT_ASSERTION_PRED, object: `"${priorBare}"`, graph: metaGraph },
      ]);
    } catch (err) { host.log.warn(opts?.operationCtx ?? createOperationContext('publishFromSWM'),
      `Failed to stamp update provenance for <${lifecycleUri}>: ${err instanceof Error ? err.message : String(err)}`); }
  }
  await consumeFinalizedPublicationShare(host, prepared, result);
  await observeFinalizedPublicationCatalog(host, prepared, result);
  return result;
}
