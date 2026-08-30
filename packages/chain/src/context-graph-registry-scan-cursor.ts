// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphRegistryScanCursorKey,
  ContextGraphRegistryScanCursorStore,
  ContextGraphRegistryRoleAwareScanCursorKey,
  ContextGraphRegistryRoleAwareScanCursorStore,
} from './chain-adapter.js';

export type ContextGraphRegistryScanCursorStoreBinding =
  | { kind: 'legacy'; store: ContextGraphRegistryScanCursorStore }
  | { kind: 'roleAware'; store: ContextGraphRegistryRoleAwareScanCursorStore };

/**
 * Durable cursor policy for ContextGraphNameRegistry scans.
 *
 * The cursor is feature-owned rather than generic EVM plumbing: it is scoped by
 * chain, deployment, and registry address, and it intentionally tolerates store
 * failures by falling back to process-local state.
 */
export class ContextGraphRegistryScanCursor {
  private readonly watermarks: Map<string, number> = new Map();

  constructor(
    private readonly input: {
      chainId: string;
      deploymentId: string;
      cursorKind: ContextGraphRegistryRoleAwareScanCursorKey['cursorKind'];
      store?: ContextGraphRegistryScanCursorStoreBinding;
    },
  ) {}

  clearMemoryCache(): void {
    this.watermarks.clear();
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
      const persisted = this.input.store.kind === 'roleAware'
        ? await this.input.store.store.load(this.roleAwareCursorKey(cacheKey))
        : await this.input.store.store.load(this.legacyCursorKey(cacheKey));
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

    this.watermarks.set(cacheKey, normalized);
    if (!this.input.store) return;
    try {
      if (this.input.store.kind === 'roleAware') {
        await this.input.store.store.save(this.roleAwareCursorKey(cacheKey), normalized);
      } else {
        await this.input.store.store.save(this.legacyCursorKey(cacheKey), normalized);
      }
    } catch (err) {
      console.warn(
        `[chain] ContextGraphNameRegistry scan cursor save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private cacheKey(registryAddress: string): string {
    return registryAddress.toLowerCase();
  }

  private legacyCursorKey(registryAddress: string): ContextGraphRegistryScanCursorKey {
    return {
      chainId: this.input.chainId,
      deploymentId: this.input.deploymentId,
      registryAddress,
    };
  }

  private roleAwareCursorKey(registryAddress: string): ContextGraphRegistryRoleAwareScanCursorKey {
    return {
      ...this.legacyCursorKey(registryAddress),
      cursorKind: this.input.cursorKind,
    };
  }

  private normalize(value: number | undefined): number | undefined {
    if (value == null) return undefined;
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    return value;
  }
}
