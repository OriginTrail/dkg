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
  acknowledge(fromBlock: number, toBlock: number): Promise<void>;
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
    signal?: AbortSignal;
    resolveHead(): Promise<Omit<T, 'fromBlock'>>;
    resolveDeployment(): Promise<T>;
  }): Promise<ContextGraphRegistryRepairSession<T> | undefined> {
    if (this.active) return undefined;
    this.active = true;
    try {
      input.signal?.throwIfAborted();
      const now = Date.now();
      let checkpoint = await this.cursor.loadRepairAudit(input.registryAddress);
      if (
        checkpoint?.completedAt !== undefined
        && now - checkpoint.completedAt < input.minimumIntervalMs
      ) {
        this.active = false;
        return undefined;
      }

      input.signal?.throwIfAborted();
      let discoveredRange: T;
      let stableHead: number;
      if (checkpoint?.completedAt === undefined && checkpoint !== undefined) {
        const head = await input.resolveHead();
        input.signal?.throwIfAborted();
        stableHead = head.head - this.reorgBufferBlocks;
        if (
          checkpoint.targetBlock > stableHead + this.reorgBufferBlocks
          || checkpoint.nextBlock > stableHead + this.reorgBufferBlocks
        ) {
          // The old generation was anchored to a chain tip that is no longer
          // inside the protected stable range. Waiting for that target can
          // strand repair forever after an authoritative rollback. Replace it
          // store-first with a fresh deploy-anchored generation; the live lane
          // remains independent and continues to protect recent registrations.
          discoveredRange = await input.resolveDeployment();
          input.signal?.throwIfAborted();
          stableHead = discoveredRange.head - this.reorgBufferBlocks;
          if (stableHead < discoveredRange.fromBlock) {
            throw new Error(
              'ContextGraphNameRegistry repair checkpoint is ahead of the current stable chain, '
              + 'and no deploy-anchored stable range is available for replacement',
            );
          }
          checkpoint = Object.freeze({
            version: 1,
            nextBlock: discoveredRange.fromBlock,
            targetBlock: stableHead,
            startedAt: now,
          });
          await this.cursor.saveRepairAudit(input.registryAddress, checkpoint);
        } else {
          discoveredRange = {
            fromBlock: checkpoint.nextBlock,
            ...head,
          } as T;
        }
      } else {
        discoveredRange = await input.resolveDeployment();
        input.signal?.throwIfAborted();
        stableHead = discoveredRange.head - this.reorgBufferBlocks;
      }
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
      let acknowledgementInFlight = false;
      let acknowledgementFailed = false;
      return {
        range,
        startBlock: checkpoint.nextBlock,
        targetBlock: checkpoint.targetBlock,
        acknowledge: async (fromBlock: number, toBlock: number): Promise<void> => {
          if (closed) {
            throw new Error('ContextGraphNameRegistry repair acknowledgement is stale');
          }
          if (acknowledgementInFlight || acknowledgementFailed) {
            throw new Error('ContextGraphNameRegistry repair acknowledgement is concurrent or already failed');
          }
          if (
            fromBlock !== activeCheckpoint.nextBlock
            || toBlock < fromBlock
            || toBlock > activeCheckpoint.targetBlock
          ) {
            throw new Error(
              `ContextGraphNameRegistry repair acknowledgement is not the next contiguous range: `
              + `expected fromBlock ${activeCheckpoint.nextBlock}, received [${fromBlock}, ${toBlock}]`,
            );
          }
          acknowledgementInFlight = true;
          const completesGeneration = toBlock === activeCheckpoint.targetBlock;
          const advanced = Object.freeze({
            ...activeCheckpoint,
            nextBlock: toBlock + 1,
            ...(completesGeneration ? { completedAt: Date.now() } : {}),
          });
          try {
            input.signal?.throwIfAborted();
            await this.cursor.saveRepairAudit(input.registryAddress, advanced);
            activeCheckpoint = advanced;
          } catch (error) {
            acknowledgementFailed = true;
            throw error;
          } finally {
            acknowledgementInFlight = false;
          }
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
