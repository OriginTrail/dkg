// SPDX-License-Identifier: Apache-2.0

/** Bounded current-state reverse lookup over ContextGraphStorage name-hash slots. */

import { ethers } from 'ethers';

import {
  CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY,
  ContextGraphNameHashSlotIndex,
  type ContextGraphNameHashSlot,
  type ContextGraphNameHashSlotIndexResult,
} from './context-graph-name-hash-resolver.js';
import type {
  ContextGraphNameHashProviderHighWaters,
  EvmContextGraphNameHashReader,
} from './evm-context-graph-name-hash-fence.js';

export interface EvmContextGraphNameHashCurrentSlotResolverDependencies {
  readonly onIndexCommit: () => void;
}

export class EvmContextGraphNameHashCurrentSlotResolver {
  private readonly slotIndex = new ContextGraphNameHashSlotIndex();

  constructor(
    private readonly reader: EvmContextGraphNameHashReader,
    private readonly dependencies: EvmContextGraphNameHashCurrentSlotResolverDependencies,
  ) {}

  clear(): void {
    this.slotIndex.clear();
  }

  async resolve(normalizedNameHash: string): Promise<ContextGraphNameHashSlotIndexResult> {
    await this.reader.initialize();
    const scopeToken = await this.reader.captureScopeToken();
    const result = await this.slotIndex.resolve(
      normalizedNameHash,
      {
        captureScope: () => this.reader.captureScope(),
        captureAnchor: () => this.reader.captureAnchor(),
        loadAnchorHash: (blockNumber) => this.reader.loadAnchorHash(blockNumber),
        loadHighWaterSnapshot: () => this.reader.loadProviderHighWaters(),
        loadRange: (firstId, lastId, snapshot) =>
          this.loadSlots(firstId, lastId, snapshot),
        onCommit: this.dependencies.onIndexCommit,
      },
    );
    if (result.mode === 'historical') return result;

    const verification = await this.reader.loadProviderHighWaters();
    if (verification.latestId !== result.highWater) {
      throw new Error(
        `resolveContextGraphIdByNameHash: Context Graph registry advanced from ` +
        `${result.highWater.toString()} to ${verification.latestId.toString()} ` +
        'during current-slot resolution',
      );
    }
    if (result.id !== null) {
      const currentHash = await this.reader.readCurrentNameHash(
        result.id,
        undefined,
        verification.providerHighWaters,
      );
      if (currentHash !== normalizedNameHash) {
        throw new Error(
          `resolveContextGraphIdByNameHash: indexed slot ${result.id.toString()} ` +
          `currently commits ${currentHash ?? ethers.ZeroHash}, expected ` +
          normalizedNameHash,
        );
      }
    }

    await this.reader.assertScopeCurrent(scopeToken, 'current-slot resolution');
    return result;
  }

  /** Fixed-concurrency staged range loader for the bounded current lane. */
  private async loadSlots(
    firstId: bigint,
    lastId: bigint,
    highWaterSnapshot: ContextGraphNameHashProviderHighWaters,
  ): Promise<readonly ContextGraphNameHashSlot[]> {
    const scanController = new AbortController();
    const slots: ContextGraphNameHashSlot[] = [];
    let nextId = firstId;
    let failed = false;
    let firstFailure: unknown;
    const worker = async (): Promise<void> => {
      while (!failed) {
        const contextGraphId = nextId;
        if (contextGraphId > lastId) return;
        nextId += 1n;
        try {
          const currentHash = await this.reader.readCurrentNameHash(
            contextGraphId,
            scanController.signal,
            highWaterSnapshot.providerHighWaters,
          );
          slots.push({ id: contextGraphId, nameHash: currentHash });
        } catch (cause) {
          if (!failed) {
            failed = true;
            firstFailure = cause;
            scanController.abort(cause);
          }
          return;
        }
      }
    };

    const workerCount = Math.min(
      CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY,
      Number(lastId - firstId + 1n),
    );
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (failed) throw firstFailure;
    return slots;
  }
}
