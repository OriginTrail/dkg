import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  SYSTEM_CONTEXT_GRAPHS,
  createGraphKnowledgeAssetScope,
  createOperationContext,
  decodePublishRequest,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  computePrivateRootV10,
  skolemizeKnowledgeAssetParts,
  type PublishOptions,
  type PublishResult,
} from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/index.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';

const AUTHOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const KA_NUMBER = 7n;
const RESERVED_KA_ID = (BigInt(AUTHOR) << 96n) | KA_NUMBER;

describe('direct rootless agent publish entrypoint', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => undefined);
    agent = undefined;
  });

  it('passes one complete V2 graph envelope into the publisher and broadcast', async () => {
    agent = await DKGAgent.create({
      name: 'DirectRootlessPublish',
      store: new OxigraphStore(),
      chainAdapter: new MockChainAdapter('mock:31337', AUTHOR),
      kaNumberAllocator: makeTestKaNumberAllocator(),
      nodeRole: 'edge',
      skills: [],
    });
    const internals = agent as unknown as Record<string, any>;
    Object.defineProperty(agent, 'peerId', {
      value: '12D3KooWRootlessPublisher',
      configurable: true,
    });
    internals.getContextGraphOnChainId = vi.fn(async () => '42');
    internals.isPrivateContextGraph = vi.fn(async () => true);
    internals.createV10ACKProvider = vi.fn(() => undefined);
    internals._resolveEncryptInlinePayload = vi.fn(async () => undefined);
    internals._resolveEncryptInlineChunked = vi.fn(async () => undefined);
    internals.emitPublicProjectionAfterPublish = vi.fn(async () => undefined);
    let capturedOptions: PublishOptions | undefined;
    const fakePublisher = {
      publisherFallbackAuthorAddress: vi.fn(async () => AUTHOR),
      signAuthorAttestationAsPublisher: vi.fn(async () => ({
        r: new Uint8Array(32).fill(0x22),
        vs: new Uint8Array(32).fill(0x33),
      })),
      publish: vi.fn(async (options: PublishOptions): Promise<PublishResult> => {
        capturedOptions = options;
        return {
          kaId: options.precomputedAttestation!.reservedKaId!,
          ual: options.kaUal!,
          merkleRoot: options.precomputedAttestation!.expectedMerkleRoot,
          kaManifest: [],
          status: 'confirmed',
          publicQuads: options.quads,
          contentScopeVersion: options.contentScopeVersion,
          assertionVersion: String(options.assertionVersion),
          publicTripleCount: options.publicTripleCount,
          privateMerkleRoot: options.privateMerkleRoot,
          privateTripleCount: options.privateTripleCount,
          accessPolicy: options.accessPolicy ?? 'ownerOnly',
          allowedPeers: options.allowedPeers ?? [],
        };
      }),
    };
    Object.defineProperty(agent, 'publisher', {
      value: fakePublisher,
      writable: true,
      configurable: true,
    });
    const broadcastPublish = vi.fn(async () => undefined);
    internals.broadcastPublish = broadcastPublish;

    const publicQuads: Quad[] = [{
      subject: 'urn:private:asset',
      predicate: 'urn:p:value',
      object: '"public projection"',
      graph: '',
    }];
    const privateQuads: Quad[] = [{
      subject: 'urn:private:asset',
      predicate: 'urn:p:secret',
      object: '"hidden"',
      graph: '',
    }];
    const result = await internals._publish(
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      publicQuads,
      privateQuads,
      { accessPolicy: 'ownerOnly', onChainContextGraphId: '42' },
    );

    expect(result.status).toBe('confirmed');
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions).toMatchObject({
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: `did:dkg:mock:31337/${AUTHOR}/0`,
      assertionVersion: '1',
      privateTripleCount: 1,
      accessPolicy: 'ownerOnly',
      publishContextGraphId: '42',
    });
    // A curated direct publish replaces any caller-provided catalog partition
    // with the deterministic four-triple public floor inside this same KA.
    expect(capturedOptions!.quads).toHaveLength(5);
    expect(capturedOptions!.publicTripleCount).toBe(5);
    expect(capturedOptions!.privateMerkleRoot).toHaveLength(32);
    expect(capturedOptions!.trustedNonManifestCatalogTriples).toHaveLength(4);
    expect(capturedOptions!.quads.some((quad) =>
      quad.subject === 'did:dkg:context-graph:ontology'
      && quad.predicate === 'http://purl.org/dc/terms/accessRights'
    )).toBe(true);
    const canonical = await skolemizeKnowledgeAssetParts(capturedOptions!.quads, privateQuads);
    const expectedPrivateRoot = computePrivateRootV10(canonical.privateQuads);
    const expectedMerkleRoot = computeFlatKCRootV10(
      canonical.publicQuads,
      expectedPrivateRoot ? [expectedPrivateRoot] : [],
    );
    expect(ethers.hexlify(capturedOptions!.precomputedAttestation!.expectedMerkleRoot))
      .toBe(ethers.hexlify(expectedMerkleRoot));
    expect(capturedOptions!.precomputedAttestation!.reservedKaId)
      .toBe(BigInt(AUTHOR) << 96n);
    expect(broadcastPublish).toHaveBeenCalledWith(
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      expect.objectContaining({
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaManifest: [],
      }),
      expect.any(Object),
      { accessPolicy: 'ownerOnly', allowedPeers: undefined, curated: true },
    );
  });

  it('never sends curated graph-scoped assertion plaintext on the ordinary publish topic', async () => {
    agent = await DKGAgent.create({
      name: 'CuratedRootlessBroadcast',
      store: new OxigraphStore(),
      chainAdapter: new MockChainAdapter('mock:31337', AUTHOR),
      nodeRole: 'edge',
      skills: [],
    });
    const internals = agent as unknown as Record<string, any>;
    const publish = vi.fn(async () => undefined);
    internals.gossip = { publish };

    await internals.broadcastPublish(
      '42',
      {
        kaId: RESERVED_KA_ID,
        ual: `did:dkg:mock:31337/${AUTHOR}/${KA_NUMBER}`,
        merkleRoot: new Uint8Array(32),
        kaManifest: [],
        status: 'confirmed',
        publicQuads: [{
          subject: 'urn:curated:secret',
          predicate: 'urn:p:value',
          object: '"must-not-leak"',
          graph: '',
        }],
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        assertionVersion: '1',
        publicTripleCount: 1,
        privateTripleCount: 0,
      },
      createOperationContext('publish'),
      { accessPolicy: 'ownerOnly', curated: true },
    );

    expect(publish).not.toHaveBeenCalled();
  });

  it('broadcasts the exact UAL-derived graph and no legacy root manifest', async () => {
    agent = await DKGAgent.create({
      name: 'RootlessBroadcastWire',
      store: new OxigraphStore(),
      chainAdapter: new MockChainAdapter('mock:31337', AUTHOR),
      nodeRole: 'edge',
      skills: [],
    });
    const internals = agent as unknown as Record<string, any>;
    let wire: Uint8Array | undefined;
    internals.gossip = {
      publish: vi.fn(async (_topic: string, data: Uint8Array) => {
        wire = data;
      }),
    };
    const ual = `did:dkg:mock:31337/${AUTHOR}/${KA_NUMBER}`;
    const scope = createGraphKnowledgeAssetScope(ual, 1);
    const expectedGraph = knowledgeAssetLayerGraphUri(
      '42',
      MemoryLayer.VerifiableMemory,
      scope,
    );
    await internals.broadcastPublish(
      '42',
      {
        kaId: RESERVED_KA_ID,
        ual,
        merkleRoot: new Uint8Array(32).fill(0x11),
        kaManifest: [],
        status: 'confirmed',
        publicQuads: [{
          subject: 'urn:rootless:subject',
          predicate: 'urn:rootless:predicate',
          object: '"value"',
          graph: 'urn:ignored:placement',
        }],
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        assertionVersion: '1',
        publicTripleCount: 1,
        privateTripleCount: 0,
        accessPolicy: 'allowList',
        allowedPeers: ['12D3KooWReader'],
        onChainResult: {
          batchId: RESERVED_KA_ID,
          kaId: RESERVED_KA_ID,
          startKAId: RESERVED_KA_ID,
          endKAId: RESERVED_KA_ID,
          txHash: `0x${'11'.repeat(32)}`,
          blockNumber: 12,
          blockTimestamp: 1,
          publisherAddress: AUTHOR,
        },
      },
      createOperationContext('publish'),
    );

    expect(wire).toBeDefined();
    const decoded = decodePublishRequest(wire!);
    expect(decoded.kas).toEqual([]);
    expect(decoded.contentScopeVersion).toBe(GRAPH_KA_CONTENT_SCOPE_VERSION);
    expect(decoded.assertionVersion).toBe('1');
    expect(decoded.publicTripleCount).toBe(1);
    expect(decoded.privateTripleCount).toBe(0);
    expect(decoded.accessPolicy).toBe('allowList');
    expect(decoded.allowedPeers).toEqual(['12D3KooWReader']);
    expect(new TextDecoder().decode(decoded.nquads)).toBe(
      `<urn:rootless:subject> <urn:rootless:predicate> "value" <${expectedGraph}> .`,
    );
  });
});
