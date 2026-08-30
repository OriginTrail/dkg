// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphRegistryScanCursorKey,
  ContextGraphRegistryScanCursorStore,
} from './chain-adapter.js';

export type ContextGraphRegistryScanCursorLoadResult =
  | { status: 'loaded'; watermark?: number }
  | { status: 'failed'; error: unknown };

type CursorInput = {
  chainId: string;
  deploymentId: string;
  store?: ContextGraphRegistryScanCursorStore;
};

abstract class ContextGraphRegistryScanCursorBase {
  private readonly watermarks: Map<string, number> = new Map();

  constructor(protected readonly input: CursorInput) {}

  getCachedWatermark(registryAddress: string): number | undefined {
    const cacheKey = this.cacheKey(registryAddress);
    return this.normalize(this.watermarks.get(cacheKey))
      ?? this.pendingWatermark(cacheKey);
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
    const pending = this.pendingWatermark(cacheKey);
    if (pending != null) return { status: 'loaded', watermark: pending };

    if (!this.input.store) return { status: 'loaded' };
    try {
      const persisted = await this.input.store.load(this.cursorKey(cacheKey));
      const normalized = this.normalize(persisted);
      if (normalized != null) this.watermarks.set(cacheKey, normalized);
      return { status: 'loaded', watermark: normalized };
    } catch (err) {
      console.warn(
        `[chain] ContextGraphNameRegistry scan cursor load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { status: 'failed', error: err };
    }
  }

  protected clearCachedWatermarks(): void {
    this.watermarks.clear();
  }

  protected cachedWatermark(cacheKey: string): number | undefined {
    return this.normalize(this.watermarks.get(cacheKey));
  }

  protected rememberWatermark(cacheKey: string, nextBlock: number): void {
    this.watermarks.set(cacheKey, nextBlock);
  }

  protected pendingWatermark(_cacheKey: string): number | undefined {
    return undefined;
  }

  protected cacheKey(registryAddress: string): string {
    return registryAddress.toLowerCase();
  }

  protected cursorKey(registryAddress: string): ContextGraphRegistryScanCursorKey {
    return {
      chainId: this.input.chainId,
      deploymentId: this.input.deploymentId,
      registryAddress,
    };
  }

  protected normalize(value: number | undefined): number | undefined {
    if (value == null) return undefined;
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    return value;
  }
}

/** Historical scan cursor with an explicit best-effort persistence contract. */
export class ContextGraphRegistryHistoricalScanCursor
  extends ContextGraphRegistryScanCursorBase {
  clearMemoryCache(): void {
    this.clearCachedWatermarks();
  }

  async saveBestEffortWatermark(registryAddress: string, nextBlock: number): Promise<void> {
    const normalized = this.normalize(nextBlock);
    if (normalized == null) return;

    const cacheKey = this.cacheKey(registryAddress);
    const existing = this.cachedWatermark(cacheKey);
    if (existing != null && existing >= normalized) return;

    this.rememberWatermark(cacheKey, normalized);
    if (!this.input.store) return;
    try {
      await this.input.store.save(this.cursorKey(cacheKey), normalized);
    } catch (err) {
      console.warn(
        `[chain] ContextGraphNameRegistry scan cursor save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Tip scan cursor with an explicit fail-closed persistence contract. */
export class ContextGraphRegistryTipScanCursor extends ContextGraphRegistryScanCursorBase {
  /** Failed strict writes remain safety anchors until the store confirms them. */
  private readonly pendingStrictWatermarks: Map<string, number> = new Map();

  protected override pendingWatermark(cacheKey: string): number | undefined {
    return this.normalize(this.pendingStrictWatermarks.get(cacheKey));
  }

  async saveStrictWatermark(registryAddress: string, nextBlock: number): Promise<void> {
    const normalized = this.normalize(nextBlock);
    if (normalized == null) return;

    const cacheKey = this.cacheKey(registryAddress);
    const existing = this.cachedWatermark(cacheKey);
    const pending = this.pendingWatermark(cacheKey);
    if (existing != null && existing >= normalized && pending == null) return;

    const target = Math.max(existing ?? 0, pending ?? 0, normalized);
    this.rememberWatermark(cacheKey, target);
    if (!this.input.store) return;

    this.pendingStrictWatermarks.set(cacheKey, target);
    try {
      await this.input.store.save(this.cursorKey(cacheKey), target);
      if (this.pendingStrictWatermarks.get(cacheKey) === target) {
        this.pendingStrictWatermarks.delete(cacheKey);
      }
    } catch (err) {
      console.warn(
        `[chain] ContextGraphNameRegistry tip cursor save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
}
