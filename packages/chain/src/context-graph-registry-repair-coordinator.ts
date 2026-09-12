// SPDX-License-Identifier: Apache-2.0

import {
  ContextGraphRegistryScanCursor,
  type ContextGraphRegistryRepairAuditCheckpoint,
} from './context-graph-registry-scan-cursor.js';

type RepairRange = {
  fromBlock: number;
  head: number;
};

export interface ContextGraphRegistryRepairSession<T extends RepairRange> {
  readonly range: T;
  readonly startBlock: number;
  readonly targetBlock: number;
  acknowledge(toBlock: number): Promise<void>;
  close(): void;
}

/**
 * Owns the historical repair generation independently from live discovery.
 * The adapter supplies chain-range probes and a raw page reader; this class
 * owns cadence, mutual exclusion, the immutable target, and atomic progress.
 */
export class ContextGraphRegistryRepairCoordinator {
  private active = false;

  constructor(
    private readonly cursor: ContextGraphRegistryScanCursor,
    private readonly reorgBufferBlocks: number,
  ) {}

  async begin<T extends RepairRange>(input: {
    registryAddress: string;
    minimumIntervalMs: number;
    resolveHead(): Promise<Omit<T, 'fromBlock'>>;
    resolveDeployment(): Promise<T>;
  }): Promise<ContextGraphRegistryRepairSession<T> | undefined> {
    if (this.active) return undefined;
    this.active = true;
    try {
      const now = Date.now();
      let checkpoint = await this.cursor.loadRepairAudit(input.registryAddress);
      if (
        checkpoint?.completedAt !== undefined
        && now - checkpoint.completedAt < input.minimumIntervalMs
      ) {
        this.active = false;
        return undefined;
      }

      const discoveredRange = checkpoint?.completedAt === undefined && checkpoint !== undefined
        ? {
            fromBlock: checkpoint.nextBlock,
            ...(await input.resolveHead()),
          } as T
        : await input.resolveDeployment();
      const stableHead = discoveredRange.head - this.reorgBufferBlocks;
      if (stableHead < discoveredRange.fromBlock) {
        this.active = false;
        return undefined;
      }

      if (!checkpoint || checkpoint.completedAt !== undefined) {
        checkpoint = Object.freeze({
          version: 1,
          nextBlock: discoveredRange.fromBlock,
          targetBlock: stableHead,
          startedAt: now,
        });
        await this.cursor.saveRepairAudit(input.registryAddress, checkpoint);
      }

      const range = {
        ...discoveredRange,
        head: Math.min(checkpoint.targetBlock, stableHead),
      } as T;
      let activeCheckpoint: ContextGraphRegistryRepairAuditCheckpoint = checkpoint;
      let closed = false;
      return {
        range,
        startBlock: checkpoint.nextBlock,
        targetBlock: checkpoint.targetBlock,
        acknowledge: async (toBlock: number): Promise<void> => {
          const completesGeneration = toBlock >= activeCheckpoint.targetBlock;
          const advanced = Object.freeze({
            ...activeCheckpoint,
            nextBlock: toBlock + 1,
            ...(completesGeneration ? { completedAt: Date.now() } : {}),
          });
          await this.cursor.saveRepairAudit(input.registryAddress, advanced);
          activeCheckpoint = advanced;
        },
        close: (): void => {
          if (closed) return;
          closed = true;
          this.active = false;
        },
      };
    } catch (error) {
      this.active = false;
      throw error;
    }
  }
}
