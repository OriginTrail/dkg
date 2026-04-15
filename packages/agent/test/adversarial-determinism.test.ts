/**
 * Adversarial / determinism tests aligned with 07_CCL (monotonic CAS) and
 * 03 §10–11 (VERIFY / finalization / gossip wire safety).
 */
import { describe, it, expect } from 'vitest';
import { OxigraphStore, GraphManager } from '@origintrail-official/dkg-storage';
import { FinalizationHandler } from '../src/finalization-handler.js';
import { GossipPublishHandler } from '../src/gossip-publish-handler.js';
import { monotonicTransition } from '../src/workspace-consistency.js';
import { encodeFinalizationMessage, encodePublishRequest } from '@origintrail-official/dkg-core';

const PARANET = 'adv-determinism';

async function totalQuadCount(store: OxigraphStore): Promise<number> {
  const res = await store.query('SELECT (COUNT(*) as ?c) WHERE { GRAPH ?g { ?s ?p ?o } }');
  if (res.type === 'bindings' && res.bindings.length > 0) {
    const raw = res.bindings[0].c;
    const match = raw.match(/^"(\d+)"/);
    return match ? parseInt(match[1], 10) : 0;
  }
  return 0;
}

describe('07_CCL: monotonicTransition adversarial literals', () => {
  const STAGES = ['a\nline', 'ok'] as const;

  it('escapes newline in stage strings for RDF literals', () => {
    const { condition, quad } = monotonicTransition(STAGES, 'urn:ex:s', 'urn:ex:p', 'a\nline', 'ok');
    expect(condition.expectedValue).toContain('\\n');
    expect(quad.object).toBe('"ok"');
  });
});

describe('Finalization (03 §10–11): malformed wire', () => {
  it('handleFinalizationMessage swallows corrupt protobuf without throwing', async () => {
    const store = new OxigraphStore();
    const handler = new FinalizationHandler(store, undefined);
    const countBefore = await totalQuadCount(store);

    await expect(handler.handleFinalizationMessage(new Uint8Array([0xff, 0x80, 0x01]), PARANET)).resolves.toBeUndefined();

    const countAfter = await totalQuadCount(store);
    expect(countAfter).toBe(countBefore);
  });

  it('ignores root entities that are not safe IRIs (no workspace query injection)', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);
    const handler = new FinalizationHandler(store, undefined);
    const INJECTED_ENTITY = 'not-a-valid-http-iri';

    const countBefore = await totalQuadCount(store);

    const data = encodeFinalizationMessage({
      ual: 'did:dkg:mock:31337/0x1/1',
      paranetId: PARANET,
      kcMerkleRoot: new Uint8Array(32),
      txHash: '0xabc',
      blockNumber: 1,
      batchId: 1,
      startKAId: 1,
      endKAId: 1,
      publisherAddress: '0x1111111111111111111111111111111111111111',
      rootEntities: [INJECTED_ENTITY],
      timestampMs: Date.now(),
    });

    await handler.handleFinalizationMessage(data, PARANET);

    const countAfter = await totalQuadCount(store);
    expect(countAfter).toBe(countBefore);
  });
});

describe('Gossip (03 §10–11): malformed publish broadcast', () => {
  it('handlePublishMessage does not throw on undecodable payload', async () => {
    const store = new OxigraphStore();
    const handler = new GossipPublishHandler(store, undefined, new Map(), {
      contextGraphExists: async () => false,
      getContextGraphOwner: async () => null,
      subscribeToContextGraph: () => {},
    });
    const countBefore = await totalQuadCount(store);

    await expect(
      handler.handlePublishMessage(new Uint8Array([0x0a, 0xff, 0xff, 0x01]), PARANET),
    ).resolves.toBeUndefined();

    const countAfter = await totalQuadCount(store);
    expect(countAfter).toBe(countBefore);
  });

  it('ignores publish when message paranetId does not match gossip topic', async () => {
    const store = new OxigraphStore();
    const handler = new GossipPublishHandler(store, undefined, new Map(), {
      contextGraphExists: async () => true,
      getContextGraphOwner: async () => null,
      subscribeToContextGraph: () => {},
    });
    const countBefore = await totalQuadCount(store);

    const nquads = new TextEncoder().encode(
      `<http://ex.org/e> <http://ex.org/p> "x" <did:dkg:context-graph:topic-a> .`,
    );
    const data = encodePublishRequest({
      ual: 'did:dkg:mock:31337/0x1/1',
      nquads,
      paranetId: 'topic-a',
      kas: [{ tokenId: 1, rootEntity: 'http://ex.org/e' }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x1111111111111111111111111111111111111111',
      startKAId: 1,
      endKAId: 1,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    await handler.handlePublishMessage(data, 'topic-b');

    const countAfter = await totalQuadCount(store);
    expect(countAfter).toBe(countBefore);
  });

  it('rejects gossip publish when no manifest rootEntity survives IRI safety filter', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);
    const handler = new GossipPublishHandler(store, undefined, new Map(), {
      contextGraphExists: async () => true,
      getContextGraphOwner: async () => null,
      subscribeToContextGraph: () => {},
    });
    const countBefore = await totalQuadCount(store);

    const data = encodePublishRequest({
      ual: 'did:dkg:mock:31337/0x1/99',
      nquads: new Uint8Array(0),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'http://evil">injection' }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x2222222222222222222222222222222222222222',
      startKAId: 1,
      endKAId: 1,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    await handler.handlePublishMessage(data, PARANET);

    const countAfter = await totalQuadCount(store);
    expect(countAfter).toBe(countBefore);
  });
});
