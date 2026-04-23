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

    const phases = calls.map(([p, s]) => `${p}:${s}`);

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
  // Codex review on PR #241: the happy-path snapshot tests only prove
  // `chain:writeahead:start` pairs with `:end` when the adapter
  // returns normally. The P-1 regression was that if the adapter
  // throws mid-broadcast, `:start` fires but `:end` never does,
  // leaving the operation journal with an open write-ahead entry
  // the UI cannot close.
  //
  // Publish intentionally SWALLOWS adapter throws and degrades to
  // the tentative path (see packages/publisher/src/dkg-publisher.ts
  // around `on-chain tx failed`). Update intentionally RE-THROWS.
  // Both paths must still emit balanced `chain:writeahead:start` +
  // `:end` so the UI operations journal can close the entry.
  // Force an internal throw and assert the balance explicitly.

  it(
    'publish: chain:writeahead pairs start with end even when the adapter throws ' +
      'mid-broadcast (P-1 regression — publish degrades to tentative)',
    async () => {
      const store = new OxigraphStore();
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const keypair = await generateEd25519Keypair();

      const publisher = new DKGPublisher({
        store, chain, eventBus: new TypedEventBus(), keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      });

      // Stub the adapter call so it throws after chain:writeahead:start
      // should have fired. We do NOT touch anything upstream of the
      // write-ahead boundary — preflight (isV10Ready, signMessage,
      // ACK self-sign) must still succeed so the boundary is
      // actually reached. Assign *after* the publisher is constructed.
      (chain as unknown as { createKnowledgeAssetsV10: (...a: unknown[]) => Promise<never> }).createKnowledgeAssetsV10 =
        async () => {
          throw new Error('simulated publish broadcast failure');
        };

      const quads = [q(ENTITY, 'http://schema.org/name', '"Throws"')];
      const { calls, fn } = recorder();
      // Publish swallows the chain error and returns tentative.
      const result = await publisher.publish({ contextGraphId: PARANET, quads, onPhase: fn });
      expect(result.status).toBe('tentative');

      const startIdx = calls.findIndex(
        ([p, s]) => p === 'chain:writeahead' && s === 'start',
      );
      const endIdx = calls.findIndex(
        ([p, s]) => p === 'chain:writeahead' && s === 'end',
      );
      expect(startIdx, 'chain:writeahead:start must fire before the throw').toBeGreaterThanOrEqual(0);
      expect(endIdx, 'chain:writeahead:end must fire even on adapter throw').toBeGreaterThan(startIdx);

      // Exactly once — the `finally` must not double-fire.
      const writeaheadStartCount = calls.filter(
        ([p, s]) => p === 'chain:writeahead' && s === 'start',
      ).length;
      const writeaheadEndCount = calls.filter(
        ([p, s]) => p === 'chain:writeahead' && s === 'end',
      ).length;
      expect(writeaheadStartCount).toBe(1);
      expect(writeaheadEndCount).toBe(1);
    },
  );

  it(
    'update: chain:writeahead pairs start with end even when the adapter throws ' +
      'mid-broadcast (P-1 regression — update re-throws)',
    async () => {
      const store = new OxigraphStore();
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const keypair = await generateEd25519Keypair();

      const publisher = new DKGPublisher({
        store, chain, eventBus: new TypedEventBus(), keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      });

      // Real publish first so the kcId is on-chain and the update
      // path can reach the write-ahead phase.
      const origQuads = [q(ENTITY, 'http://schema.org/name', '"Seed"')];
      const pub = await publisher.publish({ contextGraphId: PARANET, quads: origQuads });
      expect(pub.status).toBe('confirmed');

      // Now replace only the update path so the previous publish
      // used the real adapter call. Update does NOT swallow — it
      // re-throws, so we catch manually and still inspect phases.
      // Stub BOTH the V10 and legacy V9 update methods, otherwise
      // the publisher silently falls back from V10 to V9 when the
      // V10 error isn't one of its "definitive" classes (see
      // packages/publisher/src/dkg-publisher.ts `V10_DEFINITIVE_ERRORS`).
      (chain as unknown as { updateKnowledgeCollectionV10: (...a: unknown[]) => Promise<never> }).updateKnowledgeCollectionV10 =
        async () => {
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

      const startIdx = calls.findIndex(
        ([p, s]) => p === 'chain:writeahead' && s === 'start',
      );
      const endIdx = calls.findIndex(
        ([p, s]) => p === 'chain:writeahead' && s === 'end',
      );
      expect(startIdx, 'update chain:writeahead:start must fire before the throw').toBeGreaterThanOrEqual(0);
      expect(endIdx, 'update chain:writeahead:end must fire even on adapter throw').toBeGreaterThan(startIdx);

      expect(calls.filter(([p, s]) => p === 'chain:writeahead' && s === 'start').length).toBe(1);
      expect(calls.filter(([p, s]) => p === 'chain:writeahead' && s === 'end').length).toBe(1);
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
