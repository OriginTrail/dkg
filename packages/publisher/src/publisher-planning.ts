// SPDX-License-Identifier: Apache-2.0

import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { resolveLegacyPublisherCandidatePricing } from '@origintrail-official/dkg-chain';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { PublisherWalletRequiredError } from './errors.js';
import { DEFAULT_PUBLISH_EPOCHS } from './publisher.js';

export interface PublisherSigner {
  address: string;
  source: 'publisherPrivateKey' | 'chainAdapter';
  signMessage(message: Uint8Array): Promise<string>;
  signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string>;
}

export interface PublisherAddressResolution {
  address?: string;
  planningPin?: string;
  /** Diagnostics only; signer policy is carried exclusively by registrationPin. */
  planningPinLabel?: string;
  registrationPin:
    | { disposition: 'hard'; address: string }
    | { disposition: 'advisory' };
}

interface PublisherPlanningStateLocal {
  kind: 'local';
  chainV10Ready: boolean;
  publisherAddress: string;
}

interface PublisherPlanningStateLegacy {
  kind: 'legacy-on-chain';
  chainV10Ready: true;
  contextGraphId: bigint;
  selection: PublisherAddressResolution;
  initialSigner: PublisherSigner;
}

interface PublisherPlanningStateAdapter {
  kind: 'adapter-planned';
  chainV10Ready: true;
  contextGraphId: bigint;
  selection: PublisherAddressResolution;
}

type PublisherPlanningState =
  | PublisherPlanningStateLocal
  | PublisherPlanningStateLegacy
  | PublisherPlanningStateAdapter;

export type FinalizedPublisherPlan =
  | {
    kind: 'local';
    publisherAddress: string;
    publishEpochs: number;
    tokenAmount: 0n;
  }
  | {
    kind: 'on-chain';
    signer: PublisherSigner;
    publisherAddress: string;
    publishEpochs: number;
    tokenAmount: bigint;
  };

export interface PublisherPlanningFinalizeInput {
  explicitPublishEpochs: number | undefined;
  effectiveByteSize: bigint;
  ctx: OperationContext;
}

/** The only planning surface the large publish flow needs to retain. */
export interface PreparedPublisherPlanning {
  readonly chainV10Ready: boolean;
  readonly canAttemptOnChainPublish: boolean;
  finalize(input: PublisherPlanningFinalizeInput): Promise<FinalizedPublisherPlan>;
}

interface PublisherPlanningDependencies {
  chain: ChainAdapter;
  resolvePublisherAddressSelection(
    contextGraphId: bigint | undefined,
    options: {
      includeReservingPublisherProbe: boolean;
      includeGenericSignMessageProbe?: boolean;
    },
  ): Promise<PublisherAddressResolution>;
  resolvePublisherSigner(address: string | undefined): Promise<PublisherSigner | undefined>;
  localTentativePublisherAddress(): string;
  log: {
    info(ctx: OperationContext, message: string): void;
    warn(ctx: OperationContext, message: string): void;
  };
}

export function coercePublisherAddress(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ethers.isAddress(value)) return undefined;
  const normalized = ethers.getAddress(value);
  return normalized === ethers.ZeroAddress ? undefined : normalized;
}

/**
 * Owns local, legacy, and adapter-backed publish planning. The caller prepares
 * one opaque boundary early and finalizes it only after exact byte size exists.
 */
export class PublisherPlanner {
  constructor(private readonly dependencies: PublisherPlanningDependencies) {}

  async prepare(contextGraphId: bigint | undefined): Promise<PreparedPublisherPlanning> {
    const state = await this.prepareState(contextGraphId);
    return {
      chainV10Ready: state.chainV10Ready,
      canAttemptOnChainPublish: state.kind !== 'local',
      finalize: (input) => this.finalizeState(state, input),
    };
  }

  private async prepareState(contextGraphId: bigint | undefined): Promise<PublisherPlanningState> {
    const chainV10Ready = await this.refreshChainV10Readiness();
    if (contextGraphId === undefined || !chainV10Ready) {
      const selection = await this.dependencies.resolvePublisherAddressSelection(undefined, {
        includeReservingPublisherProbe: false,
        includeGenericSignMessageProbe: false,
      });
      return {
        kind: 'local',
        chainV10Ready,
        publisherAddress: selection.address
          ?? this.dependencies.localTentativePublisherAddress(),
      };
    }

    const adapterOwnedPlanning =
      typeof this.dependencies.chain.resolvePublisherPublishPlan === 'function';
    const selection = await this.dependencies.resolvePublisherAddressSelection(contextGraphId, {
      includeReservingPublisherProbe: !adapterOwnedPlanning,
    });
    if (adapterOwnedPlanning) {
      return {
        kind: 'adapter-planned',
        chainV10Ready: true,
        contextGraphId,
        selection,
      };
    }

    const initialSigner = await this.dependencies.resolvePublisherSigner(selection.address);
    if (!initialSigner) throw new PublisherWalletRequiredError('publish');
    return {
      kind: 'legacy-on-chain',
      chainV10Ready: true,
      contextGraphId,
      selection,
      initialSigner,
    };
  }

  private async resolveLegacyPublishPricing(input: {
    publisherAddress: string;
    explicitPublishEpochs: number | undefined;
    effectiveByteSize: bigint;
    ctx: OperationContext;
  }): Promise<{ publishEpochs: number; precomputedTokenAmount: bigint }> {
    const chain = this.dependencies.chain;
    const quote = typeof chain.getRequiredPublishTokenAmount === 'function'
      ? (epochs: number) => chain.getRequiredPublishTokenAmount!(input.effectiveByteSize, epochs)
      : undefined;
    const conviction =
      typeof chain.getConvictionAgentAccountId === 'function'
      && typeof chain.getConvictionAccountLockDurationEpochs === 'function'
        ? {
          getAccountId: (address: string) => chain.getConvictionAgentAccountId!(address),
          getLockDurationEpochs: (accountId: bigint) =>
            chain.getConvictionAccountLockDurationEpochs!(accountId),
          ...(typeof chain.convictionAccountCanCover === 'function'
            ? {
              canCover: (accountId: bigint, baseCost: bigint) =>
                chain.convictionAccountCanCover!(accountId, baseCost),
            }
            : {}),
        }
        : undefined;
    const pricing = await resolveLegacyPublisherCandidatePricing({
      publisherAddress: input.publisherAddress,
      explicitPublishEpochs: input.explicitPublishEpochs,
      defaultPublishEpochs: DEFAULT_PUBLISH_EPOCHS,
      quote,
      conviction,
    });

    if (pricing.source === 'pca') {
      const compatibilityNote = pricing.pca.coverage === 'legacy-unchecked'
        ? ' via the legacy adapter compatibility path (no coverage probe)'
        : '';
      this.dependencies.log.info(
        input.ctx,
        `PCA-funded publish detected (signer=${input.publisherAddress}, ` +
        `accountId=${pricing.pca.accountId})${compatibilityNote} — coercing publishEpochs ` +
        `to lockDurationEpochs=${pricing.publishEpochs}`,
      );
    } else if (pricing.diagnostics.pcaCandidate !== undefined) {
      this.dependencies.log.info(
        input.ctx,
        `Signer ${input.publisherAddress} is a registered PCA agent ` +
        `(accountId=${pricing.diagnostics.pcaCandidate.accountId}) ` +
        `but funding for this publish's discounted cost could not be confirmed — NOT coercing ` +
        `publishEpochs; publishing at requested lifetime=${pricing.publishEpochs} via direct spend`,
      );
    }
    const diagnostics = pricing.diagnostics;
    if ('pcaProbeError' in diagnostics && diagnostics.pcaProbeError !== undefined) {
      this.dependencies.log.warn(
        input.ctx,
        `PCA epochs probe failed — falling back to publishEpochs=${pricing.publishEpochs}: ` +
        `${diagnostics.pcaProbeError instanceof Error
          ? diagnostics.pcaProbeError.message
          : String(diagnostics.pcaProbeError)}`,
      );
    }
    if (diagnostics.quoteError !== undefined) {
      this.dependencies.log.warn(
        input.ctx,
        `getRequiredPublishTokenAmount failed — using explicit legacy protocol minimum ` +
        `${pricing.tokenAmount}: ${diagnostics.quoteError instanceof Error
          ? diagnostics.quoteError.message
          : String(diagnostics.quoteError)}`,
      );
    }
    return {
      publishEpochs: pricing.publishEpochs,
      precomputedTokenAmount: pricing.tokenAmount,
    };
  }

  private async resolveOnChainPublishPlan(input: {
    contextGraphId: bigint;
    initialSigner?: PublisherSigner;
    pinnedPublisherAddress?: string;
    pinnedPublisherLabel?: string;
    explicitPublishEpochs: number | undefined;
    effectiveByteSize: bigint;
    ctx: OperationContext;
  }): Promise<{
    signer: PublisherSigner;
    publisherAddress: string;
    publishEpochs: number;
    tokenAmount: bigint;
  }> {
    const chain = this.dependencies.chain;
    if (typeof chain.resolvePublisherPublishPlan !== 'function') {
      if (!input.initialSigner) throw new PublisherWalletRequiredError('publish');
      const pricing = await this.resolveLegacyPublishPricing({
        publisherAddress: input.initialSigner.address,
        explicitPublishEpochs: input.explicitPublishEpochs,
        effectiveByteSize: input.effectiveByteSize,
        ctx: input.ctx,
      });
      return {
        signer: input.initialSigner,
        publisherAddress: input.initialSigner.address,
        publishEpochs: pricing.publishEpochs,
        tokenAmount: pricing.precomputedTokenAmount,
      };
    }

    const pinnedPublisherAddress = input.pinnedPublisherAddress;
    const pinnedPublisherLabel = input.pinnedPublisherLabel ?? 'publisher address';
    const resolvedPlan = await chain.resolvePublisherPublishPlan({
      contextGraphId: input.contextGraphId,
      effectiveByteSize: input.effectiveByteSize,
      explicitPublishEpochs: input.explicitPublishEpochs,
      defaultPublishEpochs: DEFAULT_PUBLISH_EPOCHS,
      publisherAddress: pinnedPublisherAddress,
    });
    const plannedAddress = coercePublisherAddress(resolvedPlan.publisherAddress);
    if (!plannedAddress) {
      throw new Error('Publisher publish plan returned no valid publisher address.');
    }
    if (
      pinnedPublisherAddress
      && plannedAddress.toLowerCase() !== pinnedPublisherAddress.toLowerCase()
    ) {
      throw new Error(
        `Publisher signer reservation mismatch: ${pinnedPublisherLabel} pins ` +
        `${pinnedPublisherAddress}, but the chain adapter reserved/planned ${plannedAddress}.`,
      );
    }
    const plannedSigner = await this.dependencies.resolvePublisherSigner(plannedAddress);
    if (!plannedSigner || plannedSigner.address.toLowerCase() !== plannedAddress.toLowerCase()) {
      throw new Error(
        `Publisher signer reservation mismatch: no signer for planned address ${plannedAddress}.`,
      );
    }
    return {
      signer: plannedSigner,
      publisherAddress: plannedAddress,
      publishEpochs: resolvedPlan.publishEpochs,
      tokenAmount: resolvedPlan.tokenAmount,
    };
  }

  private async finalizeState(
    state: PublisherPlanningState,
    input: PublisherPlanningFinalizeInput,
  ): Promise<FinalizedPublisherPlan> {
    if (state.kind === 'local') {
      return {
        kind: 'local',
        publisherAddress: state.publisherAddress,
        publishEpochs: input.explicitPublishEpochs ?? DEFAULT_PUBLISH_EPOCHS,
        tokenAmount: 0n,
      };
    }

    const plan = await this.resolveOnChainPublishPlan({
      contextGraphId: state.contextGraphId,
      initialSigner: state.kind === 'legacy-on-chain' ? state.initialSigner : undefined,
      pinnedPublisherAddress: state.selection.planningPin,
      pinnedPublisherLabel: state.selection.planningPinLabel,
      explicitPublishEpochs: input.explicitPublishEpochs,
      effectiveByteSize: input.effectiveByteSize,
      ctx: input.ctx,
    });
    return { kind: 'on-chain', ...plan };
  }

  private isChainV10Ready(): boolean {
    const chain = this.dependencies.chain;
    return chain.chainId !== 'none'
      && typeof chain.isV10Ready === 'function'
      && chain.isV10Ready();
  }

  private async refreshChainV10Readiness(): Promise<boolean> {
    if (this.isChainV10Ready()) return true;
    const chain = this.dependencies.chain;
    if (chain.chainId === 'none') return false;
    try {
      const chainIdGetter = (chain as unknown as { getEvmChainId?: () => Promise<bigint> })
        .getEvmChainId;
      const kavAddressGetter = (chain as unknown as {
        getKnowledgeAssetsLifecycleAddress?: () => Promise<string>;
      }).getKnowledgeAssetsLifecycleAddress;
      if (typeof chainIdGetter === 'function') await chainIdGetter.call(chain);
      if (typeof kavAddressGetter === 'function') await kavAddressGetter.call(chain);
    } catch {
      // V9-only or incompletely configured adapters stay off the V10 path.
    }
    return this.isChainV10Ready();
  }
}
