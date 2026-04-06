/**
 * Phase-sequence contract tests for agent-level operations.
 *
 * Golden-sequence snapshots for gossip and sync phase callbacks.
 * If someone changes the order/names of onPhase calls in the
 * gossip-publish-handler or dkg-agent sync, these tests break — on purpose.
 */
import { describe, it, expect } from 'vitest';
import { encodePublishRequest } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { GossipPublishHandler, type GossipPhaseCallback } from '../src/gossip-publish-handler.js';

const PARANET = 'test-phase-seq';

function recorder(): { calls: [string, 'start' | 'end'][]; fn: GossipPhaseCallback } {
  const calls: [string, 'start' | 'end'][] = [];
  const fn: GossipPhaseCallback = (phase, status) => { calls.push([phase, status]); };
  return { calls, fn };
}

function makePublishMsg(opts?: { ual?: string; nquads?: string }): Uint8Array {
  return encodePublishRequest({
    ual: opts?.ual ?? 'did:dkg:mock:31337/0xabc/1',
    nquads: new TextEncoder().encode(
      opts?.nquads ?? '<http://example.org/s> <http://example.org/p> <http://example.org/o> .',
    ),
    contextGraphId: PARANET,
    kas: [{ tokenId: 1, rootEntity: 'http://example.org/s', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
    publisherIdentity: new Uint8Array(32),
    publisherAddress: '0x1111111111111111111111111111111111111111',
    startKAId: 0,
    endKAId: 0,
    chainId: 'mock:31337',
    publisherSignatureR: new Uint8Array(0),
    publisherSignatureVs: new Uint8Array(0),
  });
}

describe('Gossip handler phase-sequence contract', () => {
  it('gossip publish: golden phase sequence (no chain proof)', async () => {
    const store = new OxigraphStore();
    const handler = new GossipPublishHandler(
      store, undefined, new Map(),
      { contextGraphExists: async () => false, subscribeToContextGraph: () => {} },
    );

    const { calls, fn } = recorder();
    await handler.handlePublishMessage(makePublishMsg(), PARANET, fn);

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

  it('gossip publish: empty broadcast (no UAL) emits decode only', async () => {
    const store = new OxigraphStore();
    const handler = new GossipPublishHandler(
      store, undefined, new Map(),
      { contextGraphExists: async () => false, subscribeToContextGraph: () => {} },
    );

    const msg = encodePublishRequest({
      ual: '',
      nquads: new Uint8Array(0),
      contextGraphId: PARANET,
      kas: [],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x0000000000000000000000000000000000000000',
      startKAId: 0,
      endKAId: 0,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    const { calls, fn } = recorder();
    await handler.handlePublishMessage(msg, PARANET, fn);

    const phases = calls.map(([p, s]) => `${p}:${s}`);

    // Empty broadcast: decode starts but handler returns early after decode
    expect(phases).toEqual([
      'decode:start',
      'decode:end',
    ]);
  });

  it('every start has a matching end', async () => {
    const store = new OxigraphStore();
    const handler = new GossipPublishHandler(
      store, undefined, new Map(),
      { contextGraphExists: async () => false, subscribeToContextGraph: () => {} },
    );

    const { calls, fn } = recorder();
    await handler.handlePublishMessage(makePublishMsg(), PARANET, fn);

    const starts = calls.filter(([, s]) => s === 'start').map(([p]) => p);
    const ends = calls.filter(([, s]) => s === 'end').map(([p]) => p);
    for (const phase of starts) {
      expect(ends).toContain(phase);
    }
  });
});
