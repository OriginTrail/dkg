// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphSub } from './dkg-agent-types.js';

export interface CoreHostedPublicCgRecordTarget {
  localCgId: string;
  existing: ContextGraphSub | undefined;
}

/**
 * Resolves the durable local identity for a hosted public Context Graph and
 * owns the persist-once decision around the asynchronous chain-policy read.
 */
export class CoreHostedPublicCgRecordDecision {
  readonly #onChainId: bigint;
  readonly #onChainIdString: string;
  readonly #cleartextHint: string | undefined;
  readonly #subscriptions: ReadonlyMap<string, ContextGraphSub>;
  readonly #resolveMappedLocalId: (onChainId: bigint) => string | undefined;

  constructor(input: {
    onChainId: bigint;
    swmGraphId?: string;
    subscriptions: ReadonlyMap<string, ContextGraphSub>;
    resolveMappedLocalId: (onChainId: bigint) => string | undefined;
  }) {
    this.#onChainId = input.onChainId;
    this.#onChainIdString = input.onChainId.toString();
    // An all-numeric local Context Graph id is still a valid cleartext hint.
    // Only the empty string and the on-chain id itself carry no information.
    this.#cleartextHint = input.swmGraphId && input.swmGraphId !== this.#onChainIdString
      ? input.swmGraphId
      : undefined;
    this.#subscriptions = input.subscriptions;
    this.#resolveMappedLocalId = input.resolveMappedLocalId;
  }

  resolveLocalId(): string {
    return this.#resolveMappedLocalId(this.#onChainId)
      ?? this.#cleartextHint
      ?? this.#onChainIdString;
  }

  isAlreadyRecorded(): boolean {
    const row = this.#subscriptions.get(this.resolveLocalId());
    return row?.coreHosted === true && row.onChainId === this.#onChainIdString;
  }

  recordIfNeeded(persist: (target: CoreHostedPublicCgRecordTarget) => void): string | undefined {
    const localCgId = this.resolveLocalId();
    const existing = this.#subscriptions.get(localCgId);
    if (existing?.coreHosted === true && existing.onChainId === this.#onChainIdString) {
      return undefined;
    }
    persist({ localCgId, existing });
    return localCgId;
  }
}
