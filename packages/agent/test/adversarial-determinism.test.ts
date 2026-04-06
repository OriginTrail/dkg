/**
 * Adversarial / determinism tests aligned with 07_CCL (monotonic CAS) and
 * 03 §10–11 (VERIFY / finalization / gossip wire safety).
 */
import { describe, it, expect, vi } from 'vitest';
import { OxigraphStore, GraphManager } from '@origintrail-official/dkg-storage';
import { FinalizationHandler } from '../src/finalization-handler.js';
import { GossipPublishHandler } from '../src/gossip-publish-handler.js';
import { monotonicTransition } from '../src/workspace-consistency.js';
import { encodeFinalizationMessage, encodePublishRequest } from '@origintrail-official/dkg-core';

const PARANET = 'adv-determinism';

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
    const insertSpy = vi.spyOn(store, 'insert');

    await expect(handler.handleFinalizationMessage(new Uint8Array([0xff, 0x80, 0x01]), PARANET)).resolves.toBeUndefined();

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('ignores root entities that are not safe IRIs (no workspace query injection)', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);
    const handler = new FinalizationHandler(store, undefined);
    const insertSpy = vi.spyOn(store, 'insert');
    const querySpy = vi.spyOn(store, 'query');
    const INJECTED_ENTITY = 'not-a-valid-http-iri';

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

    expect(insertSpy).not.toHaveBeenCalled();
    // Verify the injected entity never appeared in any SPARQL query
    for (const call of querySpy.mock.calls) {
      expect(String(call[0])).not.toContain(INJECTED_ENTITY);
    }
  });
});

describe('Gossip (03 §10–11): malformed publish broadcast', () => {
  it('handlePublishMessage does not throw on undecodable payload', async () => {
    const store = new OxigraphStore();
    const handler = new GossipPublishHandler(store, undefined, new Map(), {
      paranetExists: async () => false,
      subscribeToParanet: () => {},
    });
    const insertSpy = vi.spyOn(store, 'insert');

    await expect(
      handler.handlePublishMessage(new Uint8Array([0x0a, 0xff, 0xff, 0x01]), PARANET),
    ).resolves.toBeUndefined();

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('ignores publish when message paranetId does not match gossip topic', async () => {
    const store = new OxigraphStore();
    const handler = new GossipPublishHandler(store, undefined, new Map(), {
      paranetExists: async () => true,
      subscribeToParanet: () => {},
    });
    const insertSpy = vi.spyOn(store, 'insert');

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

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('rejects gossip publish when no manifest rootEntity survives IRI safety filter', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);
    const handler = new GossipPublishHandler(store, undefined, new Map(), {
      paranetExists: async () => true,
      subscribeToParanet: () => {},
    });
    const insertSpy = vi.spyOn(store, 'insert');

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

    expect(insertSpy).not.toHaveBeenCalled();
  });
});
