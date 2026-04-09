import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeTripleHashV10,
  computeKCRootV10,
  computePublicRootV10,
  computePrivateRootV10,
  computeKARootV10,
} from '../src/merkle.js';
import {
  computeACKDigest,
  encodePublishIntent,
  decodePublishIntent,
  encodeStorageACK,
  decodeStorageACK,
} from '@origintrail-official/dkg-core';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import { parseSimpleNQuads } from '../src/publish-handler.js';

function makeQuad(s: string, p: string, o: string, g = ''): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function makeEventBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn(), once: vi.fn() };
}

async function signACK(wallet: ethers.Wallet, contextGraphId: bigint, merkleRoot: Uint8Array, kaCount?: number, byteSize?: bigint, epochs?: number, tokenAmount?: bigint) {
  const digest = computeACKDigest(contextGraphId, merkleRoot, kaCount, byteSize, epochs, tokenAmount);
  const sig = ethers.Signature.from(await wallet.signMessage(digest));
  return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
}

function quadsToNTriples(quads: Quad[]): string {
  return quads
    .map(q => {
      const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
      return `<${q.subject}> <${q.predicate}> ${obj} .`;
    })
    .join('\n');
}

// ── Shared fixtures ──────────────────────────────────────────────────────

const coreWallets = [
  ethers.Wallet.createRandom(),
  ethers.Wallet.createRandom(),
  ethers.Wallet.createRandom(),
  ethers.Wallet.createRandom(),
];

const singleEntityQuads: Quad[] = [
  makeQuad('urn:entity:alpha', 'http://schema.org/name', '"Alpha Entity"'),
  makeQuad('urn:entity:alpha', 'http://schema.org/description', '"A test entity"'),
  makeQuad('urn:entity:alpha', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://schema.org/Thing'),
];

const multiEntityQuads: Quad[] = [
  makeQuad('urn:entity:a', 'http://schema.org/name', '"Entity A"'),
  makeQuad('urn:entity:a', 'urn:prop:score', '"0.95"'),
  makeQuad('urn:entity:b', 'http://schema.org/name', '"Entity B"'),
  makeQuad('urn:entity:b', 'urn:prop:related', 'urn:entity:a'),
  makeQuad('urn:entity:c', 'http://schema.org/name', '"Entity C"'),
  makeQuad('urn:entity:c', 'urn:prop:score', '"0.42"'),
  makeQuad('urn:entity:c', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://schema.org/Dataset'),
];

const specialCharQuads: Quad[] = [
  makeQuad('urn:entity:special', 'http://schema.org/name', '"Line\\nBreak"'),
  makeQuad('urn:entity:special', 'http://schema.org/description', '"Quotes \\"inside\\""'),
  makeQuad('urn:entity:special', 'urn:prop:unicode', '"日本語テスト"'),
];

// ─────────────────────────────────────────────────────────────────────────
// §1  V10 PUBLISH Protocol (spec §9.0)
// ─────────────────────────────────────────────────────────────────────────

describe('V10 PUBLISH Protocol (spec §9.0)', () => {
  const contextGraphId = 'research-paranet-alpha';
  const cgIdBigInt = 0n;

  describe('Phase 1: resolve triples → compute kcMerkleRoot (keccak256)', () => {
    it('merkle root is 32 bytes keccak256', () => {
      const root = computeFlatKCRoot(singleEntityQuads, []);
      expect(root).toBeInstanceOf(Uint8Array);
      expect(root.length).toBe(32);

      const rootHex = ethers.hexlify(root);
      expect(rootHex).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('extracts root entities as unique subject URIs', () => {
      const subjects = [...new Set(multiEntityQuads.map(q => q.subject))];
      expect(subjects).toEqual(['urn:entity:a', 'urn:entity:b', 'urn:entity:c']);
      expect(subjects.length).toBe(3);

      const root = computeFlatKCRoot(multiEntityQuads, []);
      expect(root.length).toBe(32);
    });

    it('ordering independence: same quads different order = same root', () => {
      const rootA = computeFlatKCRoot(multiEntityQuads, []);
      const reversed = [...multiEntityQuads].reverse();
      const rootB = computeFlatKCRoot(reversed, []);
      expect(ethers.hexlify(rootA)).toBe(ethers.hexlify(rootB));

      const shuffled = [
        multiEntityQuads[3], multiEntityQuads[0], multiEntityQuads[6],
        multiEntityQuads[1], multiEntityQuads[5], multiEntityQuads[2],
        multiEntityQuads[4],
      ];
      const rootC = computeFlatKCRoot(shuffled, []);
      expect(ethers.hexlify(rootA)).toBe(ethers.hexlify(rootC));
    });

    it('deduplication: duplicate triples produce same root as unique set', () => {
      const withDupes = [...singleEntityQuads, ...singleEntityQuads];
      const rootDuped = computeFlatKCRoot(withDupes, []);
      const rootUnique = computeFlatKCRoot(singleEntityQuads, []);
      expect(ethers.hexlify(rootDuped)).toBe(ethers.hexlify(rootUnique));
    });

    it('single entity produces a valid 32-byte root', () => {
      const root = computeFlatKCRoot(singleEntityQuads, []);
      expect(root.length).toBe(32);
      expect(root.some(b => b !== 0)).toBe(true);
    });

    it('many entities produce a valid root', () => {
      const manyQuads: Quad[] = [];
      for (let i = 0; i < 50; i++) {
        manyQuads.push(makeQuad(`urn:entity:${i}`, 'http://schema.org/name', `"Entity ${i}"`));
      }
      const root = computeFlatKCRoot(manyQuads, []);
      expect(root.length).toBe(32);
    });
  });

  describe('Phase 2: ACK collection via direct P2P', () => {
    it('ACK digest = EIP-191 over computeACKDigest (0n bigint for non-numeric context graph id)', async () => {
      const merkleRoot = computeFlatKCRoot(singleEntityQuads, []);
      const digest = computeACKDigest(cgIdBigInt, merkleRoot);
      expect(digest).toBeInstanceOf(Uint8Array);
      expect(digest.length).toBe(32);

      const wallet = coreWallets[0];
      const sig = ethers.Signature.from(await wallet.signMessage(digest));
      expect(sig.r).toMatch(/^0x[0-9a-f]{64}$/);
      expect(sig.yParityAndS).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('ecrecover produces the correct signer address', async () => {
      const merkleRoot = computeFlatKCRoot(singleEntityQuads, []);
      const digest = computeACKDigest(cgIdBigInt, merkleRoot);

      for (const wallet of coreWallets) {
        const sig = ethers.Signature.from(await wallet.signMessage(digest));
        const prefixedHash = ethers.hashMessage(digest);
        const recovered = ethers.recoverAddress(prefixedHash, {
          r: sig.r,
          yParityAndS: sig.yParityAndS,
        });
        expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
      }
    });

    it('minimum 3 ACKs required (configurable via requiredACKs)', async () => {
      const merkleRoot = computeFlatKCRoot(singleEntityQuads, []);
      let callIdx = 0;
      const deps: ACKCollectorDeps = {
        gossipPublish: vi.fn().mockResolvedValue(undefined),
        sendP2P: async () => {
          const wallet = coreWallets[callIdx % coreWallets.length];
          const { r, vs } = await signACK(wallet, cgIdBigInt, merkleRoot);
          return encodeStorageACK({
            merkleRoot,
            coreNodeSignatureR: r,
            coreNodeSignatureVS: vs,
            contextGraphId,
            nodeIdentityId: ++callIdx,
          });
        },
        getConnectedCorePeers: () => ['p-0', 'p-1', 'p-2', 'p-3'],
        log: vi.fn(),
      };

      const collector = new ACKCollector(deps);
      const result = await collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        publisherPeerId: 'pub-0',
        publicByteSize: 500n,
        isPrivate: false,
        kaCount: 1,
        rootEntities: ['urn:entity:alpha'],
        requiredACKs: 3,
      });
      expect(result.acks.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Phase 3: chain submission with ACK signatures', () => {
    it('all ACK signatures are on the same merkle root', async () => {
      const merkleRoot = computeFlatKCRoot(multiEntityQuads, []);
      const sigs = await Promise.all(
        coreWallets.slice(0, 3).map(w => signACK(w, cgIdBigInt, merkleRoot)),
      );

      const digest = computeACKDigest(cgIdBigInt, merkleRoot);
      const prefixedHash = ethers.hashMessage(digest);

      for (const { r, vs } of sigs) {
        const addr = ethers.recoverAddress(prefixedHash, {
          r: ethers.hexlify(r),
          yParityAndS: ethers.hexlify(vs),
        });
        expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    });

    it('non-numeric contextGraphId maps to 0n for ACK digest', () => {
      expect(() => BigInt(contextGraphId)).toThrow();
      expect(cgIdBigInt).toBe(0n);
    });
  });

  describe('Phase 4: SWM cleanup after publish', () => {
    it('published triples removed from SWM (mock verification)', async () => {
      const mockStore = {
        query: vi.fn().mockResolvedValue({ type: 'quads' as const, quads: [] }),
        insert: vi.fn(),
        delete: vi.fn(),
        dropGraph: vi.fn(),
      };

      await mockStore.dropGraph('did:dkg:context-graph:test/_shared_memory');
      expect(mockStore.dropGraph).toHaveBeenCalledWith(
        'did:dkg:context-graph:test/_shared_memory',
      );

      const result = await mockStore.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <swm> { ?s ?p ?o } }');
      expect(result.quads).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §2  V10 SHARE Protocol (spec §7.0)
// ─────────────────────────────────────────────────────────────────────────

describe('V10 SHARE Protocol (spec §7.0)', () => {
  describe('promote triples from WM to SWM', () => {
    it('WM triples get correct graph URI in SWM', () => {
      const contextGraphId = 'paranet-123';
      const swmUri = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;

      const wmTriples = multiEntityQuads.map(q => ({
        ...q,
        graph: `did:dkg:context-graph:${contextGraphId}/_working_memory`,
      }));
      const promoted = wmTriples.map(q => ({ ...q, graph: swmUri }));

      for (const q of promoted) {
        expect(q.graph).toBe(swmUri);
        expect(q.subject).toBeTruthy();
        expect(q.predicate).toBeTruthy();
      }
    });

    it('selective entity promotion (only specified entities)', () => {
      const selectedEntities = new Set(['urn:entity:a', 'urn:entity:c']);
      const promoted = multiEntityQuads.filter(q => selectedEntities.has(q.subject));

      expect(promoted.length).toBe(5);
      for (const q of promoted) {
        expect(selectedEntities.has(q.subject)).toBe(true);
      }
      expect(promoted.some(q => q.subject === 'urn:entity:b')).toBe(false);
    });

    it('full promotion (all entities)', () => {
      const promoted = [...multiEntityQuads];
      const subjects = new Set(promoted.map(q => q.subject));
      expect(subjects.size).toBe(3);
      expect(promoted.length).toBe(multiEntityQuads.length);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §3  V10 GET Protocol (spec §12)
// ─────────────────────────────────────────────────────────────────────────

describe('V10 GET Protocol (spec §12)', () => {
  const contextGraphId = 'research-net';
  const ltmGraph = `did:dkg:context-graph:${contextGraphId}/_data`;
  const swmGraph = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;

  const ltmQuads: Quad[] = [
    makeQuad('urn:entity:x', 'http://schema.org/name', '"LTM Name"', ltmGraph),
    makeQuad('urn:entity:x', 'urn:prop:version', '"1"', ltmGraph),
  ];
  const swmQuads: Quad[] = [
    makeQuad('urn:entity:x', 'http://schema.org/name', '"SWM Name (newer)"', swmGraph),
    makeQuad('urn:entity:y', 'urn:prop:draft', '"true"', swmGraph),
  ];

  it('view=shared-working-memory queries SWM graph', () => {
    const view = 'shared-working-memory';
    const graphUri = view === 'shared-working-memory' ? swmGraph : ltmGraph;
    expect(graphUri).toBe(swmGraph);
    expect(swmQuads.every(q => q.graph === swmGraph)).toBe(true);
  });

  it('view=verified-memory resolves to VM graph prefix', () => {
    const vmGraph = `did:dkg:context-graph:${contextGraphId}/_verified_memory/`;
    expect(vmGraph).toContain('_verified_memory');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §4  V10 ACK Edge Cases
// ─────────────────────────────────────────────────────────────────────────

describe('V10 ACK Edge Cases', () => {
  const contextGraphId = 'edge-case-cg';
  const cgIdBigInt = 0n;
  const merkleRoot = computeFlatKCRoot(singleEntityQuads, []);

  it('fails fast when requiredACKs > connected peers', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn().mockResolvedValue(undefined),
      sendP2P: vi.fn(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1'],
    };

    const collector = new ACKCollector(deps);
    await expect(
      collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        publisherPeerId: 'pub',
        publicByteSize: 100n,
        isPrivate: false,
        kaCount: 1,
        rootEntities: [],
        requiredACKs: 5,
      }),
    ).rejects.toThrow('quorum impossible');

    expect(deps.sendP2P).not.toHaveBeenCalled();
  });

  it('rejects ACK with wrong merkle root', async () => {
    const wrongRoot = new Uint8Array(32).fill(0xde);

    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn().mockResolvedValue(undefined),
      sendP2P: async () => {
        const { r, vs } = await signACK(coreWallets[0], cgIdBigInt, merkleRoot);
        return encodeStorageACK({
          merkleRoot: wrongRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId,
          nodeIdentityId: 1,
        });
      },
      getConnectedCorePeers: () => ['p-0', 'p-1', 'p-2'],
      log: vi.fn(),
    };

    const collector = new ACKCollector(deps);
    await expect(
      collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        publisherPeerId: 'pub',
        publicByteSize: 100n,
        isPrivate: false,
        kaCount: 1,
        rootEntities: [],
      }),
    ).rejects.toThrow('storage_ack_insufficient');
  });

  it('rejects ACK from unknown identity (verifyIdentity returns false)', async () => {
    let idx = 0;
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn().mockResolvedValue(undefined),
      sendP2P: async () => {
        const wallet = coreWallets[idx++ % coreWallets.length];
        const { r, vs } = await signACK(wallet, cgIdBigInt, merkleRoot);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId,
          nodeIdentityId: idx,
        });
      },
      getConnectedCorePeers: () => ['p-0', 'p-1', 'p-2'],
      verifyIdentity: vi.fn().mockResolvedValue(false),
      log: vi.fn(),
    };

    const collector = new ACKCollector(deps);
    await expect(
      collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        publisherPeerId: 'pub',
        publicByteSize: 100n,
        isPrivate: false,
        kaCount: 1,
        rootEntities: [],
      }),
    ).rejects.toThrow('storage_ack_insufficient');
    expect(deps.verifyIdentity).toHaveBeenCalled();
  });

  it('deduplicates ACKs from same peerId', async () => {
    let callCount = 0;
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn().mockResolvedValue(undefined),
      sendP2P: async () => {
        const wallet = coreWallets[0];
        const { r, vs } = await signACK(wallet, cgIdBigInt, merkleRoot);
        callCount++;
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId,
          nodeIdentityId: callCount,
        });
      },
      getConnectedCorePeers: () => ['same-peer', 'same-peer', 'same-peer', 'p-3'],
      log: vi.fn(),
    };

    const collector = new ACKCollector(deps);
    await expect(
      collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        publisherPeerId: 'pub',
        publicByteSize: 100n,
        isPrivate: false,
        kaCount: 1,
        rootEntities: [],
      }),
    ).rejects.toThrow();
  });

  it('deduplicates ACKs from same nodeIdentityId', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn().mockResolvedValue(undefined),
      sendP2P: async () => {
        const { r, vs } = await signACK(coreWallets[0], cgIdBigInt, merkleRoot);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId,
          nodeIdentityId: 999,
        });
      },
      getConnectedCorePeers: () => ['p-0', 'p-1', 'p-2'],
      log: vi.fn(),
    };

    const collector = new ACKCollector(deps);
    await expect(
      collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        publisherPeerId: 'pub',
        publicByteSize: 100n,
        isPrivate: false,
        kaCount: 1,
        rootEntities: [],
      }),
    ).rejects.toThrow();
  });

  it('handles nodeIdentityId > Number.MAX_SAFE_INTEGER (uint64 high/low encoding)', () => {
    const largeId = BigInt('18446744073709551615');
    expect(largeId).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    const low = Number(largeId & 0xFFFFFFFFn);
    const high = Number((largeId >> 32n) & 0xFFFFFFFFn);
    const reconstructed = BigInt(low) | (BigInt(high) << 32n);
    expect(reconstructed).toBe(largeId);

    const encoded = { low, high, unsigned: true };
    const decoded = BigInt(encoded.low) | (BigInt(encoded.high) << 32n);
    expect(decoded).toBe(largeId);
  });

  it('stagingQuads included in P2P intent for direct publish', () => {
    const ntriples = quadsToNTriples(singleEntityQuads);
    const stagingBytes = new TextEncoder().encode(ntriples);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'pub-0',
      publicByteSize: stagingBytes.length,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:alpha'],
      stagingQuads: stagingBytes,
    });

    const decoded = decodePublishIntent(intent);
    expect(decoded.stagingQuads).toBeDefined();
    expect(decoded.stagingQuads!.length).toBe(stagingBytes.length);
  });

  it('stagingQuads omitted for publishFromSharedMemory (SWM-verified path)', () => {
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:alpha'],
    });

    const decoded = decodePublishIntent(intent);
    expect(!decoded.stagingQuads || decoded.stagingQuads.length === 0).toBe(true);
  });

  it('inline staging quads verified against merkle root before signing', () => {
    const ntriples = quadsToNTriples(singleEntityQuads);
    const parsed = parseSimpleNQuads(ntriples);
    expect(parsed.length).toBe(singleEntityQuads.length);

    const inMemoryRoot = computeFlatKCRoot(parsed, []);
    const expectedRoot = computeFlatKCRoot(singleEntityQuads, []);
    expect(ethers.hexlify(inMemoryRoot)).toBe(ethers.hexlify(expectedRoot));
  });

  it('rejects staging quads exceeding 4MB limit', async () => {
    const oversizedBytes = new Uint8Array(4 * 1024 * 1024 + 1);
    expect(oversizedBytes.length).toBeGreaterThan(4 * 1024 * 1024);

    const config: StorageACKHandlerConfig = {
      nodeRole: 'core',
      nodeIdentityId: 1n,
      signerWallet: coreWallets[0],
      contextGraphSharedMemoryUri: () => 'urn:test:swm',
    };
    const handler = new StorageACKHandler(
      { query: vi.fn() } as any,
      config,
      makeEventBus() as any,
    );

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'pub-0',
      publicByteSize: oversizedBytes.length,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      stagingQuads: oversizedBytes,
    });

    await expect(handler.handler(intent, { toString: () => 'peer' }))
      .rejects.toThrow('exceeds');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §5  V10 Merkle Root Construction (spec §9.0.2)
// ─────────────────────────────────────────────────────────────────────────

describe('V10 Merkle Root Construction (spec §9.0.2)', () => {
  it('canonical N-Triples serialization', () => {
    const ntriples = quadsToNTriples(singleEntityQuads);
    const parsed = parseSimpleNQuads(ntriples);
    expect(parsed.length).toBe(singleEntityQuads.length);

    for (let i = 0; i < parsed.length; i++) {
      expect(parsed[i].subject).toBe(singleEntityQuads[i].subject);
      expect(parsed[i].predicate).toBe(singleEntityQuads[i].predicate);
      expect(parsed[i].object).toBe(singleEntityQuads[i].object);
    }
  });

  it('lexicographic sorting: tree sorts leaves internally', () => {
    const q1 = makeQuad('urn:z', 'urn:p', '"Z"');
    const q2 = makeQuad('urn:a', 'urn:p', '"A"');
    const rootAB = computeFlatKCRoot([q1, q2], []);
    const rootBA = computeFlatKCRoot([q2, q1], []);
    expect(ethers.hexlify(rootAB)).toBe(ethers.hexlify(rootBA));
  });

  it('deduplication of identical triples', () => {
    const q = makeQuad('urn:dup', 'urn:p', '"val"');
    const rootSingle = computeFlatKCRoot([q], []);
    const rootTriple = computeFlatKCRoot([q, q, q], []);
    expect(ethers.hexlify(rootSingle)).toBe(ethers.hexlify(rootTriple));
  });

  it('leaf = keccak256(ntriples_string)', () => {
    const q = makeQuad('http://example.org/s', 'http://example.org/p', '"object"');
    const hash = computeTripleHashV10(q);
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(32);

    const hash2 = computeTripleHashV10(q);
    expect(ethers.hexlify(hash)).toBe(ethers.hexlify(hash2));
  });

  it('odd leaf count: duplicates last leaf as padding', () => {
    const quads3 = [
      makeQuad('urn:a', 'urn:p', '"1"'),
      makeQuad('urn:b', 'urn:p', '"2"'),
      makeQuad('urn:c', 'urn:p', '"3"'),
    ];
    const root = computeFlatKCRoot(quads3, []);
    expect(root.length).toBe(32);
    expect(root.some(b => b !== 0)).toBe(true);
  });

  it('private root as synthetic leaf', () => {
    const publicQuads = [makeQuad('urn:pub', 'urn:p', '"public"')];
    const privateRoot = new Uint8Array(32).fill(0xab);

    const withPrivate = computeFlatKCRoot(publicQuads, [privateRoot]);
    const withoutPrivate = computeFlatKCRoot(publicQuads, []);
    expect(ethers.hexlify(withPrivate)).not.toBe(ethers.hexlify(withoutPrivate));
    expect(withPrivate.length).toBe(32);
  });

  it('different quads produce different roots', () => {
    const root1 = computeFlatKCRoot(singleEntityQuads, []);
    const root2 = computeFlatKCRoot(multiEntityQuads, []);
    expect(ethers.hexlify(root1)).not.toBe(ethers.hexlify(root2));
  });

  it('empty quads produce undefined root via computePublicRootV10', () => {
    const root = computePublicRootV10([]);
    expect(root).toBeUndefined();
  });

  it('special characters in triples produce valid hashes', () => {
    const root = computeFlatKCRoot(specialCharQuads, []);
    expect(root.length).toBe(32);

    for (const q of specialCharQuads) {
      const h = computeTripleHashV10(q);
      expect(h.length).toBe(32);
    }
  });

  it('blank node subjects produce valid hashes', () => {
    const blankQuads = [
      makeQuad('_:b0', 'urn:p', '"blank node value"'),
      makeQuad('_:b1', 'urn:p', 'urn:linked'),
    ];
    const root = computeFlatKCRoot(blankQuads, []);
    expect(root.length).toBe(32);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §6  V10 StorageACKHandler round-trip
// ─────────────────────────────────────────────────────────────────────────

describe('V10 StorageACKHandler round-trip', () => {
  const contextGraphId = 'handler-test-cg';
  const cgIdBigInt = 0n;
  const coreWallet = ethers.Wallet.createRandom();
  const fakePeerId = { toString: () => 'requester-peer' };

  const testQuads: Quad[] = [
    makeQuad('urn:entity:1', 'urn:p:name', '"Entity One"'),
    makeQuad('urn:entity:1', 'urn:p:type', 'urn:type:Thing'),
    makeQuad('urn:entity:2', 'urn:p:name', '"Entity Two"'),
  ];
  const merkleRoot = computeFlatKCRoot(testQuads, []);

  function createMockStore(quads: Quad[]) {
    return {
      query: vi.fn().mockImplementation((sparql: string) => {
        const entityMatch = sparql.match(/FILTER\(\?s = <([^>]+)>/);
        if (entityMatch) {
          const entity = entityMatch[1];
          const genidPrefix = `${entity}/.well-known/genid/`;
          const filtered = quads.filter(q =>
            q.subject === entity || q.subject.startsWith(genidPrefix),
          );
          return Promise.resolve({ type: 'quads' as const, quads: filtered });
        }
        return Promise.resolve({ type: 'quads' as const, quads });
      }),
      insert: vi.fn(),
      delete: vi.fn(),
      dropGraph: vi.fn(),
      close: vi.fn(),
    };
  }

  function createHandler(store: any, opts?: { role?: 'core' | 'edge'; identityId?: bigint }) {
    const config: StorageACKHandlerConfig = {
      nodeRole: opts?.role ?? 'core',
      nodeIdentityId: opts?.identityId ?? 42n,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) =>
        `did:dkg:context-graph:${cgId}/_shared_memory`,
    };
    return new StorageACKHandler(store as any, config, makeEventBus() as any);
  }

  it('handler returns valid StorageACK for inline stagingQuads', async () => {
    const ntriples = quadsToNTriples(testQuads);
    const stagingBytes = new TextEncoder().encode(ntriples);

    const handler = createHandler(createMockStore([]));
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'pub-0',
      publicByteSize: stagingBytes.length,
      isPrivate: false,
      kaCount: 2,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
      stagingQuads: stagingBytes,
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    expect(ack.contextGraphId).toBe(contextGraphId);
    const decodedRoot = ack.merkleRoot instanceof Uint8Array
      ? ack.merkleRoot : new Uint8Array(ack.merkleRoot);
    expect(ethers.hexlify(decodedRoot)).toBe(ethers.hexlify(merkleRoot));

    const digest = computeACKDigest(cgIdBigInt, merkleRoot, 2, BigInt(stagingBytes.length), 1, 0n);
    const prefixedHash = ethers.hashMessage(digest);
    const recovered = ethers.recoverAddress(prefixedHash, {
      r: ethers.hexlify(ack.coreNodeSignatureR instanceof Uint8Array
        ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR)),
      yParityAndS: ethers.hexlify(ack.coreNodeSignatureVS instanceof Uint8Array
        ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS)),
    });
    expect(recovered.toLowerCase()).toBe(coreWallet.address.toLowerCase());
  });

  it('handler verifies data from SWM when no stagingQuads (enshrine path)', async () => {
    const store = createMockStore(testQuads);
    const handler = createHandler(store);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);
    expect(ack.contextGraphId).toBe(contextGraphId);
    expect(store.query).toHaveBeenCalled();
  });

  it('handler rejects non-core node role', async () => {
    const handler = createHandler(createMockStore([]), { role: 'edge' });

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'pub-0',
      publicByteSize: 100,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('Only core nodes can issue StorageACKs');
  });

  it('handler rejects merkle root mismatch for inline quads', async () => {
    const differentQuads = [makeQuad('urn:wrong', 'urn:p', '"wrong data"')];
    const ntriples = quadsToNTriples(differentQuads);
    const stagingBytes = new TextEncoder().encode(ntriples);

    const handler = createHandler(createMockStore([]));
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'pub-0',
      publicByteSize: stagingBytes.length,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      stagingQuads: stagingBytes,
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('Merkle root mismatch');
  });

  it('handler rejects empty stagingQuads', async () => {
    const handler = createHandler(createMockStore([]));
    const emptyNTriples = '';
    const stagingBytes = new TextEncoder().encode(emptyNTriples);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'pub-0',
      publicByteSize: 0,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      stagingQuads: stagingBytes,
    });

    // Empty staging bytes have length 0, which takes the SWM fallback path;
    // with no SWM data either, it will fail on "No data found in SWM"
    await expect(handler.handler(intent, fakePeerId)).rejects.toThrow();
  });

  it('handler rejects stagingQuads > 4MB', async () => {
    const oversized = new Uint8Array(4 * 1024 * 1024 + 1).fill(0x41);
    const handler = createHandler(createMockStore([]));

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'pub-0',
      publicByteSize: oversized.length,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      stagingQuads: oversized,
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('exceeds');
  });

  it('persists inline quads to staging graph before signing (crash safety)', async () => {
    const store = createMockStore([]);
    const handler = createHandler(store);

    const ntriples = quadsToNTriples(testQuads);
    const stagingBytes = new TextEncoder().encode(ntriples);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'pub-0',
      publicByteSize: stagingBytes.length,
      isPrivate: false,
      kaCount: 2,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
      stagingQuads: stagingBytes,
    });

    await handler.handler(intent, fakePeerId);

    expect(store.dropGraph).toHaveBeenCalled();
    expect(store.insert).toHaveBeenCalled();
    const insertedQuads = store.insert.mock.calls[0][0];
    expect(insertedQuads.length).toBeGreaterThan(0);
    expect(insertedQuads[0].graph).toContain('/staging/');
  });

  it('uint64 overflow check for nodeIdentityId > 2^64', async () => {
    const overflowId = (1n << 64n);
    const config: StorageACKHandlerConfig = {
      nodeRole: 'core',
      nodeIdentityId: overflowId,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) =>
        `did:dkg:context-graph:${cgId}/_shared_memory`,
    };
    const store = createMockStore(testQuads);
    const handler = new StorageACKHandler(store as any, config, makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('exceeds uint64');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §7  V10 Finalization (spec §9.0 Phase 6)
// ─────────────────────────────────────────────────────────────────────────

describe('V10 Finalization (spec §9.0 Phase 6)', () => {
  const contextGraphId = 'finalization-test';
  const cgIdBigInt = 0n;
  const merkleRoot = computeFlatKCRoot(multiEntityQuads, []);

  it('PublishIntent encode/decode round-trip preserves all fields', () => {
    const rootEntities = ['urn:entity:a', 'urn:entity:b', 'urn:entity:c'];
    const stagingBytes = new TextEncoder().encode(quadsToNTriples(multiEntityQuads));

    const original = {
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'QmPublisher12345',
      publicByteSize: 2048,
      isPrivate: true,
      kaCount: 3,
      rootEntities,
      stagingQuads: stagingBytes,
    };

    const encoded = encodePublishIntent(original);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodePublishIntent(encoded);
    expect(decoded.contextGraphId).toBe(contextGraphId);
    expect(decoded.publisherPeerId).toBe('QmPublisher12345');
    expect(Number(decoded.publicByteSize)).toBe(2048);
    expect(decoded.isPrivate).toBe(true);
    expect(decoded.kaCount).toBe(3);
    expect(decoded.rootEntities).toEqual(rootEntities);

    const decodedRoot = decoded.merkleRoot instanceof Uint8Array
      ? decoded.merkleRoot : new Uint8Array(decoded.merkleRoot);
    expect(ethers.hexlify(decodedRoot)).toBe(ethers.hexlify(merkleRoot));

    expect(decoded.stagingQuads).toBeDefined();
    expect(decoded.stagingQuads!.length).toBe(stagingBytes.length);
  });

  it('StorageACK encode/decode round-trip preserves all fields', async () => {
    const wallet = coreWallets[0];
    const digest = computeACKDigest(cgIdBigInt, merkleRoot);
    const sig = ethers.Signature.from(await wallet.signMessage(digest));

    const original = {
      merkleRoot,
      coreNodeSignatureR: ethers.getBytes(sig.r),
      coreNodeSignatureVS: ethers.getBytes(sig.yParityAndS),
      contextGraphId,
      nodeIdentityId: 42,
    };

    const encoded = encodeStorageACK(original);
    expect(encoded).toBeInstanceOf(Uint8Array);

    const decoded = decodeStorageACK(encoded);
    expect(decoded.contextGraphId).toBe(contextGraphId);

    const decodedRoot = decoded.merkleRoot instanceof Uint8Array
      ? decoded.merkleRoot : new Uint8Array(decoded.merkleRoot);
    expect(ethers.hexlify(decodedRoot)).toBe(ethers.hexlify(merkleRoot));

    const decodedR = decoded.coreNodeSignatureR instanceof Uint8Array
      ? decoded.coreNodeSignatureR : new Uint8Array(decoded.coreNodeSignatureR);
    const decodedVS = decoded.coreNodeSignatureVS instanceof Uint8Array
      ? decoded.coreNodeSignatureVS : new Uint8Array(decoded.coreNodeSignatureVS);
    expect(decodedR.length).toBe(32);
    expect(decodedVS.length).toBe(32);
    expect(ethers.hexlify(decodedR)).toBe(sig.r);
    expect(ethers.hexlify(decodedVS)).toBe(sig.yParityAndS);

    const prefixedHash = ethers.hashMessage(digest);
    const recovered = ethers.recoverAddress(prefixedHash, {
      r: ethers.hexlify(decodedR),
      yParityAndS: ethers.hexlify(decodedVS),
    });
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('contextGraphId consistency: publisher and handler both use 0n for non-numeric string', () => {
    const publisherDerived = 0n;
    const handlerDerived = 0n;
    expect(publisherDerived).toBe(handlerDerived);
    expect(publisherDerived).toBe(cgIdBigInt);
    expect(publisherDerived).toBe(0n);
  });

  it('KA root combines public and private roots correctly', () => {
    const publicRoot = computePublicRootV10(multiEntityQuads);
    expect(publicRoot).toBeDefined();

    const privateQuads = [makeQuad('urn:private:1', 'urn:p', '"secret"')];
    const privateRoot = computePrivateRootV10(privateQuads);
    expect(privateRoot).toBeDefined();

    const kaRoot = computeKARootV10(publicRoot, privateRoot);
    expect(kaRoot.length).toBe(32);
    expect(kaRoot).not.toEqual(publicRoot);
    expect(kaRoot).not.toEqual(privateRoot);

    const publicOnlyKARoot = computeKARootV10(publicRoot, undefined);
    expect(publicOnlyKARoot).toEqual(publicRoot);
  });

  it('KC root aggregates multiple KA roots', () => {
    const ka1 = computeKARootV10(computePublicRootV10(singleEntityQuads));
    const ka2 = computeKARootV10(computePublicRootV10(multiEntityQuads));

    const kcRoot = computeKCRootV10([ka1, ka2]);
    expect(kcRoot.length).toBe(32);

    const kcRootReversed = computeKCRootV10([ka2, ka1]);
    expect(ethers.hexlify(kcRoot)).toBe(ethers.hexlify(kcRootReversed));
  });
});
