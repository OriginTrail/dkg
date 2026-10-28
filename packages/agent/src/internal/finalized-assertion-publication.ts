import { completeNamedMint } from './named-mint-completion.js';
// SPDX-License-Identifier: Apache-2.0
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
import { beginNamedPublishFinalization, finishNamedPublishFinalization, type NamedPublishFinalizationInput } from '../named-publish-finalization.js';
import type { AgentSharedMemoryPublishOptions, FinalizedAssertionPublishOptions, FinalizedAssertionRecordingContext } from './agent-publish-options.js';

/** Capabilities used by finalized mint/update stages; public entry points bind them once. */
export interface FinalizedAssertionPublicationHost {
  readonly store: TripleStore;
  readonly publisher: DKGPublisher;
  readonly chain: ChainAdapter;
  readonly log: Logger;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly resolveFinalizedAssertionPublishAuthor: OmitThisParameter<DKGAgent['resolveFinalizedAssertionPublishAuthor']>;
  readonly _loadSelectedSWMQuads: OmitThisParameter<DKGAgent['_loadSelectedSWMQuads']>;
  readonly publishedNamedKaVmLifecycleWriter: DKGAgent['publishedNamedKaVmLifecycleWriter'];
  readonly _buildPrecomputedUpdateAttestationForSeal: OmitThisParameter<DKGAgent['_buildPrecomputedUpdateAttestationForSeal']>;
  readonly update: OmitThisParameter<DKGAgent['update']>;
  readonly _stampPointerIfDivergedFromVm: OmitThisParameter<DKGAgent['_stampPointerIfDivergedFromVm']>;
  readonly observeRfc64ConfirmedVmV1: OmitThisParameter<DKGAgent['observeRfc64ConfirmedVmV1']>;
  readonly transferRfc64ConfirmedVmV1: OmitThisParameter<DKGAgent['transferRfc64ConfirmedVmV1']>;
  catalogRequired(contextGraphId: string, subGraphName?: string): boolean;
  retireLegacySwm(contextGraphId: string, kaUal: string, assertionVersion: string,
    subGraphName: string | undefined, ctx: OperationContext): Promise<boolean>;
}

// Implementation-only publication stages; absent from the exported DKGAgent surface.
export async function completeNamedPublishFinalization(host: FinalizedAssertionPublicationHost, input: NamedPublishFinalizationInput): Promise<'complete' | 'pending'> {
    return finishNamedPublishFinalization(host.store, input, {
      transfer: shareOperationId => host.transferRfc64ConfirmedVmV1({
        ...input, shareOperationId, ctx: createOperationContext('publishFromSWM'), publicationLabel: 'publish',
      }),
    });
}

export async function selectFinalizedAssertionPublication(host: FinalizedAssertionPublicationHost, contextGraphId: string, name: string,
  opts: FinalizedAssertionPublishOptions | undefined, recording?: FinalizedAssertionRecordingContext) {
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
  return { contextGraphId, name, opts, agentAddress, publisher, assertionUri, metaGraph, seal, graphScope,
    packedKaId, rfc64WorkspaceHead, lifecycleUri, operationPlan };
}
type FinalizedAssertionSelection = Awaited<ReturnType<typeof selectFinalizedAssertionPublication>>;

export async function prepareFinalizedAssertionContent(host: FinalizedAssertionPublicationHost, selected: FinalizedAssertionSelection) {
  const { contextGraphId, opts, graphScope, seal, packedKaId } = selected;
  const newMerkleHexBare = ethers.hexlify(seal.merkleRoot).slice(2);
  const recoveredReservedKaId = seal.reservedKaId ?? packedKaId;
  const sharedMemoryScope: SharedMemoryGraphScope = {
    kind: 'named-lifecycle',
    identity: {
      agentAddress: graphScope.agentAddress,
      kaNumber: BigInt(graphScope.kaNumber),
    },
  };
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

  return { ...selected, newMerkleHexBare, recoveredReservedKaId, sharedMemoryScope, canonicalSwmQuads, canonicalPrivateQuads, privateMerkleRoot };
}
type PreparedFinalizedAssertionContent = Awaited<ReturnType<typeof prepareFinalizedAssertionContent>>;

export function finalizedMintContentOptions(prepared: PreparedFinalizedAssertionContent, pricingPolicy: AgentSharedMemoryPublishOptions['pricingPolicy']): SharedMemoryMintRecordingOptions & { publisherOverride: DKGPublisher } {
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
        privateTripleCount: prepared.canonicalPrivateQuads.length,
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

export function finalizedMintOptions(prepared: PreparedFinalizedAssertionContent, pricingPolicy: AgentSharedMemoryPublishOptions['pricingPolicy']): AgentSharedMemoryPublishOptions {
  return { ...finalizedMintContentOptions(prepared, pricingPolicy),
    publisherNodeIdentityIdOverride: prepared.opts?.publisherNodeIdentityIdOverride, publishEpochs: prepared.opts?.publishEpochs };
}

async function stampFinalizedPublicationLifecycle(host: FinalizedAssertionPublicationHost, prepared: PreparedFinalizedAssertionContent, result: PublishResult): Promise<boolean> {
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

async function consumeFinalizedPublicationShare(host: FinalizedAssertionPublicationHost, prepared: PreparedFinalizedAssertionContent,
  result: PublishResult, recording?: FinalizedAssertionRecordingContext): Promise<void> {
  if (result.status !== 'confirmed') return;
  const { contextGraphId, name, opts, publisher, agentAddress, lifecycleUri } = prepared;
  try {
    await publisher.clearSwmShareComplete(contextGraphId, name, agentAddress, opts?.subGraphName, recording?.heldLifecycle);
  } catch (err) {
    host.log.warn(opts?.operationCtx ?? createOperationContext('publishFromSWM'),
      `Failed to clear swmShareComplete after confirmed publish of <${lifecycleUri}>: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function finalizedPublicationIdentity(prepared: PreparedFinalizedAssertionContent) {
  const { contextGraphId, name, opts, rfc64WorkspaceHead, seal, assertionUri } = prepared;
  return { contextGraphId, subGraphName: opts?.subGraphName, assertionCoordinate: name,
    shareOperationId: rfc64WorkspaceHead?.shareOperationId, seal, assertionUri };
}

/** Original publication alone creates the checkpoint; the completion protocol needs no resident content. */
export async function completeFinalizedAssertionMint(host: FinalizedAssertionPublicationHost, prepared: PreparedFinalizedAssertionContent,
  result: PublishResult, recording?: FinalizedAssertionRecordingContext): Promise<void> {
  if (result.status !== 'confirmed') {
    await stampFinalizedPublicationLifecycle(host, prepared, result); return;
  }
  const { opts, assertionUri, metaGraph, seal, rfc64WorkspaceHead, contextGraphId, graphScope, packedKaId, publisher, name, agentAddress } = prepared;
  const ctx = opts?.operationCtx ?? createOperationContext('publishFromSWM');
  // Only the original path proves content recording, cleanup and gossip. Resume may never create this proof.
  const ready = () => beginNamedPublishFinalization(host.store,
    { assertionUri, seal, shareOperationId: rfc64WorkspaceHead?.shareOperationId },
    () => host.catalogRequired(contextGraphId, opts?.subGraphName));
  let checkpointReady = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await ready(); checkpointReady = true; break; }
    catch (err) { host.log.warn(ctx, `Failed to write publish checkpoint for <${assertionUri}>: ${err instanceof Error ? err.message : String(err)}`); }
  }
  if (opts?.clearSharedMemoryAfter === true) await publisher.clearRemainingSharedMemory(contextGraphId, opts?.subGraphName, ctx);
  let catalogFailure: unknown;
  await completeNamedMint({ store: host.store, stampPublishedLifecycle: host.publishedNamedKaVmLifecycleWriter,
    completeFinalization: input => completeNamedPublishFinalization(host, input),
    clearShareMarker: () => publisher.clearSwmShareComplete(contextGraphId, name, agentAddress, opts?.subGraphName, recording?.heldLifecycle),
  }, { reservation: { seal, scope: graphScope, kaId: packedKaId, assertionUri, metaGraph },
    contextGraphId, name, agentAddress, subGraphName: opts?.subGraphName, receipt: result.onChainResult }, {
    consumeShare: checkpointReady,
    onFailure: (stage, error) => {
      if (stage === 'catalog') catalogFailure = error;
      host.log.warn(ctx, `Failed named-mint ${stage} completion for <${assertionUri}>: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  // Ordinary publication retains the confirmed result; record-only reconciliation requires catalog ownership.
  if (recording && catalogFailure !== undefined) throw catalogFailure;
}

export async function publishFinalizedAssertionUpdate(host: FinalizedAssertionPublicationHost, prepared: PreparedFinalizedAssertionContent): Promise<PublishResult> {
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
  if (result.status === 'confirmed') await host.observeRfc64ConfirmedVmV1({ ...finalizedPublicationIdentity(prepared),
    ctx: opts?.operationCtx ?? createOperationContext('publishFromSWM'), publicationLabel: 'publish' });
  return result;
}
