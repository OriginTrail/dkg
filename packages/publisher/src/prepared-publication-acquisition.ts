// SPDX-License-Identifier: Apache-2.0
import {graphScopeTargetsChain} from './graph-scope-chain-target.js';
import {ethers} from 'ethers';
import type {ChainAdapter, OnChainPublishResult} from '@origintrail-official/dkg-chain';
import {buildAuthorAttestationTypedData, type Logger, type OperationContext} from '@origintrail-official/dkg-core';

import type {PublishOptions, V10CoreNodeACK} from './publisher.js';


import {PublisherWalletRequiredError} from './errors.js';



import {createWriteAheadHook} from './publisher-write-ahead.js';



import type {PublishLifecycleLogger} from './publish-lifecycle-logger.js';
import {mintOrAdoptKnowledgeAssets, type MintOrAdoptOutcome, type MintRecording} from './adopt-existing-mint.js';

import type {PreparedPublication} from './prepared-publication.js';
export type PublicationAcquisition =
  | { kind: 'confirmed'; outcome: MintOrAdoptOutcome; reservedKaId: bigint | undefined;
      effectiveAuthorAddress: string; v10ACKs?: V10CoreNodeACK[] }
  | { kind: 'tentative'; ual: string; localChainSkipReason: 'no-chain' | undefined;
      v10ACKs?: V10CoreNodeACK[]; reason: string };
interface PublicationAcquisitionPorts {
  chain: ChainAdapter;
  log: Logger;
  ensureReservedKaId(author: string, precomputed?: bigint): Promise<bigint | undefined>;
  validateSealIntegrity(): Promise<void>;
}
/** Acquire a local outcome or receipt from a prepared payload. All persistence belongs to recording. */
export async function acquirePreparedPublication(input: PreparedPublication, ports: PublicationAcquisitionPorts): Promise<PublicationAcquisition> {
  const { catalogCommitment, privateRoots, kcMerkleRoot, allSkolemizedQuads, kcMerkleLeafCount, kaCount, entityCount } = input.payload;
  const { publisherContextGraphId, graphPublish, v10CgDomain, contextGraphId, attributionIdentityId, hasAttributionOverride, v10ChainId, v10KavAddress, sealedAdoption } = input.target;
  const { options, lifecycle, ctx } = input;
  const { publisherSigner, publisherAddress, publishEpochs, precomputedTokenAmount,
    chainV10Ready, publicationPricing, useCuratedCatalog, publishOperationId, v10ACKs } = input;
  const { onPhase, onBroadcastAccepted, onBeforeBroadcast } = options;
  const v10CgId = /^\d+$/.test(v10CgDomain) ? BigInt(v10CgDomain) : 0n;
  let onChainResult: OnChainPublishResult;
  let recording: MintRecording | undefined;
  let localChainSkipReason: 'no-chain' | undefined;
  const ual = graphPublish?.scope.ual ?? `did:dkg:${ports.chain.chainId}/${publisherAddress}/t${publishOperationId}`;
  onPhase?.('chain', 'start');

  if (publisherContextGraphId === undefined) {
    ports.log.warn(ctx, `No positive on-chain context graph id resolved from "${v10CgDomain}" — skipping on-chain publish`);
    localChainSkipReason = 'no-chain';
    return { kind: 'tentative', ual, localChainSkipReason, v10ACKs, reason: 'no on-chain CG id' };
  } else if (!chainV10Ready) {
    ports.log.warn(ctx, 'Chain adapter is not V10-ready — skipping on-chain publish');
    localChainSkipReason = 'no-chain';
    return { kind: 'tentative', ual, localChainSkipReason, v10ACKs, reason: 'chain not V10-ready' };
  } else {
    const tokenAmount = precomputedTokenAmount;
    

    await ports.validateSealIntegrity();

    let signStarted = false;
    let submitStarted = false;
    try {
      onPhase?.('chain:sign', 'start');
      signStarted = true;
      if (!publisherSigner) throw new PublisherWalletRequiredError('publish');
      if (publisherSigner) ports.log.info(ctx, `Signing on-chain publish (attributionId=${attributionIdentityId}${hasAttributionOverride ? ' [override]' : ''}, signer=${publisherSigner.address}, source=${publisherSigner.source})`);

      onPhase?.('chain:sign', 'end');
      signStarted = false;
      onPhase?.('chain:submit', 'start');
      submitStarted = true;
      ports.log.info(ctx, `Submitting V10 on-chain publish tx (${kaCount} KAs, networkVisibleByteSize=${publicationPricing.networkVisibleByteSize}${useCuratedCatalog ? ' [catalog]' : ''}, billableByteSize=${publicationPricing.billableByteSize}, pricingPolicy=${publicationPricing.policy}, tokenAmount=${tokenAmount})`);

      if (!v10ACKs || v10ACKs.length === 0) {
        throw new Error('V10 ACKs required for on-chain publish — no ACKs collected');
      }
      if (typeof ports.chain.isV10Ready !== 'function' || !ports.chain.isV10Ready()) {
        throw new Error(
          'Chain adapter is not V10-ready (isV10Ready() returned false or is missing). ' +
          'Publish is routed through KnowledgeAssetsV10.publish, which requires ' +
          'the adapter to expose createKnowledgeAssets, getEvmChainId, and ' +
          'getKnowledgeAssetsLifecycleAddress — use an EVM adapter pointed at a chain where ' +
          'KnowledgeAssetsV10 is deployed.',
        );
      }
      if (v10ChainId === undefined || v10KavAddress === undefined) {
        throw new Error(
          'V10 publish requires the chain adapter to expose getEvmChainId() and ' +
          'getKnowledgeAssetsLifecycleAddress(); neither was resolved. The adapter is not V10-capable.',
        );
      }
      if (!options.precomputedAttestation) {
        throw new Error(
          'Publish rejected: on-chain publish requires precomputedAttestation. ' +
          'RFC-001 §9.x — every published assertion must be sealed at finalize-time. ' +
          'Call agent.assertion.finalize(...) first; the daemon\'s assertion-name-aware ' +
          '/api/knowledge-assets/:name/vm/publish route resolves the seal automatically.',
        );
      }
      const effectiveAuthorAddress = options.precomputedAttestation.authorAddress;
      const effectiveSchemeVersion = options.precomputedAttestation.schemeVersion;
      buildAuthorAttestationTypedData({
        chainId: v10ChainId,
        kav10Address: v10KavAddress,
        merkleRoot: kcMerkleRoot,
        authorAddress: effectiveAuthorAddress,
        reservedKaId: options.precomputedAttestation.reservedKaId,
        schemeVersion: effectiveSchemeVersion,
      });
      const authorSig: ethers.Signature = ethers.Signature.from({
        r: ethers.hexlify(options.precomputedAttestation.signature.r),
        yParityAndS: ethers.hexlify(options.precomputedAttestation.signature.vs),
      });
      const writeAhead = createWriteAheadHook({ onPhase, onBeforeBroadcast, operationKind: 'create' });
      const emitWriteAheadStart = writeAhead.emitWriteAheadStart;
      const reservedKaId = await ports.ensureReservedKaId(
        effectiveAuthorAddress,
        (options as PublishOptions).reservedKaId ?? options.precomputedAttestation?.reservedKaId,
      );
      if (graphPublish && reservedKaId !== undefined) {
        if (reservedKaId !== graphPublish.expectedPackedKaId) {
          throw new Error(
            `Graph-scoped publish reserved kaId ${reservedKaId} does not derive from ` +
              `UAL ${graphPublish.scope.ual} (expected ${graphPublish.expectedPackedKaId}); refusing to mint`,
          );
        }
        if (!graphScopeTargetsChain(
          graphPublish.scope.chainId,
          ports.chain.chainId,
          v10ChainId,
        )) {
          throw new Error(
            `Graph-scoped publish UAL ${graphPublish.scope.ual} targets chain ` +
              `${graphPublish.scope.chainId}, but this publisher mints on ` +
              `${ports.chain.chainId} (EIP-155 ${v10ChainId})`,
          );
        }
      }
      await lifecycle.rememberAssetUal(reservedKaId);
      if (!lifecycle.identityAllocatedEmitted && reservedKaId !== undefined) {
        lifecycle.emit('identity', 'asset_ual_allocated', {
          metadata: {
            contextGraphId,
            kaId: reservedKaId.toString(),
            publisherAddress,
            entityCount,
            publicRecordCount: allSkolemizedQuads.length,
            hiddenCommitmentCount: privateRoots.length,
          },
        });
      }
      try {
        if (useCuratedCatalog) {
          if (
            !catalogCommitment
            || catalogCommitment.root.length !== 32
            || catalogCommitment.leafCount <= 0
            || catalogCommitment.root.every((b) => b === 0)
          ) {
            throw new Error(
              `OT-RFC-49: dkg-publisher refused to submit a curated publish with an empty ` +
              `catalog commitment (root=${catalogCommitment?.root.length ?? 0} bytes, ` +
              `count=${catalogCommitment?.leafCount ?? 0}). The catalog root MUST be the V10 ` +
              `Merkle root over the committed catalog leaf-set, never bytes32(0) — without it ` +
              `the prover cannot prove the curated CG and random sampling skips the KC.`,
            );
          }
        }
        lifecycle.emit('chain', 'submit', {
          metadata: {
            contextGraphId: v10CgId.toString(),
            kaId: reservedKaId?.toString(),
            byteSize: publicationPricing.networkVisibleByteSize.toString(),
            billableByteSize: publicationPricing.billableByteSize.toString(),
            pricingPolicy: publicationPricing.policy,
            tokenAmount: tokenAmount.toString(),
            ackCount: v10ACKs?.length ?? 0,
            merkleLeafCount: kcMerkleLeafCount,
          },
        });
        ({ result: onChainResult, recording } = await mintOrAdoptKnowledgeAssets(ports.chain, {
          publishOperationId,
          contextGraphId: v10CgId,
          publisherAddress: publisherSigner.address,
          reservedKaId,
          merkleRoot: kcMerkleRoot,
          knowledgeAssetsAmount: kaCount,
          byteSize: publicationPricing.networkVisibleByteSize,
          catalogRoot: useCuratedCatalog ? catalogCommitment?.root : undefined,
          catalogLeafCount: useCuratedCatalog ? catalogCommitment?.leafCount : undefined,
          epochs: publishEpochs,
          tokenAmount,
          merkleLeafCount: kcMerkleLeafCount,
          isImmutable: false,
          publisherNodeIdentityId: attributionIdentityId,
          author: {
            address: effectiveAuthorAddress,
            signature: {
              r: ethers.getBytes(authorSig.r),
              vs: ethers.getBytes(authorSig.yParityAndS),
            },
            schemeVersion: effectiveSchemeVersion,
          },
          ackSignatures: v10ACKs.map(ack => ({
            identityId: ack.nodeIdentityId,
            r: ack.signatureR,
            vs: ack.signatureVS,
          })),
          onBroadcast: emitWriteAheadStart,
          onBroadcastAccepted: (signal) =>
            onBroadcastAccepted?.({ ...signal, operationKind: 'create' }),
          ...(writeAhead.onBeforeReplacementBroadcast
            ? { onBeforeReplacementBroadcast: writeAhead.onBeforeReplacementBroadcast }
            : {}),
        }, sealedAdoption));
      } finally {
        if (writeAhead.didWriteAhead()) onPhase?.('chain:writeahead', 'end');
      }

      if (!recording.adopted) onChainResult.tokenAmount = tokenAmount;
      return { kind: 'confirmed', outcome: { result: onChainResult, recording },
        reservedKaId, effectiveAuthorAddress, v10ACKs };
    } catch (err) {
      throw publicationAcquisitionFailure(err, ports.log, ctx, lifecycle, v10CgId, v10ACKs?.length ?? 0);
    } finally {
      if (signStarted) onPhase?.('chain:sign', 'end');
      if (submitStarted) onPhase?.('chain:submit', 'end');
    }
  }

}

/** Identical failure evidence for receipt acquisition and confirmed recording. */
export function publicationAcquisitionFailure(error: unknown, log: Logger, ctx: OperationContext,
  lifecycle: PublishLifecycleLogger, contextGraphId: bigint, ackCount: number): Error {
  const tag = error instanceof Error ? error.name : 'unknown';
  const message = error instanceof Error ? error.message : String(error);
  lifecycle.emit('chain', 'failure', { level: 'error', metadata: { outcome: 'failure',
    contextGraphId: contextGraphId.toString(), ackCount, errorClass: tag, reason: message } });
  log.warn(ctx, `On-chain publish failed (${tag}): ${message}`);
  return error instanceof Error ? error : new Error(message);
}
