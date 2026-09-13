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

const REPAIR_COMPLETION_MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type ContextGraphRegistryWatermarkScanOwner = symbol;

export class ContextGraphRegistryScanCursor {
  private readonly watermarks: Map<string, number> = new Map();
  private readonly repairAudits: Map<string, ContextGraphRegistryRepairAuditCheckpoint> = new Map();
  private readonly activeWatermarkOwners: Map<string, ContextGraphRegistryWatermarkScanOwner> = new Map();

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
    // Closing the adapter invalidates every outstanding page acknowledgement.
    // A late ACK must never mutate a cursor after its owning scan was drained.
    this.activeWatermarkOwners.clear();
  }

  beginWatermarkScan(registryAddress: string): ContextGraphRegistryWatermarkScanOwner | undefined {
    const cacheKey = this.cacheKey(registryAddress);
    if (this.activeWatermarkOwners.has(cacheKey)) return undefined;
    const owner = Symbol(`context-graph-registry-watermark:${cacheKey}`);
    this.activeWatermarkOwners.set(cacheKey, owner);
    return owner;
  }

  closeWatermarkScan(
    registryAddress: string,
    owner: ContextGraphRegistryWatermarkScanOwner,
  ): void {
    const cacheKey = this.cacheKey(registryAddress);
    if (this.activeWatermarkOwners.get(cacheKey) === owner) {
      this.activeWatermarkOwners.delete(cacheKey);
    }
  }

  getCachedWatermark(registryAddress: string): number | undefined {
    return this.normalize(this.watermarks.get(this.cacheKey(registryAddress)));
  }

  hasDurableRepairAuditStore(): boolean {
    const repairAudit = this.input.store?.repairAudit;
    return typeof repairAudit?.load === 'function'
      && typeof repairAudit?.save === 'function';
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

  async saveWatermark(
    registryAddress: string,
    nextBlock: number,
    options: {
      owner?: ContextGraphRegistryWatermarkScanOwner;
      /** Authoritative rollback recovery; ordinary cursor saves stay monotonic. */
      replace?: boolean;
    } = {},
  ): Promise<void> {
    const normalized = this.normalize(nextBlock);
    if (normalized == null) return;

    const cacheKey = this.cacheKey(registryAddress);
    if (
      options.owner !== undefined
      && this.activeWatermarkOwners.get(cacheKey) !== options.owner
    ) {
      throw new Error('ContextGraphNameRegistry scan acknowledgement is stale or no longer owned');
    }
    const existing = this.normalize(this.watermarks.get(cacheKey));
    if (!options.replace && existing != null && existing >= normalized) return;

    if (this.input.store) {
      await this.input.store.save(this.cursorKey(cacheKey), normalized);
    }
    this.watermarks.set(cacheKey, normalized);
  }

  async loadRepairAudit(
    registryAddress: string,
  ): Promise<ContextGraphRegistryRepairAuditCheckpoint | undefined> {
    if (!this.hasDurableRepairAuditStore()) {
      throw new Error(
        'ContextGraphNameRegistry repair requires a durable repairAudit load/save capability',
      );
    }
    const cacheKey = this.cacheKey(registryAddress);
    const cached = this.repairAudits.get(cacheKey);
    if (cached) return cached;
    const repairAudit = this.input.store!.repairAudit!;
    const checkpoint = this.normalizeRepairAudit(await repairAudit.load(this.cursorKey(cacheKey)));
    if (checkpoint) this.repairAudits.set(cacheKey, checkpoint);
    return checkpoint;
  }

  async saveRepairAudit(
    registryAddress: string,
    checkpoint: ContextGraphRegistryRepairAuditCheckpoint,
  ): Promise<void> {
    if (!this.hasDurableRepairAuditStore()) {
      throw new Error(
        'ContextGraphNameRegistry repair requires a durable repairAudit load/save capability',
      );
    }
    const normalized = this.normalizeRepairAudit(checkpoint);
    if (!normalized) throw new Error('ContextGraphNameRegistry repair checkpoint is invalid');
    const cacheKey = this.cacheKey(registryAddress);
    await this.input.store!.repairAudit!.save(this.cursorKey(cacheKey), normalized);
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
    const now = Date.now();
    if (
      candidate.version !== 1
      || nextBlock === undefined
      || targetBlock === undefined
      || startedAt === undefined
      || (candidate.completedAt !== undefined && completedAt === undefined)
    ) return undefined;
    // Both timestamps share one bounded clock-skew policy. Accepting a
    // far-future incomplete start would make every legal completion precede
    // it and permanently strand that repair generation.
    if (
      startedAt > now + REPAIR_COMPLETION_MAX_CLOCK_SKEW_MS
      || (completedAt === undefined && startedAt > now)
    ) return undefined;
    const completedNextBlock = targetBlock + 1;
    if (!Number.isSafeInteger(completedNextBlock)) return undefined;
    if (completedAt === undefined) {
      if (nextBlock > targetBlock) return undefined;
    } else {
      if (nextBlock !== completedNextBlock || completedAt < startedAt) return undefined;
      // A corrupt/far-future completion must not suppress repair forever. Small
      // wall-clock skew is accepted, adding at most this bounded allowance.
      if (completedAt > now + REPAIR_COMPLETION_MAX_CLOCK_SKEW_MS) return undefined;
    }
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
