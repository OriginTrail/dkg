// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphRegistryScanCursorKey,
  ContextGraphRegistryScanCursorStore,
} from './chain-adapter.js';

/**
 * Durable cursor policy for ContextGraphNameRegistry scans.
 *
 * The cursor is feature-owned rather than generic EVM plumbing: it is scoped by
 * chain, deployment, and registry address. Cursor saves are store-first and
 * fail closed: callers must never acknowledge a page whose durable cursor did
 * not advance, nor advance process-local state past durable state.
 */
export interface ContextGraphRegistryRepairAuditCheckpoint {
  readonly version: 1;
  readonly nextBlock: number;
  readonly targetBlock: number;
  readonly startedAt: number;
  readonly completedAt?: number;
}

export class ContextGraphRegistryScanCursor {
  private readonly watermarks: Map<string, number> = new Map();
  private readonly repairAudits: Map<string, ContextGraphRegistryRepairAuditCheckpoint> = new Map();

  constructor(
    private readonly input: {
      chainId: string;
      deploymentId: string;
      store?: ContextGraphRegistryScanCursorStore;
    },
  ) {}

  clearMemoryCache(): void {
    this.watermarks.clear();
    this.repairAudits.clear();
  }

  getCachedWatermark(registryAddress: string): number | undefined {
    return this.normalize(this.watermarks.get(this.cacheKey(registryAddress)));
  }

  async loadWatermark(registryAddress: string): Promise<number | undefined> {
    const cacheKey = this.cacheKey(registryAddress);
    const cached = this.normalize(this.watermarks.get(cacheKey));
    if (cached != null) return cached;

    if (!this.input.store) return undefined;
    try {
      const persisted = await this.input.store.load(this.cursorKey(cacheKey));
      const normalized = this.normalize(persisted);
      if (normalized != null) {
        this.watermarks.set(cacheKey, normalized);
      }
      return normalized;
    } catch (err) {
      console.warn(
        `[chain] ContextGraphNameRegistry scan cursor load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  async saveWatermark(registryAddress: string, nextBlock: number): Promise<void> {
    const normalized = this.normalize(nextBlock);
    if (normalized == null) return;

    const cacheKey = this.cacheKey(registryAddress);
    const existing = this.normalize(this.watermarks.get(cacheKey));
    if (existing != null && existing >= normalized) return;

    if (this.input.store) {
      await this.input.store.save(this.cursorKey(cacheKey), normalized);
    }
    this.watermarks.set(cacheKey, normalized);
  }

  async loadRepairAudit(
    registryAddress: string,
  ): Promise<ContextGraphRegistryRepairAuditCheckpoint | undefined> {
    const cacheKey = this.cacheKey(registryAddress);
    const cached = this.repairAudits.get(cacheKey);
    if (cached) return cached;
    const load = this.input.store?.loadRepairAudit;
    if (!load) return undefined;
    const checkpoint = this.normalizeRepairAudit(await load.call(this.input.store, this.cursorKey(cacheKey)));
    if (checkpoint) this.repairAudits.set(cacheKey, checkpoint);
    return checkpoint;
  }

  async saveRepairAudit(
    registryAddress: string,
    checkpoint: ContextGraphRegistryRepairAuditCheckpoint,
  ): Promise<void> {
    const normalized = this.normalizeRepairAudit(checkpoint);
    if (!normalized) throw new Error('ContextGraphNameRegistry repair checkpoint is invalid');
    const cacheKey = this.cacheKey(registryAddress);
    const save = this.input.store?.saveRepairAudit;
    if (save) {
      await save.call(this.input.store, this.cursorKey(cacheKey), normalized);
    }
    this.repairAudits.set(cacheKey, normalized);
  }

  private cacheKey(registryAddress: string): string {
    return registryAddress.toLowerCase();
  }

  private cursorKey(registryAddress: string): ContextGraphRegistryScanCursorKey {
    return {
      chainId: this.input.chainId,
      deploymentId: this.input.deploymentId,
      registryAddress,
    };
  }

  private normalize(value: number | undefined): number | undefined {
    if (value == null) return undefined;
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    return value;
  }

  private normalizeRepairAudit(value: unknown): ContextGraphRegistryRepairAuditCheckpoint | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Partial<ContextGraphRegistryRepairAuditCheckpoint>;
    const nextBlock = this.normalizeBlock(candidate.nextBlock);
    const targetBlock = this.normalizeBlock(candidate.targetBlock);
    const startedAt = this.normalize(candidate.startedAt);
    const completedAt = candidate.completedAt === undefined
      ? undefined
      : this.normalize(candidate.completedAt);
    if (
      candidate.version !== 1
      || nextBlock === undefined
      || targetBlock === undefined
      || startedAt === undefined
      || (candidate.completedAt !== undefined && completedAt === undefined)
    ) return undefined;
    return Object.freeze({
      version: 1,
      nextBlock,
      targetBlock,
      startedAt,
      ...(completedAt !== undefined ? { completedAt } : {}),
    });
  }

  private normalizeBlock(value: number | undefined): number | undefined {
    if (value == null) return undefined;
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
}
