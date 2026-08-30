// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphRegistryScanCursorKey,
  ContextGraphRegistryScanCursorStore,
} from './chain-adapter.js';

export type ContextGraphRegistryScanCursorLoadResult =
  | { status: 'loaded'; watermark?: number }
  | { status: 'failed'; error: unknown };

/**
 * Durable cursor policy for ContextGraphNameRegistry scans.
 *
 * The cursor is feature-owned rather than generic EVM plumbing: it is scoped by
 * chain, deployment, and registry address, and it intentionally tolerates store
 * failures by falling back to process-local state.
 */
export class ContextGraphRegistryScanCursor {
  private readonly watermarks: Map<string, number> = new Map();
  /** Strict writes retained in memory until the configured store confirms them. */
  private readonly pendingStrictWatermarks: Map<string, number> = new Map();

  constructor(
    private readonly input: {
      chainId: string;
      deploymentId: string;
      store?: ContextGraphRegistryScanCursorStore;
    },
  ) {}

  clearMemoryCache(): void {
    this.watermarks.clear();
    this.pendingStrictWatermarks.clear();
  }

  getCachedWatermark(registryAddress: string): number | undefined {
    return this.normalize(this.watermarks.get(this.cacheKey(registryAddress)));
  }

  async loadWatermark(registryAddress: string): Promise<number | undefined> {
    const result = await this.loadWatermarkResult(registryAddress);
    return result.status === 'loaded' ? result.watermark : undefined;
  }

  async loadWatermarkResult(
    registryAddress: string,
  ): Promise<ContextGraphRegistryScanCursorLoadResult> {
    const cacheKey = this.cacheKey(registryAddress);
    const cached = this.normalize(this.watermarks.get(cacheKey));
    if (cached != null) return { status: 'loaded', watermark: cached };

    if (!this.input.store) return { status: 'loaded' };
    try {
      const persisted = await this.input.store.load(this.cursorKey(cacheKey));
      const normalized = this.normalize(persisted);
      if (normalized != null) {
        this.watermarks.set(cacheKey, normalized);
      }
      return { status: 'loaded', watermark: normalized };
    } catch (err) {
      console.warn(
        `[chain] ContextGraphNameRegistry scan cursor load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { status: 'failed', error: err };
    }
  }

  async saveWatermark(registryAddress: string, nextBlock: number): Promise<void> {
    const normalized = this.normalize(nextBlock);
    if (normalized == null) return;

    const cacheKey = this.cacheKey(registryAddress);
    const existing = this.normalize(this.watermarks.get(cacheKey));
    if (existing != null && existing >= normalized) return;

    this.watermarks.set(cacheKey, normalized);
    if (!this.input.store) return;
    try {
      await this.input.store.save(this.cursorKey(cacheKey), normalized);
    } catch (err) {
      console.warn(
        `[chain] ContextGraphNameRegistry scan cursor save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Save a watermark without hiding configured-store failures.
   *
   * Tip discovery uses this path because its initial lower bound is the durable
   * restart anchor. The attempted value remains process-local after a failure,
   * and a retry of the same value re-attempts persistence before scanning.
   */
  async saveWatermarkStrict(registryAddress: string, nextBlock: number): Promise<void> {
    const normalized = this.normalize(nextBlock);
    if (normalized == null) return;

    const cacheKey = this.cacheKey(registryAddress);
    const existing = this.normalize(this.watermarks.get(cacheKey));
    const pending = this.normalize(this.pendingStrictWatermarks.get(cacheKey));
    if (existing != null && existing >= normalized && pending == null) return;

    const target = Math.max(existing ?? 0, pending ?? 0, normalized);
    this.watermarks.set(cacheKey, target);
    if (!this.input.store) return;

    this.pendingStrictWatermarks.set(cacheKey, target);
    try {
      await this.input.store.save(this.cursorKey(cacheKey), target);
      if (this.pendingStrictWatermarks.get(cacheKey) === target) {
        this.pendingStrictWatermarks.delete(cacheKey);
      }
    } catch (err) {
      console.warn(
        `[chain] ContextGraphNameRegistry scan cursor strict save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
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
}
