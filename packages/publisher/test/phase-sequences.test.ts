/**
 * Phase-sequence contract tests.
 *
 * These golden-sequence snapshots break if someone adds, removes, or
 * reorders an onPhase call inside publish() or update().  That's the
 * point — the operation tracker on the Node UI relies on these exact
 * sequences, and any change must be deliberate.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  TypedEventBus,
  generateEd25519Keypair,
  createOperationContext,
  encodeWorkspacePublishRequest,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { SharedMemoryHandler } from '../src/workspace-handler.js';
import { ethers } from 'ethers';
import type { PhaseCallback } from '../src/publisher.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, createTestContextGraph, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { wrapPublisherForTest } from './_helpers/seal.js';
import { makeTestKaAllocator } from './_helpers/ka-allocator.js';
import { hardhatACKProvider } from './_helpers/acks.js';

let CONTEXT_GRAPH: string;
let _kav10Address: string;
let _provider: ethers.JsonRpcProvider;
const _author = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);

function makeTestPublisher(
  opts: ConstructorParameters<typeof DKGPublisher>[0],
  testOpts: { withACKs?: boolean } = {},
): DKGPublisher {
  const withACKs = testOpts.withACKs !== false;
  // OT-RFC-43 Option-1: wire a KA-number allocator so the real EVM adapter
  // gets a packed reservedKaId per mint.
  return wrapPublisherForTest(new DKGPublisher({ kaAllocator: makeTestKaAllocator(), ...opts }), {
    author: _author,
    ctx: { provider: _provider, kav10Address: _kav10Address },
    // RC11 / PR1: real 3-of-N ACK quorum (self-signed ACK fallback gone).
    // Tests that exercise the "no ACK provider" path explicitly opt
    // out with `withACKs: false`.
    ...(withACKs ? { v10ACKProvider: hardhatACKProvider(_kav10Address) } : {}),
  });
}
const ENTITY = 'did:dkg:agent:QmPhaseSeq';

function q(s: string, p: string, o: string, g = `did:dkg:context-graph:${CONTEXT_GRAPH}`): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function recorder(): { calls: [string, 'start' | 'end'][]; fn: PhaseCallback } {
  const calls: [string, 'start' | 'end'][] = [];
  const fn: PhaseCallback = (phase, status) => { calls.push([phase, status]); };
  return { calls, fn };
}

/**
 * PR #241 Codex iter-5: the WAL hook now emits a single-shot
 * `chain:txsigned:tx-0x...:start` / `:end` pair carrying the exact
 * pre-broadcast tx hash, which is by definition dynamic. Golden
 * phase-sequence tests care about shape, not about that specific hash,
 * so we filter those phases before comparing to the expected sequence.
 *
 * The `'chain:txsigned breadcrumb is present'` test below still asserts
 * that this phase fires at all on the publish/update paths — we only
 * strip it from the exact-equality snapshots here.
 */
function stripTxSigned(calls: [string, 'start' | 'end'][]): [string, 'start' | 'end'][] {
  return calls.filter(([p]) => !p.startsWith('chain:txsigned:'));
}

describe('Phase-sequence contracts', () => {

  let _fileSnapshot: string;
  beforeAll(async () => {
    _fileSnapshot = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));

    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    // PR #1072: these phase-sequence tests publish PLAINTEXT to pin phase
    // ordering / ACK / WAL / workspace mechanics, not curated/ciphertext
    // semantics. Use a PUBLIC CG (accessPolicy 0) so plaintext publishes
    // don't revert with CuratedCGRequiresCiphertextCommitment.
    const cgId = await createTestContextGraph(chain, undefined, 0);
    CONTEXT_GRAPH = String(cgId);
    _provider = provider;
    _kav10Address = await chain.getKnowledgeAssetsLifecycleAddress();
  });
  afterAll(async () => {
    await revertSnapshot(_fileSnapshot);
  });

  // -- Publish (happy path — with chain + signing) ----------------------

  it('publish: golden phase sequence', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();

    const publisher = makeTestPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const quads = [
      q(ENTITY, 'http://schema.org/name', '"PhaseBot"'),
      q(ENTITY, 'http://schema.org/version', '"1"'),
    ];

    const { calls, fn } = recorder();
    await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads,
      onPhase: fn,
    });

    const phases = stripTxSigned(calls).map(([p, s]) => `${p}:${s}`);

    // RC11 / PR1: the publisher now wires a real v10ACKProvider in
    // Hardhat tests (the self-signed ACK fallback is deleted), so
    // every on-chain publish emits a `collect_v10_acks` phase pair
    // between `store:end` and `chain:start`. The golden sequence
    // pins both that this phase fires AND that it sits exactly
    // between store and chain — listeners (e.g. operations journal)
    // depend on the ordering.
    expect(phases).toEqual([
      'prepare:start',
      'prepare:ensureContextGraph:start',
      'prepare:ensureContextGraph:end',
      'prepare:partition:start',
      'prepare:partition:end',
      'prepare:manifest:start',
      'prepare:manifest:end',
      'prepare:validate:start',
      'prepare:validate:end',
      'prepare:merkle:start',
      'prepare:merkle:end',
      'prepare:end',
      'store:start',
      'store:end',
      'collect_v10_acks:start',
      'collect_v10_acks:end',
      'chain:start',
      'chain:sign:start',
      'chain:sign:end',
      'chain:submit:start',
      // P-1 write-ahead boundary: straddles the adapter call so phase
      // listeners (e.g. the CLI daemon's operations journal) can
      // checkpoint BEFORE `eth_sendRawTransaction` hits the wire.
      'chain:writeahead:start',
      'chain:writeahead:end',
      'chain:submit:end',
      'chain:metadata:start',
      'chain:metadata:end',
      'chain:end',
    ]);
  });

  it('publish awaits an async ordinary phase before advancing', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const publisher = makeTestPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    let markPrepareStarted!: () => void;
    const prepareStarted = new Promise<void>((resolve) => { markPrepareStarted = resolve; });
    const phases: string[] = [];

    const publish = publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(`${ENTITY}:async-phase`, 'http://schema.org/name', '"Awaited"')],
      onPhase: async (phase, status) => {
        phases.push(`${phase}:${status}`);
        if (phase === 'prepare' && status === 'start') {
          markPrepareStarted();
          await prepareGate;
        }
      },
    });

    await prepareStarted;
    await Promise.resolve();
    expect(phases).toEqual(['prepare:start']);

    releasePrepare();
    await expect(publish).resolves.toMatchObject({ status: 'confirmed' });
    expect(phases[1]).toBe('prepare:ensureContextGraph:start');
  });

  // -- Publish (adapter-backed signer, no identity, no ACK provider — throws after RC11 / PR1) ---

  it('publish: adapter-backed signer without node identity attempts on-chain and THROWS when no ACKs are collected (RC11 / PR1: no silent fallback)', async () => {
    // Pre-RFC-38: an identity-less publisher short-circuited at `chain:start`.
    // Post-RFC-38: edge agents without an on-chain Profile still attempt
    // the on-chain TX in no-attribution mode. Pre-RC11: with no
    // v10ACKProvider AND no identity, the self-ACK fallback at
    // dkg-publisher.ts:1995-2040 produced one ACK and the publish either
    // confirmed or downgraded silently. Post-RC11 / PR1 + PR2: the self-
    // ACK is deleted, the chain-submit branch fails loud, and any
    // configuration that reaches it with zero ACKs throws verbatim with
    // "V10 ACKs required for on-chain publish — no ACKs collected".
    // PR3 keeps that throw — the "no v10ACKProvider" case is a
    // configuration error in a publishing node and must NOT silently
    // downgrade. Pin the throw so a regression that re-introduces
    // either the self-ACK fallback OR the tentative downgrade fails
    // loudly here.
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();

    const publisher = makeTestPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
    }, { withACKs: false });

    const quads = [q(ENTITY, 'http://schema.org/name', '"NoAck"')];
    const { calls, fn } = recorder();
    await expect(
      publisher.publish({ contextGraphId: CONTEXT_GRAPH, quads, onPhase: fn }),
    ).rejects.toThrow(/V10 ACKs required for on-chain publish/);

    // The phase contract still pins the prefix up to the throw site
    // (everything BEFORE `chain:submit` should still have fired
    // pairwise). We only assert presence of the early-phase pairs
    // rather than the full sequence because the throw aborts mid-
    // chain-branch.
    const startedPhases = calls.filter(([, s]) => s === 'start').map(([p]) => p);
    for (const expected of [
      'prepare', 'prepare:ensureContextGraph', 'prepare:partition',
      'prepare:manifest', 'prepare:validate', 'prepare:merkle',
      'store',
    ]) {
      expect(startedPhases).toContain(expected);
    }
  });

  // -- Update (happy path) -----------------------------------------------

  it('update: golden phase sequence', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();

    const publisher = makeTestPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    // Publish first so there's something to update
    const quads = [q(ENTITY, 'http://schema.org/name', '"Original"')];
    const pub = await publisher.publish({ contextGraphId: CONTEXT_GRAPH, quads });

    const updatedQuads = [q(ENTITY, 'http://schema.org/name', '"Updated"')];
    const { calls, fn } = recorder();
    await publisher.update(pub.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: updatedQuads,
      onPhase: fn,
    });

    const phases = stripTxSigned(calls).map(([p, s]) => `${p}:${s}`);

    expect(phases).toEqual([
      'prepare:start',
      'prepare:partition:start',
      'prepare:partition:end',
      'prepare:manifest:start',
      'prepare:manifest:end',
      'prepare:merkle:start',
      'prepare:merkle:end',
      'prepare:end',
      'chain:start',
      'chain:submit:start',
      // P-1 write-ahead boundary for the update path.
      'chain:writeahead:start',
      'chain:writeahead:end',
      'chain:submit:end',
      'chain:end',
      'store:start',
      'store:end',
    ]);
  });

  // -- Workspace handler -------------------------------------------------

  it('workspace handle: golden phase sequence', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());

    const quads = [q(ENTITY, 'http://schema.org/name', '"WS draft"')];
    const nquads = quads
      .map(t => `<${t.subject}> <${t.predicate}> ${t.object} .`)
      .join('\n');

    const msg = encodeWorkspacePublishRequest({
      shareOperationId: 'ws-test-001',
      contextGraphId: CONTEXT_GRAPH,
      publisherPeerId: '12D3KooWTest',
      nquads: new TextEncoder().encode(nquads),
      manifest: [{ rootEntity: ENTITY }],
      timestampMs: Date.now(),
    });

    const { calls, fn } = recorder();
    await handler.handle(msg, '12D3KooWTest', fn);

    const phases = calls.map(([p, s]) => `${p}:${s}`);

    expect(phases).toEqual([
      'decode:start',
      'decode:end',
      'store:start',
      'validate:start',
      'validate:end',
      'store:end',
    ]);
  });

  // -- Structural invariants --------------------------------------------

  it('every start has a matching end', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();

    const publisher = makeTestPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const quads = [q(ENTITY, 'http://schema.org/name', '"Balanced"')];
    const { calls, fn } = recorder();
    await publisher.publish({ contextGraphId: CONTEXT_GRAPH, quads, onPhase: fn });

    const starts = calls.filter(([, s]) => s === 'start').map(([p]) => p);
    const ends = calls.filter(([, s]) => s === 'end').map(([p]) => p);

    for (const phase of starts) {
      expect(ends).toContain(phase);
    }
  });

  // -- Error-path invariant for P-1 -------------------------------------
  //
  // Codex review on PR #241 (iter-2): the write-ahead boundary must
  // ONLY fire when the adapter is actually about to broadcast a concrete
  // publish / update tx — otherwise listeners persist WAL records for
  // txs that never hit the wire. The publisher now delegates that
  // decision to an `onBroadcast` callback the adapter invokes right
  // before `publishDirect` / `updateDirect`, after any allowance /
  // `approve()` tx. Two regressions:
  //
  //   (1) If the adapter throws BEFORE calling `onBroadcast` (preflight
  //       failure — approve revert, ACK preflight, etc.), NEITHER
  //       `:start` NOR `:end` fires. Listeners see no WAL entry.
  //   (2) If the adapter calls `onBroadcast` and THEN throws (publish
  //       tx itself reverted), both `:start` and `:end` fire exactly
  //       once (the outer `finally` closes the window). Listeners
  //       treat this as the recoverable "tx on wire / receipt not
  //       observed" window that spec axiom 4 / §06 requires.

  it(
    'publish: chain:writeahead NEVER fires when the adapter throws BEFORE onBroadcast ' +
      '(P-1 iter-2 regression — no WAL entry for txs that never broadcast)',
    async () => {
      const store = new OxigraphStore();
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const keypair = await generateEd25519Keypair();
      const publisher = makeTestPublisher({
        store, chain, eventBus: new TypedEventBus(), keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      });

      (chain as unknown as { createKnowledgeAssets: (...a: unknown[]) => Promise<never> }).createKnowledgeAssets =
        async () => {
          throw new Error('simulated preflight failure (before broadcast)');
        };

      // RC11 / PR2: the publisher now re-throws chain failures
      // verbatim instead of downgrading to a silent tentative. The
      // P-1 invariant pinned by this test (no `chain:writeahead`
      // phase pair when the adapter throws *before* `onBroadcast`)
      // is orthogonal to the success/throw outcome — assert it on
      // the failure path the same way.
      const quads = [q(ENTITY, 'http://schema.org/name', '"Throws"')];
      const { calls, fn } = recorder();
      await expect(
        publisher.publish({ contextGraphId: CONTEXT_GRAPH, quads, onPhase: fn }),
      ).rejects.toThrow(/simulated preflight failure/);

      expect(calls.filter(([p]) => p === 'chain:writeahead').length).toBe(0);
    },
  );

  it(
    'publish: chain:writeahead pairs start with end when adapter calls onBroadcast THEN throws ' +
      '(P-1 iter-2 regression — recoverable "tx on wire / no receipt" window)',
    async () => {
      const store = new OxigraphStore();
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const keypair = await generateEd25519Keypair();
      const publisher = makeTestPublisher({
        store, chain, eventBus: new TypedEventBus(), keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      });

      (chain as unknown as { createKnowledgeAssets: (params: { onBroadcast?: () => Promise<void> | void }) => Promise<never> }).createKnowledgeAssets =
        async (params) => {
          await params.onBroadcast?.();
          throw new Error('simulated publish broadcast failure');
        };

      // Same RC11 / PR2 throw-instead-of-tentative adjustment.
      const quads = [q(ENTITY, 'http://schema.org/name', '"Throws"')];
      const { calls, fn } = recorder();
      await expect(
        publisher.publish({ contextGraphId: CONTEXT_GRAPH, quads, onPhase: fn }),
      ).rejects.toThrow(/simulated publish broadcast failure/);

      const startIdx = calls.findIndex(([p, s]) => p === 'chain:writeahead' && s === 'start');
      const endIdx = calls.findIndex(([p, s]) => p === 'chain:writeahead' && s === 'end');
      expect(startIdx, 'chain:writeahead:start must fire once onBroadcast is invoked').toBeGreaterThanOrEqual(0);
      expect(endIdx, 'chain:writeahead:end must fire when the adapter throws after onBroadcast').toBeGreaterThan(startIdx);
      expect(calls.filter(([p, s]) => p === 'chain:writeahead' && s === 'start').length).toBe(1);
      expect(calls.filter(([p, s]) => p === 'chain:writeahead' && s === 'end').length).toBe(1);
    },
  );

  it('publish awaits an async chain:writeahead:end listener before settling', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const publisher = makeTestPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    (chain as unknown as {
      createKnowledgeAssets: (params: { onBroadcast?: () => Promise<void> | void }) => Promise<never>;
    }).createKnowledgeAssets = async (params) => {
      await params.onBroadcast?.();
      throw new Error('simulated post-broadcast publish failure');
    };

    let markEndStarted!: () => void;
    const endStarted = new Promise<void>((resolve) => { markEndStarted = resolve; });
    let releaseEnd!: () => void;
    const endGate = new Promise<void>((resolve) => { releaseEnd = resolve; });
    let settled = false;
    const operation = publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(ENTITY, 'http://schema.org/name', '"Await close"')],
      onPhase: async (phase, status) => {
        if (phase === 'chain:writeahead' && status === 'end') {
          markEndStarted();
          await endGate;
        }
      },
    }).finally(() => { settled = true; });

    await endStarted;
    expect(settled).toBe(false);
    releaseEnd();
    await expect(operation).rejects.toThrow('simulated post-broadcast publish failure');
    expect(settled).toBe(true);
  });

  it('publish: an aborted late hook emits no tx-bearing progress or WAL start', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const publisher = makeTestPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    let releaseListener!: () => void;
    const listenerGate = new Promise<void>((resolve) => { releaseListener = resolve; });
    let markListenerStarted!: () => void;
    const listenerStarted = new Promise<void>((resolve) => { markListenerStarted = resolve; });
    let broadcasted = false;
    (chain as unknown as {
      createKnowledgeAssets: (params: {
        onBroadcast?: (info: { txHash: string; signal: AbortSignal }) => Promise<void> | void;
      }) => Promise<never>;
    }).createKnowledgeAssets = async (params) => {
      const controller = new AbortController();
      const lateHook = params.onBroadcast?.({
        txHash: `0x${'ab'.repeat(32)}`,
        signal: controller.signal,
      });
      await listenerStarted;
      controller.abort();
      releaseListener();
      await expect(lateHook).rejects.toThrow('write-ahead hook was aborted before broadcast');
      if (!controller.signal.aborted) broadcasted = true;
      throw new Error('simulated write-ahead timeout');
    };

    const calls: [string, 'start' | 'end'][] = [];
    const onPhase: PhaseCallback = async (phase, status, context) => {
      if (phase.startsWith('chain:txsigned:') && status === 'start') {
        markListenerStarted();
        await listenerGate;
      }
      if (context?.signal?.aborted) return;
      calls.push([phase, status]);
    };
    const quads = [q(ENTITY, 'http://schema.org/name', '"Late"')];

    await expect(
      publisher.publish({ contextGraphId: CONTEXT_GRAPH, quads, onPhase }),
    ).rejects.toThrow('simulated write-ahead timeout');

    expect(broadcasted).toBe(false);
    expect(calls.some(([phase]) => phase.startsWith('chain:txsigned:'))).toBe(false);
    expect(calls.some(([phase]) => phase === 'chain:writeahead')).toBe(false);
  });

  it('update: an aborted late hook emits no tx-bearing progress or WAL start', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const publisher = makeTestPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const original = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(ENTITY, 'http://schema.org/name', '"Before abort"')],
    });

    let releaseListener!: () => void;
    const listenerGate = new Promise<void>((resolve) => { releaseListener = resolve; });
    let markListenerStarted!: () => void;
    const listenerStarted = new Promise<void>((resolve) => { markListenerStarted = resolve; });
    let broadcasted = false;
    (chain as unknown as {
      updateKnowledgeCollectionV10: (params: {
        onBroadcast?: (info: { txHash: string; signal: AbortSignal }) => Promise<void> | void;
      }) => Promise<never>;
    }).updateKnowledgeCollectionV10 = async (params) => {
      const controller = new AbortController();
      const lateHook = params.onBroadcast?.({
        txHash: `0x${'cd'.repeat(32)}`,
        signal: controller.signal,
      });
      await listenerStarted;
      controller.abort();
      releaseListener();
      await expect(lateHook).rejects.toThrow('write-ahead hook was aborted before broadcast');
      if (!controller.signal.aborted) broadcasted = true;
      throw new Error('simulated update write-ahead timeout');
    };

    const calls: [string, 'start' | 'end'][] = [];
    const onPhase: PhaseCallback = async (phase, status, context) => {
      if (phase.startsWith('chain:txsigned:') && status === 'start') {
        markListenerStarted();
        await listenerGate;
      }
      if (context?.signal?.aborted) return;
      calls.push([phase, status]);
    };

    await expect(publisher.update(original.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(ENTITY, 'http://schema.org/name', '"After abort"')],
      onPhase,
    })).rejects.toThrow('simulated update write-ahead timeout');

    expect(broadcasted).toBe(false);
    expect(calls.some(([phase]) => phase.startsWith('chain:txsigned:'))).toBe(false);
    expect(calls.some(([phase]) => phase === 'chain:writeahead')).toBe(false);
  });

  it(
    'update: chain:writeahead pairs start with end when adapter calls onBroadcast THEN throws ' +
      '(P-1 iter-2 regression — update re-throws, WAL window still closed)',
    async () => {
      const store = new OxigraphStore();
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const keypair = await generateEd25519Keypair();
      const publisher = makeTestPublisher({
        store, chain, eventBus: new TypedEventBus(), keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      });

      const origQuads = [q(ENTITY, 'http://schema.org/name', '"Seed"')];
      const pub = await publisher.publish({ contextGraphId: CONTEXT_GRAPH, quads: origQuads });
      expect(pub.status).toBe('confirmed');

      (chain as unknown as { updateKnowledgeCollectionV10: (params: { onBroadcast?: () => Promise<void> | void }) => Promise<never> }).updateKnowledgeCollectionV10 =
        async (params) => {
          await params.onBroadcast?.();
          throw new Error('simulated update broadcast failure');
        };
      if (typeof (chain as { updateKnowledgeAssets?: unknown }).updateKnowledgeAssets === 'function') {
        (chain as unknown as { updateKnowledgeAssets: (...a: unknown[]) => Promise<never> }).updateKnowledgeAssets =
          async () => {
            throw new Error('simulated update broadcast failure');
          };
      }

      const newQuads = [q(ENTITY, 'http://schema.org/name', '"Revised"')];
      const { calls, fn } = recorder();
      let threw: unknown = null;
      try {
        await publisher.update(pub.kaId, {
          contextGraphId: CONTEXT_GRAPH,
          quads: newQuads,
          onPhase: fn,
        });
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeInstanceOf(Error);
      expect((threw as Error).message).toMatch(/simulated update broadcast failure/);

      const startIdx = calls.findIndex(([p, s]) => p === 'chain:writeahead' && s === 'start');
      const endIdx = calls.findIndex(([p, s]) => p === 'chain:writeahead' && s === 'end');
      expect(startIdx, 'update chain:writeahead:start must fire once onBroadcast is invoked').toBeGreaterThanOrEqual(0);
      expect(endIdx, 'update chain:writeahead:end must fire when the adapter throws after onBroadcast').toBeGreaterThan(startIdx);
      expect(calls.filter(([p, s]) => p === 'chain:writeahead' && s === 'start').length).toBe(1);
      expect(calls.filter(([p, s]) => p === 'chain:writeahead' && s === 'end').length).toBe(1);
    },
  );

  it('update propagates an async chain:writeahead:end listener failure', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const publisher = makeTestPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const original = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(ENTITY, 'http://schema.org/name', '"Before close failure"')],
    });
    (chain as unknown as {
      updateKnowledgeCollectionV10: (params: { onBroadcast?: () => Promise<void> | void }) => Promise<never>;
    }).updateKnowledgeCollectionV10 = async (params) => {
      await params.onBroadcast?.();
      throw new Error('simulated post-broadcast update failure');
    };

    await expect(publisher.update(original.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(ENTITY, 'http://schema.org/name', '"After close failure"')],
      onPhase: async (phase, status) => {
        if (phase === 'chain:writeahead' && status === 'end') {
          await Promise.resolve();
          throw new Error('durable write-ahead close failed');
        }
      },
    })).rejects.toThrow('durable write-ahead close failed');
  });

  it(
    'publish: structured write-ahead context carries the tx hash and the legacy breadcrumb stays ordered',
    async () => {
      const store = new OxigraphStore();
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const keypair = await generateEd25519Keypair();
      const publisher = makeTestPublisher({
        store, chain, eventBus: new TypedEventBus(), keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      });

      const quads = [q(ENTITY, 'http://schema.org/name', '"Hashed"')];
      const calls: [string, 'start' | 'end'][] = [];
      let writeAheadTxHash: string | undefined;
      let legacyContextTxHash: string | undefined;
      const fn: PhaseCallback = (phase, status, context) => {
        calls.push([phase, status]);
        if (phase.startsWith('chain:txsigned:tx-') && status === 'start') {
          legacyContextTxHash = context?.txHash;
        }
        if (phase === 'chain:writeahead' && status === 'start') {
          writeAheadTxHash = context?.txHash;
        }
      };
      await publisher.publish({ contextGraphId: CONTEXT_GRAPH, quads, onPhase: fn });

      // Exactly one txsigned:start event, with a hex hash embedded.
      const txsignedStarts = calls.filter(
        ([p, s]) => p.startsWith('chain:txsigned:tx-') && s === 'start',
      );
      expect(txsignedStarts.length).toBe(1);
      const [txPhase] = txsignedStarts[0];
      expect(txPhase).toMatch(/^chain:txsigned:tx-0x[0-9a-fA-F]{64}$/);
      expect(legacyContextTxHash).toBeUndefined();
      expect(writeAheadTxHash).toBe(txPhase.slice('chain:txsigned:tx-'.length));

      // Keep the legacy breadcrumb before the typed durable boundary for
      // compatibility, without requiring durable consumers to parse it.
      const txIdx = calls.findIndex(
        ([p, s]) => p === txPhase && s === 'start',
      );
      const waIdx = calls.findIndex(
        ([p, s]) => p === 'chain:writeahead' && s === 'start',
      );
      expect(txIdx).toBeGreaterThanOrEqual(0);
      expect(waIdx).toBeGreaterThan(txIdx);
    },
  );

  it('sub-phases are nested inside their parent', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();

    const publisher = makeTestPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const quads = [q(ENTITY, 'http://schema.org/name', '"Nested"')];
    const { calls, fn } = recorder();
    await publisher.publish({ contextGraphId: CONTEXT_GRAPH, quads, onPhase: fn });

    const idxOf = (phase: string, status: 'start' | 'end') =>
      calls.findIndex(([p, s]) => p === phase && s === status);

    // prepare:ensureContextGraph must be inside prepare
    expect(idxOf('prepare:ensureContextGraph', 'start')).toBeGreaterThan(idxOf('prepare', 'start'));
    expect(idxOf('prepare:ensureContextGraph', 'end')).toBeLessThan(idxOf('prepare', 'end'));

    // chain:sign must be inside chain
    expect(idxOf('chain:sign', 'start')).toBeGreaterThan(idxOf('chain', 'start'));
    expect(idxOf('chain:sign', 'end')).toBeLessThan(idxOf('chain', 'end'));

    // chain:submit must be inside chain
    expect(idxOf('chain:submit', 'start')).toBeGreaterThan(idxOf('chain', 'start'));
    expect(idxOf('chain:submit', 'end')).toBeLessThan(idxOf('chain', 'end'));
  });
});
