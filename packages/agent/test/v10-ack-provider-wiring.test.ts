/**
 * PR #716 audit cluster **C** — agent-side wiring of the structured
 * ACK identity verifier introduced in PR #711.
 *
 * Where the wiring lives:
 *   `packages/agent/src/dkg-agent.ts:19161-19236` (`createV10ACKProvider`).
 *
 * The agent's job is to translate the chain adapter's verifier shape
 * into the `ACKCollector` deps shape. Two non-trivial pieces:
 *
 *   1. `verifyIdentityDetailed` — wired only when the chain adapter
 *      implements `verifyACKIdentityDetailed`. The closure wraps the
 *      adapter call in a `try/catch` and translates a thrown error
 *      into `{ valid: false, reason: 'rpc-error' }`. Without this
 *      translation, a flaky / rate-limited / filter-expired RPC
 *      surfaces in the ACK log as a definitive key-not-registered
 *      rejection — exactly the 90-minute diagnostic dead-end PR #711
 *      was opened to fix.
 *
 *   2. `verifyIdentity` (legacy boolean) — kept as a fallback for
 *      adapters that don't (yet) implement the structured method.
 *      The legacy wrapper also try/catches and swallows to `false`
 *      to preserve the pre-PR-#711 contract.
 *
 * Existing coverage:
 *   - `packages/publisher/test/v10-ack-edge-cases.test.ts` covers
 *     the **collector-side** consumption of these deps (3 tests on
 *     `verifyIdentityDetailed`).
 *   - The **agent-side wiring** that produces those deps had ZERO
 *     direct coverage — a refactor that drops the `rpc-error`
 *     translation or stops wiring the detailed verifier would
 *     re-introduce the pre-PR-#711 diagnostic conflation silently.
 *
 * This file pins the agent-side closures by intercepting the
 * `ACKCollector` constructor (via `vi.mock`) so we can capture the
 * exact deps the agent hands it, then invoking those deps with
 * controlled chain behaviours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
// Codex review feedback: the chain package exports the verifier
// result type as `VerifyACKIdentityResult`; `ACKVerifyResult` is the
// publisher-side mirror (same shape, different export site).
import type { VerifyACKIdentityResult } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';

/**
 * Capture every `ACKCollector` constructor call so each test can
 * inspect the exact deps the agent wired. Cleared in `beforeEach`.
 */
const capturedAckCollectorDeps: unknown[] = [];
const capturedStorageACKHandlerConfigs: unknown[] = [];

vi.mock('@origintrail-official/dkg-publisher', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-publisher')>(
    '@origintrail-official/dkg-publisher',
  );
  return {
    ...actual,
    // Replace the `ACKCollector` class with a tiny capture stand-in.
    // We don't need its full behaviour for these wiring tests — the
    // agent only constructs it; the actual `collect()` only runs on
    // publish, which isn't exercised here.
    ACKCollector: class CapturingACKCollector {
      constructor(deps: unknown) {
        capturedAckCollectorDeps.push(deps);
      }
      // Required for the agent's outer closure shape — never called
      // in this file, but TypeScript's structural matching expects
      // the surface to exist.
      async collect(): Promise<never> {
        throw new Error('CapturingACKCollector.collect should not be invoked in wiring tests');
      }
    },
    StorageACKHandler: class CapturingStorageACKHandler {
      constructor(_store: unknown, config: unknown) {
        capturedStorageACKHandlerConfigs.push(config);
      }
      async handler(): Promise<Uint8Array> {
        return new Uint8Array();
      }
      async updateHandler(): Promise<Uint8Array> {
        return new Uint8Array();
      }
    },
  };
});

/**
 * Shape the agent passes to the (now-mocked) `ACKCollector`
 * constructor. We only assert on the two verifier callbacks here.
 */
interface ACKCollectorDepsCapture {
  sendP2P?: (peerId: string, protocol: string, data: Uint8Array) => Promise<Uint8Array>;
  verifyIdentity?: (recoveredAddress: string, identityId: bigint) => Promise<boolean>;
  verifyIdentityDetailed?: (
    recoveredAddress: string,
    identityId: bigint,
  ) => Promise<VerifyACKIdentityResult>;
}

interface StorageACKHandlerConfigCapture {
  isCgCurated?: (cgId: string, swmGraphId?: string) => Promise<boolean | null>;
}

/**
 * Reach into the agent's `private createV10ACKProvider(cgId)` so the
 * ACK collector is actually constructed and its deps are captured.
 *
 * Also stub the two start-time fields (`router`, `gossip`) the
 * `createV10ACKProvider` guard checks — without a real `start()` they
 * are `undefined`/null, and the function would short-circuit at the
 * very first `if (!this.router || !this.gossip) return undefined;`
 * without ever constructing an `ACKCollector`.
 */
interface ProviderInternals {
  createV10ACKProvider(cgId: string): unknown;
  createV10UpdateACKProvider(cgId: string): unknown;
  createACKTransportFactory(options?: {
    sendTimeoutMs?: number;
    log?: (message: string) => void;
  }): () => {
    sendP2P(peerId: string, protocol: string, data: Uint8Array): Promise<Uint8Array>;
  };
  router: unknown;
  gossip: unknown;
  messenger: unknown;
  config: {
    storageAckTiming: { handlerDeadlineMs: number; sendTimeoutMs: number };
    ackHandlerDeadlineMs?: number;
    ackSendTimeoutMs?: number;
  };
  chain: MockChainAdapter & {
    verifyACKIdentity?: (recoveredAddress: string, identityId: bigint) => Promise<boolean>;
    verifyACKIdentityDetailed?: (
      recoveredAddress: string,
      identityId: bigint,
    ) => Promise<VerifyACKIdentityResult>;
  };
  node: { libp2p: { getPeers(): unknown[] } };
}

async function bootProviderAgent(options: Record<string, unknown> = {}): Promise<{ agent: DKGAgent; internals: ProviderInternals }> {
  const chain = new MockChainAdapter();
  const agent = await DKGAgent.create({
    name: 'ACKProviderWiringTest',
    chainAdapter: chain,
    ...options,
  });
  const internals = agent as unknown as ProviderInternals;
  // The guards at the top of `createV10ACKProvider` only check
  // truthiness, not type. Pass empty objects so the function reaches
  // the `new ACKCollector(...)` call site.
  internals.router = {};
  internals.gossip = { publish: async () => undefined };
  // Unconditionally override `node` — the real `DKGNode` getter
  // throws on access before `start()` is called, so even the
  // existence check `!internals.node.libp2p` blows up. Provide a
  // structurally-typed stub that satisfies the `getConnectedCorePeers`
  // callback's `this.node.libp2p.getPeers()` call without spinning
  // libp2p.
  (internals as { node: { libp2p: { getPeers(): unknown[] } } }).node = {
    libp2p: { getPeers: () => [] },
  };
  return { agent, internals };
}

describe('DKGAgent.createV10ACKProvider — structured ACK verifier wiring (PR #711)', () => {
  let agent: DKGAgent | null = null;

  beforeEach(() => {
    capturedAckCollectorDeps.length = 0;
    capturedStorageACKHandlerConfigs.length = 0;
  });

  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
    vi.restoreAllMocks();
  });

  it('chain exposes verifyACKIdentityDetailed: agent wires verifyIdentityDetailed AND translates thrown errors to {valid: false, reason: "rpc-error"}', async () => {
    const boot = await bootProviderAgent();
    agent = boot.agent;
    const internals = boot.internals;

    // Make the chain's structured verifier THROW — the pre-PR-#711
    // contract was that the agent's try/catch returned `false`,
    // which the collector logged as the same "not registered"
    // string as a definitive identity rejection. PR #711's fix is
    // that the agent translates the throw into the dedicated
    // `'rpc-error'` reason so operators can act on it.
    internals.chain.verifyACKIdentityDetailed = async (): Promise<VerifyACKIdentityResult> => {
      throw new Error('synthetic RPC outage — filter expired');
    };

    internals.createV10ACKProvider('test-cg');

    expect(capturedAckCollectorDeps).toHaveLength(1);
    const deps = capturedAckCollectorDeps[0] as ACKCollectorDepsCapture;
    expect(deps.verifyIdentityDetailed).toBeTypeOf('function');

    const verdict = await deps.verifyIdentityDetailed!(
      '0xabCDeF0123456789abcDef0123456789AbCdef01',
      42n,
    );
    expect(verdict).toEqual({ valid: false, reason: 'rpc-error' });
  });

  it('chain exposes verifyACKIdentityDetailed: agent forwards a definitive {valid: false, reason: "key-not-registered"} verdict UNCHANGED', async () => {
    // The wrapper must not corrupt definitive verdicts — only
    // translate THROWS into rpc-error. If a refactor accidentally
    // started squashing reason fields to undefined, operators would
    // lose the ability to act on the specific failure mode.
    const boot = await bootProviderAgent();
    agent = boot.agent;
    const internals = boot.internals;

    internals.chain.verifyACKIdentityDetailed = async (): Promise<VerifyACKIdentityResult> => ({
      valid: false,
      reason: 'key-not-registered' as const,
    });

    internals.createV10ACKProvider('test-cg');

    const deps = capturedAckCollectorDeps[0] as ACKCollectorDepsCapture;
    const verdict = await deps.verifyIdentityDetailed!(
      '0xabCDeF0123456789abcDef0123456789AbCdef01',
      42n,
    );
    expect(verdict).toEqual({ valid: false, reason: 'key-not-registered' });
  });

  it('chain exposes only the boolean verifyACKIdentity (no structured method): agent wires verifyIdentity, leaves verifyIdentityDetailed undefined; the legacy wrapper swallows throws to false', async () => {
    // Backward-compat path. The collector falls back to its legacy
    // log line "Signer X not registered for identity Y" when only
    // the boolean callback is provided, so the wiring difference
    // is observable end-to-end.
    const boot = await bootProviderAgent();
    agent = boot.agent;
    const internals = boot.internals;

    // Strip the structured method so the `typeof === 'function'`
    // guard reads false and the agent skips wiring it.
    (internals.chain as { verifyACKIdentityDetailed?: unknown }).verifyACKIdentityDetailed =
      undefined;
    // Make the boolean verifier throw, so we can assert the legacy
    // wrapper translates the throw to `false` rather than letting
    // it propagate.
    internals.chain.verifyACKIdentity = async (): Promise<boolean> => {
      throw new Error('synthetic RPC outage on legacy path');
    };

    internals.createV10ACKProvider('test-cg');

    const deps = capturedAckCollectorDeps[0] as ACKCollectorDepsCapture;
    expect(deps.verifyIdentityDetailed).toBeUndefined();
    expect(deps.verifyIdentity).toBeTypeOf('function');

    const verdict = await deps.verifyIdentity!(
      '0xabCDeF0123456789abcDef0123456789AbCdef01',
      42n,
    );
    expect(verdict).toBe(false);
  });

  it('passes ackSendTimeoutMs through publish and update ACK provider sendP2P closures', async () => {
    const boot = await bootProviderAgent({ ackSendTimeoutMs: 60_000 });
    agent = boot.agent;
    const internals = boot.internals;
    const response = new Uint8Array([9]);
    const sendRequestOwned = vi.fn(async () => ({
      delivered: true,
      response,
    }));
    const payload = new Uint8Array([1, 2, 3]);
    internals.messenger = { sendRequestOwned };

    internals.createV10ACKProvider('test-cg');
    const publishDeps = capturedAckCollectorDeps[0] as ACKCollectorDepsCapture;
    await expect(publishDeps.sendP2P!('peer-a', '/dkg/test/storage-ack', payload)).resolves.toEqual(response);

    internals.createV10UpdateACKProvider('test-cg');
    const updateDeps = capturedAckCollectorDeps[1] as ACKCollectorDepsCapture;
    await expect(updateDeps.sendP2P!('peer-b', '/dkg/test/storage-update-ack', payload)).resolves.toEqual(response);

    expect(sendRequestOwned).toHaveBeenNthCalledWith(1, 'peer-a', '/dkg/test/storage-ack', payload, {
      timeoutMs: 60_000,
    });
    expect(sendRequestOwned).toHaveBeenNthCalledWith(2, 'peer-b', '/dkg/test/storage-update-ack', payload, {
      timeoutMs: 60_000,
    });
  });

  it('normalizes legacy handler-only ACK timing before publish sendP2P wiring', async () => {
    const boot = await bootProviderAgent({ ackHandlerDeadlineMs: 55_000 });
    agent = boot.agent;
    const internals = boot.internals;
    const response = new Uint8Array([9]);
    const sendRequestOwned = vi.fn(async () => ({
      delivered: true,
      response,
    }));
    internals.messenger = { sendRequestOwned };
    const payload = new Uint8Array([1]);

    internals.createV10ACKProvider('test-cg');
    const publishDeps = capturedAckCollectorDeps[0] as ACKCollectorDepsCapture;
    await expect(publishDeps.sendP2P!('peer-a', '/dkg/test/storage-ack', payload)).resolves.toEqual(response);

    expect(sendRequestOwned).toHaveBeenCalledWith('peer-a', '/dkg/test/storage-ack', payload, {
      timeoutMs: 60_000,
    });
  });

  it('accepts matching single legacy aliases with storageAckTiming without rehydrating aliases', async () => {
    const boot = await bootProviderAgent({
      storageAckTiming: { handlerDeadlineMs: 55_000, sendTimeoutMs: 60_000 },
      ackSendTimeoutMs: 60_000,
    });
    agent = boot.agent;

    expect(boot.internals.config.storageAckTiming).toEqual({
      handlerDeadlineMs: 55_000,
      sendTimeoutMs: 60_000,
    });
    expect(boot.internals.config.ackHandlerDeadlineMs).toBeUndefined();
    expect(boot.internals.config.ackSendTimeoutMs).toBeUndefined();
  });

  it('rejects conflicting storageAckTiming and legacy ACK timing aliases', async () => {
    await expect(DKGAgent.create({
      name: 'ACKTimingConflictingAliasesTest',
      storageAckTiming: { handlerDeadlineMs: 55_000, sendTimeoutMs: 60_000 },
      ackSendTimeoutMs: 20_000,
    })).rejects.toThrow(/DKGAgentConfig\.storageAckTiming must not conflict/);
  });

  it('preserves legacy ackHandlerDeadlineMs: 0 as a disabled handler deadline', async () => {
    const boot = await bootProviderAgent({ ackHandlerDeadlineMs: 0 });
    agent = boot.agent;
    const internals = boot.internals;
    const response = new Uint8Array([9]);
    const sendRequestOwned = vi.fn(async () => ({
      delivered: true,
      response,
    }));
    internals.messenger = { sendRequestOwned };
    const payload = new Uint8Array([1]);

    internals.createV10ACKProvider('test-cg');
    const publishDeps = capturedAckCollectorDeps[0] as ACKCollectorDepsCapture;
    await expect(publishDeps.sendP2P!('peer-a', '/dkg/test/storage-ack', payload)).resolves.toEqual(response);

    expect(internals.config.storageAckTiming).toEqual({
      handlerDeadlineMs: 0,
      sendTimeoutMs: 20_000,
    });
    expect(sendRequestOwned).toHaveBeenCalledWith('peer-a', '/dkg/test/storage-ack', payload, {
      timeoutMs: 20_000,
    });
  });

  it('rejects failed ACK transport sends from the agent-owned transport factory', async () => {
    const boot = await bootProviderAgent({ ackSendTimeoutMs: 60_000 });
    agent = boot.agent;
    const internals = boot.internals;
    const payload = new Uint8Array([1]);

    const queuedSend = vi.fn(async () => ({
      delivered: false,
      error: 'queued',
    }));
    internals.messenger = { sendRequestOwned: queuedSend };
    await expect(
      internals.createACKTransportFactory()().sendP2P('peer-a', '/dkg/test/storage-ack', payload),
    ).rejects.toThrow(/substrate send already in flight \(transport\): queued/);
    expect(queuedSend).toHaveBeenCalledWith('peer-a', '/dkg/test/storage-ack', payload, {
      timeoutMs: 60_000,
    });

    const missingResponseSend = vi.fn(async () => ({
      delivered: true,
    }));
    internals.messenger = { sendRequestOwned: missingResponseSend };
    await expect(
      internals.createACKTransportFactory()().sendP2P('peer-a', '/dkg/test/storage-ack', payload),
    ).rejects.toThrow(/substrate delivered \(transport\) without response/);
  });

  it('rejects misaligned direct agent ACK timing before boot side effects', async () => {
    await expect(DKGAgent.create({
      name: 'ACKTimingInvalidPairTest',
      ackHandlerDeadlineMs: 60_000,
      ackSendTimeoutMs: 30_000,
    })).rejects.toThrow(/DKGAgentConfig\.storageAckTiming\.sendTimeoutMs must be at least 5000ms/);
  });

  it('passes ackHandlerDeadlineMs into StorageACKHandler construction during core startup', async () => {
    const primary = ethers.Wallet.createRandom();
    const ackSigner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', primary.address);
    chain.seedIdentity(primary.address, 42n);

    agent = await DKGAgent.create({
      name: 'ACKHandlerDeadlineWiringTest',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: chain,
      nodeRole: 'core',
      ackSignerKey: ackSigner.privateKey,
      storageAckTiming: { handlerDeadlineMs: 55_000, sendTimeoutMs: 60_000 },
    });
    await agent.start();

    expect(capturedStorageACKHandlerConfigs).toContainEqual(
      expect.objectContaining({ ackHandlerDeadlineMs: 55_000 }),
    );
  });

  it('delegates StorageACK curation config to the named target-policy resolver', async () => {
    const primary = ethers.Wallet.createRandom();
    const ackSigner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', primary.address);
    chain.seedIdentity(primary.address, 42n);

    agent = await DKGAgent.create({
      name: 'ACKCurationFastPathTest',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: chain,
      nodeRole: 'core',
      ackSignerKey: ackSigner.privateKey,
    });
    await agent.start();

    const resolver = vi.spyOn(agent, 'resolveCgCurationForAck').mockResolvedValue(true);

    const handlerConfig = capturedStorageACKHandlerConfigs.find(
      (config): config is StorageACKHandlerConfigCapture =>
        typeof (config as StorageACKHandlerConfigCapture).isCgCurated === 'function',
    );
    expect(handlerConfig?.isCgCurated).toBeTypeOf('function');

    // StorageACKHandler uses this one callback from both handler() and
    // updateHandler(). The source SWM graph must not enter the target-policy
    // resolver; only the PublishIntent's target cgId determines curation.
    await expect(handlerConfig!.isCgCurated!('101', 'private-looking-source')).resolves.toBe(true);
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith('101', expect.any(Object));
  });
});
