import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeAssetReadModel } from '../src/chain-index/knowledge-asset-read-model.js';
import type { ChainEventLogBinding } from '../src/chain-event-log-binding.js';
import { normalizeKnowledgeAssetReadModel } from '../src/chain-index/normalize-knowledge-asset-read-model.js';
import { knowledgeAssetReaderForBinding } from '../src/chain-event-log-reader.js';
import { createChainEventLogSubscription } from '../src/chain-index/chain-event-log-subscription.js';
import { ChainEventDecoderRegistry } from '../src/chain-index/chain-event-decoders.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

describe('legacy knowledge-asset model normalization', () => {
  it('preserves native scalar identity and refusal without consulting its list port', async () => {
    const model = {
      readContextGraphForKa: vi.fn(async () => undefined),
      readContextGraphKaList: vi.fn(async () => { throw new Error('unexpected list read'); }),
      readContextGraphKaAt: vi.fn(async () => undefined),
    };
    const normalized = normalizeKnowledgeAssetReadModel(model);
    expect(normalized).toBe(model);
    await expect(normalized.readContextGraphKaAt(7n, 0n)).resolves.toBeUndefined();
    expect(model.readContextGraphKaList).not.toHaveBeenCalled();
  });

  it('forwards legacy options and refusal while retaining list horizon in scalar answers', async () => {
    const options = { view: 'latest' as const, signal: new AbortController().signal };
    const model: KnowledgeAssetReadModel = {
      readContextGraphForKa: vi.fn(async () => undefined),
      readContextGraphKaList: vi.fn(async () => ({ contextGraphId: 7n, kaIds: [42n], throughBlockNumber: 100 })),
    };
    const normalized = normalizeKnowledgeAssetReadModel(model);
    await expect(normalized.readContextGraphKaAt(7n, 0n, options))
      .resolves.toEqual({ kaId: 42n, asOfBlockNumber: 100 });
    expect(model.readContextGraphKaList).toHaveBeenCalledExactlyOnceWith(7n, options);
    await expect(normalized.readContextGraphKaAt(7n, -1n, options)).resolves.toBeUndefined();
    expect(model.readContextGraphKaList).toHaveBeenCalledOnce();
    vi.mocked(model.readContextGraphKaList).mockResolvedValueOnce(undefined);
    await expect(normalized.readContextGraphKaAt(7n, 0n, options)).resolves.toBeUndefined();
  });

  it('keeps borrowed legacy generations stable without changing native bindings or method receivers', async () => {
    const subscription = createChainEventLogSubscription({
      scope: 'scope', store: new MemoryChainEventLogStore(), registry: new ChainEventDecoderRegistry(),
    });
    const model: KnowledgeAssetReadModel = {
      async readContextGraphForKa() { return undefined; },
      async readContextGraphKaList() { return undefined; },
    };
    const readEventScanLease = vi.fn(async function (this: ChainEventLogBinding) {
      expect(this).toBe(binding);
      return undefined;
    });
    const readHubRotationWindow = vi.fn(async function (this: ChainEventLogBinding) {
      expect(this).toBe(binding);
      return undefined;
    });
    class LegacyBinding implements ChainEventLogBinding {
      readonly #scope = 'scope';
      get scope() { return this.#scope; }
      get subscription() { return subscription; }
      get knowledgeAssets() { return model; }
      get readEventScanLease() { return readEventScanLease; }
      get readHubRotationWindow() { return readHubRotationWindow; }
    }
    const binding: ChainEventLogBinding = Object.freeze(new LegacyBinding());
    const normalized = knowledgeAssetReaderForBinding(binding)!;
    expect(knowledgeAssetReaderForBinding(binding)).toBe(normalized);
    expect(knowledgeAssetReaderForBinding(new LegacyBinding())).not.toBe(normalized);
    expect(binding.scope).toBe('scope');
    expect(binding.subscription).toBe(subscription);
    expect(binding.knowledgeAssets).toBe(model);
    expect(normalized.readContextGraphKaAt).toBeTypeOf('function');
    await binding.readHubRotationWindow!(undefined, 2);
    await binding.readEventScanLease!({
      eventType: 'ContextGraphCreated', contextGraphStorageAddress: `0x${'12'.repeat(20)}`,
      topic0: `0x${'34'.repeat(32)}`,
    });

    const native = Object.freeze({ subscription, knowledgeAssets: normalized });
    expect(knowledgeAssetReaderForBinding(native)).toBe(normalized);
    expect(knowledgeAssetReaderForBinding(native)).toBe(normalized);
    const withoutModel = { subscription };
    expect(knowledgeAssetReaderForBinding(withoutModel)).toBeUndefined();
    expect(knowledgeAssetReaderForBinding(undefined)).toBeUndefined();
  });
});
