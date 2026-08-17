import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';

// GH#2270 — regression at the CONFIG→CONSTRUCTION seam, the #1836 bug class: the
// automatic-retry kill-switch and the backoff knobs are dead config unless they
// travel config.json → the publisher instance whose scheduler and claim-time
// sweep actually run. That instance is built by createPublisherRuntimeFromBase
// off startPublisherRuntimeIfEnabled, so these rows drive the real projection and
// capture what the constructor received. Deleting the `...args.retryTuning`
// spread (or the `retryTuning:` argument feeding it) fails them.
const mocks = vi.hoisted(() => ({
  publisherConfigs: [] as any[],
}));

vi.mock('@origintrail-official/dkg-publisher', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-publisher')>();
  // A subclass, not a stub: the real constructor still runs (and still throws on
  // an invalid knob), so these rows cannot pass on a value the publisher rejects.
  class CapturingAsyncLiftPublisher extends actual.TripleStoreAsyncLiftPublisher {
    constructor(store: any, config: any = {}) {
      super(store, config);
      mocks.publisherConfigs.push(config);
    }
  }
  return { ...actual, TripleStoreAsyncLiftPublisher: CapturingAsyncLiftPublisher };
});

const { resolvePublisherRetryTuning } = await import('../src/config.js');
const { startPublisherRuntimeIfEnabled } = await import('../src/publisher-runner.js');
type PublisherRuntime = Awaited<ReturnType<typeof startPublisherRuntimeIfEnabled>>;
const { addPublisherWallet } = await import('../src/publisher-wallets.js');
const { TripleStoreAsyncLiftPublisher } = await import('@origintrail-official/dkg-publisher');

describe('publisher retry-knob config→construction wiring (#2270)', () => {
  let dataDir: string | undefined;
  let store: TripleStore | undefined;
  let runtime: PublisherRuntime | null = null;

  afterEach(async () => {
    await runtime?.stop().catch(() => {});
    runtime = null;
    await store?.close().catch(() => {});
    store = undefined;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
    mocks.publisherConfigs.length = 0;
  });

  /** Start the real daemon publisher runtime over a temp wallet + store. */
  async function capturePublisherConfig(publisher: Record<string, unknown>): Promise<any> {
    dataDir = await mkdtemp(join(tmpdir(), 'dkg-retry-tuning-wiring-'));
    store = await createTripleStore({ backend: 'oxigraph' });
    await addPublisherWallet(dataDir, ethers.Wallet.createRandom().privateKey);
    runtime = await startPublisherRuntimeIfEnabled({
      dataDir,
      store,
      keypair: await generateEd25519Keypair(),
      config: {
        name: 'retry-tuning-wiring-test',
        apiPort: 0,
        listenPort: 0,
        nodeRole: 'edge',
        // A long poll interval keeps the started runner idle for the assertion.
        publisher: { enabled: true, pollIntervalMs: 600_000, ...publisher },
      } as any,
      log: () => {},
    });
    expect(runtime).not.toBeNull();
    // Exactly one async-lift publisher is built for the runtime, so there is no
    // ambiguity about which instance these knobs landed on.
    expect(mocks.publisherConfigs).toHaveLength(1);
    return mocks.publisherConfigs[0];
  }

  it('forwards all four retry knobs from config.publisher into the publisher constructor', async () => {
    const config = await capturePublisherConfig({
      autoRetryEnabled: false,
      retryJitterRatio: 0.5,
      retryBackoffBaseMs: 1_234,
      retryBackoffMaxMs: 4_321,
      maxRetries: 3,
    });

    expect(config.autoRetryEnabled).toBe(false);
    expect(config.retryJitterRatio).toBe(0.5);
    expect(config.retryBackoffBaseMs).toBe(1_234);
    expect(config.retryBackoffMaxMs).toBe(4_321);
    // The pre-existing #1836 hop, re-pinned on the runtime instance.
    expect(config.maxRetries).toBe(3);
  });

  it('forwards autoRetryEnabled: true as an explicit value, not only the falsy case', async () => {
    const config = await capturePublisherConfig({ autoRetryEnabled: true });

    expect(config.autoRetryEnabled).toBe(true);
  });

  it('leaves every knob undefined when unconfigured so the library defaults hold', async () => {
    const config = await capturePublisherConfig({});

    expect(config.autoRetryEnabled).toBeUndefined();
    expect(config.retryJitterRatio).toBeUndefined();
    expect(config.retryBackoffBaseMs).toBeUndefined();
    expect(config.retryBackoffMaxMs).toBeUndefined();
  });

  it('projects a jitter ratio of 0 (jitter disabled) rather than dropping it as falsy', async () => {
    const config = await capturePublisherConfig({ retryJitterRatio: 0 });

    expect(config.retryJitterRatio).toBe(0);
  });
});

describe('resolvePublisherRetryTuning validation (#2270)', () => {
  it('passes an unset publisher block through as all-undefined', () => {
    expect(resolvePublisherRetryTuning(undefined)).toEqual({
      autoRetryEnabled: undefined,
      retryJitterRatio: undefined,
      retryBackoffBaseMs: undefined,
      retryBackoffMaxMs: undefined,
    });
  });

  it('returns configured knobs unchanged, including the boundary values', () => {
    expect(resolvePublisherRetryTuning({
      enabled: true,
      autoRetryEnabled: false,
      retryJitterRatio: 0,
      retryBackoffBaseMs: 5_000,
      retryBackoffMaxMs: 5_000,
    })).toEqual({
      autoRetryEnabled: false,
      retryJitterRatio: 0,
      retryBackoffBaseMs: 5_000,
      retryBackoffMaxMs: 5_000,
    });
  });

  it('rejects a non-boolean autoRetryEnabled', () => {
    expect(() => resolvePublisherRetryTuning({ autoRetryEnabled: 'false' as any }))
      .toThrow('publisher.autoRetryEnabled must be a boolean (received "false")');
  });

  it('rejects a retryJitterRatio outside [0, 1)', () => {
    expect(() => resolvePublisherRetryTuning({ retryJitterRatio: 1 }))
      .toThrow('publisher.retryJitterRatio must be a number at least 0 and below 1 (received 1)');
    expect(() => resolvePublisherRetryTuning({ retryJitterRatio: -0.1 }))
      .toThrow(/retryJitterRatio must be a number at least 0 and below 1/);
    expect(() => resolvePublisherRetryTuning({ retryJitterRatio: Number.NaN }))
      .toThrow(/retryJitterRatio must be a number at least 0 and below 1/);
    expect(() => resolvePublisherRetryTuning({ retryJitterRatio: '0.5' as any }))
      .toThrow(/retryJitterRatio must be a number at least 0 and below 1/);
  });

  it('rejects a non-positive or non-integer backoff bound', () => {
    expect(() => resolvePublisherRetryTuning({ retryBackoffBaseMs: 0, retryBackoffMaxMs: 10 }))
      .toThrow(/publisher\.retryBackoffBaseMs must be a positive safe integer number of milliseconds/);
    expect(() => resolvePublisherRetryTuning({ retryBackoffBaseMs: 10, retryBackoffMaxMs: -1 }))
      .toThrow(/publisher\.retryBackoffMaxMs must be a positive safe integer number of milliseconds/);
    expect(() => resolvePublisherRetryTuning({ retryBackoffBaseMs: 1.5, retryBackoffMaxMs: 10 }))
      .toThrow(/publisher\.retryBackoffBaseMs must be a positive safe integer number of milliseconds/);
  });

  it('rejects a max below base', () => {
    expect(() => resolvePublisherRetryTuning({ retryBackoffBaseMs: 10_000, retryBackoffMaxMs: 9_999 }))
      .toThrow('publisher.retryBackoffMaxMs (9999) must be at least publisher.retryBackoffBaseMs (10000)');
  });

  it('validates a half-configured backoff pair against the REAL library defaults', () => {
    // The shared resolver exports the defaults, so base-only / max-only
    // configs are legal exactly when the EFFECTIVE pair they induce is —
    // the earlier "must be set together" rule is gone.
    expect(resolvePublisherRetryTuning({ retryBackoffBaseMs: 10_000 }))
      .toEqual({ retryBackoffBaseMs: 10_000 });
    expect(resolvePublisherRetryTuning({ retryBackoffMaxMs: 10_000 }))
      .toEqual({ retryBackoffMaxMs: 10_000 });
    // Base above the DEFAULT max (60s) with no explicit max: invalid pair.
    expect(() => resolvePublisherRetryTuning({ retryBackoffBaseMs: 120_000 }))
      .toThrow('publisher.retryBackoffMaxMs (60000, the default) must be at least publisher.retryBackoffBaseMs (120000)');
    // Max below the DEFAULT base (5s) with no explicit base: invalid pair.
    expect(() => resolvePublisherRetryTuning({ retryBackoffMaxMs: 1_000 }))
      .toThrow('publisher.retryBackoffMaxMs (1000) must be at least publisher.retryBackoffBaseMs (5000, the default)');
  });

  it('rejects a publisher block that is not an object', () => {
    expect(() => resolvePublisherRetryTuning('12000' as any)).toThrow('publisher must be an object');
    expect(() => resolvePublisherRetryTuning([] as any)).toThrow('publisher must be an object');
  });

  it('labels the failing key with the caller-supplied prefix', () => {
    expect(() => resolvePublisherRetryTuning({ retryJitterRatio: 2 }, 'config.publisher'))
      .toThrow(/^config\.publisher\.retryJitterRatio/);
  });

  // The rules above are not decoration: each one fronts a value the publisher
  // constructor throws on. The half-pair rule exists because base-only is the
  // case the config layer CANNOT bound — the library compares it against a
  // default this layer deliberately does not duplicate.
  it('fronts constructor throws the daemon would otherwise hit mid-boot', () => {
    const store = {} as TripleStore;

    expect(() => new TripleStoreAsyncLiftPublisher(store, { retryJitterRatio: 1.5 }))
      .toThrow('Async lift publisher.retryJitterRatio must be a number at least 0 and below 1');
    expect(() => resolvePublisherRetryTuning({ retryJitterRatio: 1.5 })).toThrow(/retryJitterRatio/);

    expect(() => new TripleStoreAsyncLiftPublisher(store, { retryBackoffBaseMs: 0 }))
      .toThrow('Async lift publisher.retryBackoffBaseMs must be a positive safe integer number of milliseconds');
    expect(() => resolvePublisherRetryTuning({ retryBackoffBaseMs: 0, retryBackoffMaxMs: 10 }))
      .toThrow(/retryBackoffBaseMs/);

    // base-only above the library's 60s default max: the shared resolver
    // rejects it IDENTICALLY at both boundaries — one owner, one message.
    expect(() => new TripleStoreAsyncLiftPublisher(store, { retryBackoffBaseMs: 120_000 }))
      .toThrow('Async lift publisher.retryBackoffMaxMs (60000, the default) must be at least Async lift publisher.retryBackoffBaseMs (120000)');
    expect(() => resolvePublisherRetryTuning({ retryBackoffBaseMs: 120_000 }))
      .toThrow('publisher.retryBackoffMaxMs (60000, the default) must be at least publisher.retryBackoffBaseMs (120000)');
  });
});
