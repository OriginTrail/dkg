/**
 * PR #1715 review — the receiver tests inject hand-built finalization
 * messages, so the PRODUCTION envelope construction was unprotected: a wrong
 * `publicTripleCount`, a mis-stringified `assertionVersion`, or a dropped
 * `privateMerkleRoot` would pass every handler test while breaking real
 * interop. This decodes the actual broadcast payload emitted by
 * `publishFromSharedMemory` with a graph-scoped content envelope.
 */
import { describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  contextGraphFinalizationTopic,
  decodeFinalizationMessage,
} from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, computePrivateRootV10 } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';

const CG = 'finalization-envelope-cg';
const AUTHOR = '0x3333333333333333333333333333333333333333';
const PUBLISHER = '0x4444444444444444444444444444444444444444';
const KA_UAL = `did:dkg:hardhat:31337/${AUTHOR}/11`;
const PACKED_KA_ID = (BigInt(AUTHOR) << 96n) | 11n;

class CapturingGossip {
  published: Array<{ topic: string; data: Uint8Array }> = [];

  subscribe(_topic: string): void {}
  unsubscribe(_topic: string): void {}
  onMessage(
    _topic: string,
    _handler: (topic: string, data: Uint8Array, from?: string) => void | Promise<void>,
  ): void {}

  async publish(topic: string, data: Uint8Array): Promise<void> {
    this.published.push({ topic, data });
  }

  getSubscribers(_topic: string): string[] { return []; }
}

describe('outgoing graph-scoped finalization envelope', () => {
  it('broadcasts the exact content envelope the finalization handler verifies', async () => {
    const agent = await DKGAgent.create({
      name: 'GraphScopedEnvelope',
      chainAdapter: new MockChainAdapter(),
    });
    const gossip = new CapturingGossip();
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;
    Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
      value: { toString: () => '12D3KooWEnvelopePublisher' },
      configurable: true,
    });

    const privateQuads: Quad[] = [{
      subject: 'urn:asset:secret',
      predicate: 'urn:predicate:value',
      object: '"hidden"',
      graph: '',
    }];
    const privateMerkleRoot = computePrivateRootV10(privateQuads);
    if (!privateMerkleRoot) throw new Error('expected private commitment');
    const publicQuads: Quad[] = [
      { subject: 'urn:asset:one', predicate: 'urn:predicate:value', object: '"one"', graph: '' },
      { subject: 'urn:asset:two', predicate: 'urn:predicate:value', object: '"two"', graph: '' },
    ];
    const merkleRoot = computeFlatKCRootV10(publicQuads, [privateMerkleRoot]);

    // The publisher result is stubbed: this test pins the AGENT-side envelope
    // construction from the confirmed publish result + graph-scoped options.
    const publisherStub = {
      publishFromSharedMemory: async () => ({
        status: 'confirmed' as const,
        ual: KA_UAL,
        merkleRoot,
        kaManifest: [],
        onChainResult: {
          txHash: `0x${'12'.repeat(32)}`,
          blockNumber: 321,
          txIndex: 5,
          batchId: PACKED_KA_ID,
          startKAId: PACKED_KA_ID,
          endKAId: PACKED_KA_ID,
          publisherAddress: PUBLISHER,
        },
      }),
    };

    await agent.publishFromSharedMemory(CG, 'all', {
      publisherOverride: publisherStub as never,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: KA_UAL,
      assertionVersion: 1,
      publicTripleCount: publicQuads.length,
      privateMerkleRoot,
      privateTripleCount: privateQuads.length,
    });

    const broadcast = gossip.published.find(
      (entry) => entry.topic === contextGraphFinalizationTopic(CG),
    );
    expect(broadcast).toBeDefined();
    const decoded = decodeFinalizationMessage(broadcast!.data);

    expect(decoded.ual).toBe(KA_UAL);
    expect(decoded.contextGraphId).toBe(CG);
    expect(decoded.contentScopeVersion).toBe(GRAPH_KA_CONTENT_SCOPE_VERSION);
    expect(String(decoded.assertionVersion)).toBe('1');
    expect(Number(decoded.publicTripleCount)).toBe(2);
    expect(Number(decoded.privateTripleCount)).toBe(1);
    expect(decoded.privateMerkleRoot ? Array.from(decoded.privateMerkleRoot) : undefined)
      .toEqual(Array.from(privateMerkleRoot));
    expect(Array.from(decoded.kcMerkleRoot)).toEqual(Array.from(merkleRoot));
    expect(decoded.rootEntities).toEqual([]);
    expect(BigInt(decoded.batchId)).toBe(PACKED_KA_ID);
    expect(BigInt(decoded.startKAId)).toBe(PACKED_KA_ID);
    expect(BigInt(decoded.endKAId)).toBe(PACKED_KA_ID);
    expect(decoded.publisherAddress).toBe(PUBLISHER);
    expect(decoded.txHash).toBe(`0x${'12'.repeat(32)}`);
  });

  it('omits the private commitment for a public-only graph-scoped publish', async () => {
    const agent = await DKGAgent.create({
      name: 'GraphScopedEnvelopePublic',
      chainAdapter: new MockChainAdapter(),
    });
    const gossip = new CapturingGossip();
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;
    Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
      value: { toString: () => '12D3KooWEnvelopePublisher' },
      configurable: true,
    });

    const publicQuads: Quad[] = [
      { subject: 'urn:asset:solo', predicate: 'urn:predicate:value', object: '"solo"', graph: '' },
    ];
    const merkleRoot = computeFlatKCRootV10(publicQuads, []);
    const publisherStub = {
      publishFromSharedMemory: async () => ({
        status: 'confirmed' as const,
        ual: KA_UAL,
        merkleRoot,
        kaManifest: [],
        onChainResult: {
          txHash: `0x${'34'.repeat(32)}`,
          blockNumber: 322,
          txIndex: 0,
          batchId: PACKED_KA_ID,
          startKAId: PACKED_KA_ID,
          endKAId: PACKED_KA_ID,
          publisherAddress: PUBLISHER,
        },
      }),
    };

    await agent.publishFromSharedMemory(CG, 'all', {
      publisherOverride: publisherStub as never,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: KA_UAL,
      assertionVersion: 1,
      publicTripleCount: publicQuads.length,
      privateTripleCount: 0,
    });

    const broadcast = gossip.published.find(
      (entry) => entry.topic === contextGraphFinalizationTopic(CG),
    );
    expect(broadcast).toBeDefined();
    const decoded = decodeFinalizationMessage(broadcast!.data);
    expect(decoded.contentScopeVersion).toBe(GRAPH_KA_CONTENT_SCOPE_VERSION);
    expect(Number(decoded.publicTripleCount)).toBe(1);
    expect(Number(decoded.privateTripleCount)).toBe(0);
    expect(decoded.privateMerkleRoot?.length ?? 0).toBe(0);
  });
});
