// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphRegistryScanCursorKey,
  ContextGraphRegistryScanCursorStore,
} from './chain-adapter.js';

type CursorInput = {
  chainId: string;
  deploymentId: string;
  store?: ContextGraphRegistryScanCursorStore;
};

interface CursorState {
  cached?: number;
  pending?: number;
  persisting?: Promise<void>;
}

abstract class ContextGraphRegistryScanCursorBase {
  private readonly states: Map<string, CursorState> = new Map();

  constructor(protected readonly input: CursorInput) {}

  getCachedWatermark(registryAddress: string): number | undefined {
    const cacheKey = this.cacheKey(registryAddress);
    const state = this.cursorState(cacheKey);
    const cached = this.normalize(state.cached);
    const pending = this.normalize(state.pending);
    return cached === undefined ? pending : Math.max(cached, pending ?? 0);
  }

  protected async loadStoredWatermark(registryAddress: string): Promise<number | undefined> {
    const cacheKey = this.cacheKey(registryAddress);
    const state = this.cursorState(cacheKey);
    const cached = this.normalize(state.cached);
    if (cached != null) return cached;
    const pending = this.normalize(state.pending);
    if (pending != null) return pending;

    if (!this.input.store) return undefined;
    const persisted = await this.input.store.load(this.cursorKey(cacheKey));
    const normalized = this.normalize(persisted);
    if (persisted !== undefined && normalized === undefined) {
      throw new Error(
        `invalid persisted registry scan cursor: expected a positive safe integer, got ${String(persisted)}`,
      );
    }
    if (normalized != null) state.cached = normalized;
    return normalized;
  }

  protected clearCachedWatermarks(): void {
    this.states.clear();
  }

  protected cachedWatermark(cacheKey: string): number | undefined {
    return this.normalize(this.cursorState(cacheKey).cached);
  }

  protected rememberWatermark(cacheKey: string, nextBlock: number): void {
    this.cursorState(cacheKey).cached = nextBlock;
  }

  protected cursorState(cacheKey: string): CursorState {
    let state = this.states.get(cacheKey);
    if (!state) {
      state = {};
      this.states.set(cacheKey, state);
    }
    return state;
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
  async loadBestEffortWatermark(registryAddress: string): Promise<number | undefined> {
    try {
      return await this.loadStoredWatermark(registryAddress);
    } catch (err) {
      console.warn(
        `[chain] ContextGraphNameRegistry scan cursor load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

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
  async loadStrictWatermark(registryAddress: string): Promise<number | undefined> {
    try {
      return await this.loadStoredWatermark(registryAddress);
    } catch (err) {
      console.warn(
        `[chain] ContextGraphNameRegistry tip cursor load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new Error(
        'listContextGraphsFromChain: tip cursor load failed; refusing to initialize from ' +
          'the current head because persisted progress may exist',
        { cause: err },
      );
    }
  }

  async saveStrictWatermark(registryAddress: string, nextBlock: number): Promise<void> {
    const normalized = this.normalize(nextBlock);
    if (normalized == null) return;

    const cacheKey = this.cacheKey(registryAddress);
    const state = this.cursorState(cacheKey);
    const existing = this.normalize(state.cached);
    const pending = this.normalize(state.pending);
    if (existing != null && existing >= normalized && pending == null) {
      await state.persisting;
      return;
    }

    const target = Math.max(existing ?? 0, pending ?? 0, normalized);
    state.cached = target;
    if (!this.input.store) return;

    state.pending = target;
    if (!state.persisting) {
      const persist = (async () => {
        while (state.pending !== undefined) {
          const next = state.pending;
          await this.input.store!.save(this.cursorKey(cacheKey), next);
          if (state.pending === next) state.pending = undefined;
        }
      })().finally(() => {
        if (state.persisting === persist) state.persisting = undefined;
      });
      state.persisting = persist;
    }
    try {
      await state.persisting;
    } catch (err) {
      if (state.pending === undefined) {
        state.pending = target;
      }
      console.warn(
        `[chain] ContextGraphNameRegistry tip cursor save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
}
