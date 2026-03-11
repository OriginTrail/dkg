/**
 * Phase-sequence contract tests.
 *
 * These golden-sequence snapshots break if someone adds, removes, or
 * reorders an onPhase call inside publish() or update().  That's the
 * point — the operation tracker on the Node UI relies on these exact
 * sequences, and any change must be deliberate.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TypedEventBus,
  generateEd25519Keypair,
  createOperationContext,
  encodeWorkspacePublishRequest,
} from '@dkg/core';
import { OxigraphStore, type Quad } from '@dkg/storage';
import { MockChainAdapter } from '@dkg/chain';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { WorkspaceHandler } from '../src/workspace-handler.js';
import { ethers } from 'ethers';
import type { PhaseCallback } from '../src/publisher.js';

const PARANET = 'test-phase-seq';
const ENTITY = 'did:dkg:agent:QmPhaseSeq';

function q(s: string, p: string, o: string, g = `did:dkg:paranet:${PARANET}`): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function recorder(): { calls: [string, 'start' | 'end'][]; fn: PhaseCallback } {
  const calls: [string, 'start' | 'end'][] = [];
  const fn: PhaseCallback = (phase, status) => { calls.push([phase, status]); };
  return { calls, fn };
}

describe('Phase-sequence contracts', () => {

  // -- Publish (happy path — with chain + signing) ----------------------

  it('publish: golden phase sequence', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const quads = [
      q(ENTITY, 'http://schema.org/name', '"PhaseBot"'),
      q(ENTITY, 'http://schema.org/version', '"1"'),
    ];

    const { calls, fn } = recorder();
    await publisher.publish({
      paranetId: PARANET,
      quads,
      onPhase: fn,
    });

    const phases = calls.map(([p, s]) => `${p}:${s}`);

    expect(phases).toEqual([
      'prepare:start',
      'prepare:ensureParanet:start',
      'prepare:ensureParanet:end',
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
      'chain:submit:end',
      'chain:metadata:start',
      'chain:metadata:end',
      'chain:end',
    ]);
  });

  // -- Publish (no wallet — tentative path) -----------------------------

  it('publish: tentative path omits sign/submit sub-phases', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
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
    await publisher.publish({ paranetId: PARANET, quads, onPhase: fn });

    const phases = calls.map(([p, s]) => `${p}:${s}`);

    expect(phases).toEqual([
      'prepare:start',
      'prepare:ensureParanet:start',
      'prepare:ensureParanet:end',
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
    const wallet = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });

    // Publish first so there's something to update
    const quads = [q(ENTITY, 'http://schema.org/name', '"Original"')];
    const pub = await publisher.publish({ paranetId: PARANET, quads });

    const updatedQuads = [q(ENTITY, 'http://schema.org/name', '"Updated"')];
    const { calls, fn } = recorder();
    await publisher.update(pub.kcId, {
      paranetId: PARANET,
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
      'chain:submit:end',
      'chain:end',
      'store:start',
      'store:end',
    ]);
  });

  // -- Workspace handler -------------------------------------------------

  it('workspace handle: golden phase sequence', async () => {
    const store = new OxigraphStore();
    const handler = new WorkspaceHandler(store, new TypedEventBus());

    const quads = [q(ENTITY, 'http://schema.org/name', '"WS draft"')];
    const nquads = quads
      .map(t => `<${t.subject}> <${t.predicate}> ${t.object} .`)
      .join('\n');

    const msg = encodeWorkspacePublishRequest({
      workspaceOperationId: 'ws-test-001',
      paranetId: PARANET,
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
      'validate:start',
      'validate:end',
      'store:start',
      'store:end',
    ]);
  });

  // -- Structural invariants --------------------------------------------

  it('every start has a matching end', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const quads = [q(ENTITY, 'http://schema.org/name', '"Balanced"')];
    const { calls, fn } = recorder();
    await publisher.publish({ paranetId: PARANET, quads, onPhase: fn });

    const starts = calls.filter(([, s]) => s === 'start').map(([p]) => p);
    const ends = calls.filter(([, s]) => s === 'end').map(([p]) => p);

    for (const phase of starts) {
      expect(ends).toContain(phase);
    }
  });

  it('sub-phases are nested inside their parent', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const quads = [q(ENTITY, 'http://schema.org/name', '"Nested"')];
    const { calls, fn } = recorder();
    await publisher.publish({ paranetId: PARANET, quads, onPhase: fn });

    const idxOf = (phase: string, status: 'start' | 'end') =>
      calls.findIndex(([p, s]) => p === phase && s === status);

    // prepare:ensureParanet must be inside prepare
    expect(idxOf('prepare:ensureParanet', 'start')).toBeGreaterThan(idxOf('prepare', 'start'));
    expect(idxOf('prepare:ensureParanet', 'end')).toBeLessThan(idxOf('prepare', 'end'));

    // chain:sign must be inside chain
    expect(idxOf('chain:sign', 'start')).toBeGreaterThan(idxOf('chain', 'start'));
    expect(idxOf('chain:sign', 'end')).toBeLessThan(idxOf('chain', 'end'));

    // chain:submit must be inside chain
    expect(idxOf('chain:submit', 'start')).toBeGreaterThan(idxOf('chain', 'start'));
    expect(idxOf('chain:submit', 'end')).toBeLessThan(idxOf('chain', 'end'));
  });
});
