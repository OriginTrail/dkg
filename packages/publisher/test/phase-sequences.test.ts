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

let PARANET: string;
const ENTITY = 'did:dkg:agent:QmPhaseSeq';

function q(s: string, p: string, o: string, g = `did:dkg:context-graph:${PARANET}`): Quad {
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
    const cgId = await createTestContextGraph(chain);
    PARANET = String(cgId);
  });
  afterAll(async () => {
    await revertSnapshot(_fileSnapshot);
  });

  // -- Publish (happy path — with chain + signing) ----------------------

  it('publish: golden phase sequence', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
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
      contextGraphId: PARANET,
      quads,
      onPhase: fn,
    });

    const phases = stripTxSigned(calls).map(([p, s]) => `${p}:${s}`);

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
      'chain:start',
      'chain:sign:start',
      'chain:sign:end',
      'chain:submit:start',
      // Two write-ahead boundaries, emitted in order:
      //   1. `journal:writeahead` — durable intent journal persisted
      //      BEFORE any adapter RPC (TRAC approve / gas estimate /
      //      broadcast). Crash-safe at this point: on restart, the WAL
      //      lets the recovery path reconcile against chain state by
      //      matching `merkleRoot` in KnowledgeBatchCreated events.
      //   2. `chain:writeahead` — per-broadcast boundary fired from
      //      inside the adapter via the `onBroadcast` callback,
      //      immediately before `eth_sendRawTransaction` hits the
      //      wire. Listeners (e.g. the CLI daemon's operations
      //      journal) record the signed-but-not-yet-broadcast tx
      //      identity so a crash between "tx on wire" and "receipt
      //      observed" can resume without a double-submit. The
      //      corresponding RPC-spy test
      //      (`publish-ordering-rpc-spy-extra`) verifies the actual
      //      ordering against the live JSON-RPC stream.
      'journal:writeahead:start',
      'journal:writeahead:end',
      'chain:writeahead:start',
      'chain:writeahead:end',
      'chain:submit:end',
      'chain:metadata:start',
      'chain:metadata:end',
      'chain:end',
    ]);
  });

  // -- Publish (no wallet — tentative path) -----------------------------

  it('publish: tentative path omits sign/submit sub-phases', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      // No publisherPrivateKey → tentative only
    });

    const quads = [q(ENTITY, 'http://schema.org/name', '"Tentative"')];
    const { calls, fn } = recorder();
    await publisher.publish({ contextGraphId: PARANET, quads, onPhase: fn });

    const phases = calls.map(([p, s]) => `${p}:${s}`);

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
      'chain:start',
      'chain:end',
    ]);
  });

  // -- Update (happy path) -----------------------------------------------

  it('update: golden phase sequence', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    // Publish first so there's something to update
    const quads = [q(ENTITY, 'http://schema.org/name', '"Original"')];
    const pub = await publisher.publish({ contextGraphId: PARANET, quads });

    const updatedQuads = [q(ENTITY, 'http://schema.org/name', '"Updated"')];
    const { calls, fn } = recorder();
    await publisher.update(pub.kcId, {
      contextGraphId: PARANET,
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
      contextGraphId: PARANET,
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

    const publisher = new DKGPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const quads = [q(ENTITY, 'http://schema.org/name', '"Balanced"')];
    const { calls, fn } = recorder();
    await publisher.publish({ contextGraphId: PARANET, quads, onPhase: fn });

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
      const publisher = new DKGPublisher({
        store, chain, eventBus: new TypedEventBus(), keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      });

      (chain as unknown as { createKnowledgeAssetsV10: (...a: unknown[]) => Promise<never> }).createKnowledgeAssetsV10 =
        async () => {
          throw new Error('simulated preflight failure (before broadcast)');
        };

      const quads = [q(ENTITY, 'http://schema.org/name', '"Throws"')];
      const { calls, fn } = recorder();
      const result = await publisher.publish({ contextGraphId: PARANET, quads, onPhase: fn });
      expect(result.status).toBe('tentative');

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
      const publisher = new DKGPublisher({
        store, chain, eventBus: new TypedEventBus(), keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      });

      (chain as unknown as { createKnowledgeAssetsV10: (params: { onBroadcast?: () => void }) => Promise<never> }).createKnowledgeAssetsV10 =
        async (params) => {
          params.onBroadcast?.();
          throw new Error('simulated publish broadcast failure');
        };

      const quads = [q(ENTITY, 'http://schema.org/name', '"Throws"')];
      const { calls, fn } = recorder();
      const result = await publisher.publish({ contextGraphId: PARANET, quads, onPhase: fn });
      expect(result.status).toBe('tentative');

      const startIdx = calls.findIndex(([p, s]) => p === 'chain:writeahead' && s === 'start');
      const endIdx = calls.findIndex(([p, s]) => p === 'chain:writeahead' && s === 'end');
      expect(startIdx, 'chain:writeahead:start must fire once onBroadcast is invoked').toBeGreaterThanOrEqual(0);
      expect(endIdx, 'chain:writeahead:end must fire when the adapter throws after onBroadcast').toBeGreaterThan(startIdx);
      expect(calls.filter(([p, s]) => p === 'chain:writeahead' && s === 'start').length).toBe(1);
      expect(calls.filter(([p, s]) => p === 'chain:writeahead' && s === 'end').length).toBe(1);
    },
  );

  it(
    'update: chain:writeahead pairs start with end when adapter calls onBroadcast THEN throws ' +
      '(P-1 iter-2 regression — update re-throws, WAL window still closed)',
    async () => {
      const store = new OxigraphStore();
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const keypair = await generateEd25519Keypair();
      const publisher = new DKGPublisher({
        store, chain, eventBus: new TypedEventBus(), keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      });

      const origQuads = [q(ENTITY, 'http://schema.org/name', '"Seed"')];
      const pub = await publisher.publish({ contextGraphId: PARANET, quads: origQuads });
      expect(pub.status).toBe('confirmed');

      (chain as unknown as { updateKnowledgeCollectionV10: (params: { onBroadcast?: () => void }) => Promise<never> }).updateKnowledgeCollectionV10 =
        async (params) => {
          params.onBroadcast?.();
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
        await publisher.update(pub.kcId, {
          contextGraphId: PARANET,
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

  it(
    'publish: chain:txsigned:tx-<hash> breadcrumb fires exactly once BEFORE chain:writeahead:start ' +
      '(PR #241 Codex iter-5: the WAL checkpoint must carry the pre-broadcast tx hash per spec §06)',
    async () => {
      const store = new OxigraphStore();
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const keypair = await generateEd25519Keypair();
      const publisher = new DKGPublisher({
        store, chain, eventBus: new TypedEventBus(), keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      });

      const quads = [q(ENTITY, 'http://schema.org/name', '"Hashed"')];
      const { calls, fn } = recorder();
      await publisher.publish({ contextGraphId: PARANET, quads, onPhase: fn });

      // Exactly one txsigned:start event, with a hex hash embedded.
      const txsignedStarts = calls.filter(
        ([p, s]) => p.startsWith('chain:txsigned:tx-') && s === 'start',
      );
      expect(txsignedStarts.length).toBe(1);
      const [txPhase] = txsignedStarts[0];
      expect(txPhase).toMatch(/^chain:txsigned:tx-0x[0-9a-fA-F]{64}$/);

      // txsigned must fire BEFORE chain:writeahead:start — the WAL
      // checkpoint value (the hash) has to be observable at the moment
      // the listener learns a broadcast is imminent.
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

    const publisher = new DKGPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const quads = [q(ENTITY, 'http://schema.org/name', '"Nested"')];
    const { calls, fn } = recorder();
    await publisher.publish({ contextGraphId: PARANET, quads, onPhase: fn });

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
