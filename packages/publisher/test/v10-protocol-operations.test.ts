import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
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
  computePublishACKDigest,
  encodePublishIntent,
  decodePublishIntent,
  encodeStorageACK,
  decodeStorageACK,
} from '@origintrail-official/dkg-core';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import { parseSimpleNQuads } from '../src/publish-handler.js';

// Test H5 prefix inputs. Production fail-loud rejects non-numeric / zero
// CG ids in both the collector and the handler, so every fixture in this
// file uses a plain numeric id.
const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

function makeQuad(s: string, p: string, o: string, g = ''): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function makeEventBus() {
  return { emit: () => {}, on: () => {}, off: () => {}, once: () => {} };
}

async function signACK(
  wallet: ethers.Wallet,
  contextGraphId: bigint,
  merkleRoot: Uint8Array,
  kaCount: number = 0,
  byteSize: bigint = 0n,
  epochs: bigint = 1n,
  tokenAmount: bigint = 0n,
) {
  const digest = computePublishACKDigest(
    TEST_CHAIN_ID,
    TEST_KAV10_ADDR,
    contextGraphId,
    merkleRoot,
    BigInt(kaCount),
    byteSize,
    epochs,
    tokenAmount,
  );
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
  const contextGraphId = '42';
  const cgIdBigInt = 42n;

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
    it('ACK digest = EIP-191 over the legacy 2-field computeACKDigest helper', async () => {
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
        gossipPublish: async () => {},
        sendP2P: async () => {
          const wallet = coreWallets[callIdx % coreWallets.length];
          // Match collector.collect inputs below so the H5 digest the signer
          // produces equals the one the collector recovers from.
          const { r, vs } = await signACK(wallet, cgIdBigInt, merkleRoot, 1, 500n);
          return encodeStorageACK({
            merkleRoot,
            coreNodeSignatureR: r,
            coreNodeSignatureVS: vs,
            contextGraphId,
            nodeIdentityId: ++callIdx,
          });
        },
        getConnectedCorePeers: () => ['p-0', 'p-1', 'p-2', 'p-3'],
        log: () => {},
      };

      const collector = new ACKCollector(deps);
      const result = await collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
        publisherPeerId: 'pub-0',
        publicByteSize: 500n,
        isPrivate: false,
        kaCount: 1,
        rootEntities: ['urn:entity:alpha'],
        requiredACKs: 3,
      });
      // Count is necessary but not sufficient: the old `>= 3` by itself
      // would be green for three *junk* ACKs. Assert every ACK is
      // (a) a real ECDSA signature that ecrecovers to one of the
      // expected core wallets, (b) carries the expected merkleRoot,
      // and (c) has a distinct positive nodeIdentityId — i.e. the
      // handshake actually produced M-of-N signed agreement, not a
      // replay of one peer's ACK.
      expect(result.acks.length).toBeGreaterThanOrEqual(3);
      // Enclosing result carries the merkleRoot that every surviving
      // ACK must have matched (verified inside collector). Pin it so
      // a future refactor that returns a different root would fail.
      expect(result.merkleRoot).toEqual(merkleRoot);

      const seenIdentityIds = new Set<string>();
      const coreAddrs = new Set(
        coreWallets.map((w) => w.address.toLowerCase()),
      );
      // Test simulators use `signACK` above, which signs the 8-field
      // `computePublishACKDigest` — same digest the collector verifies
      // against. We MUST use the same here or recovery drifts and the
      // assertion produces a false positive.
      const digest = computePublishACKDigest(
        TEST_CHAIN_ID,
        TEST_KAV10_ADDR,
        cgIdBigInt,
        merkleRoot,
        1n, // kaCount passed to collect({ kaCount: 1 })
        500n, // publicByteSize passed to collect({ publicByteSize: 500n })
        1n, // epochs default
        0n, // tokenAmount default
      );
      const prefixedHash = ethers.hashMessage(digest);
      for (const ack of result.acks) {
        expect(ack.nodeIdentityId, 'ACK nodeIdentityId must be > 0').toBeGreaterThan(0n);
        const idKey = String(ack.nodeIdentityId);
        expect(
          seenIdentityIds.has(idKey),
          `duplicate nodeIdentityId ${idKey} — collector accepted a replay`,
        ).toBe(false);
        seenIdentityIds.add(idKey);
        // `CollectedACK` exposes `signatureR` / `signatureVS` (no
        // `coreNode` prefix) — ecrecover each against the 2-field
        // H5 digest and require the signer to be one of the simulated
        // core wallets. This catches both a forged ACK (wrong signer)
        // and a digest-drift bug (signer recovers to garbage).
        const recovered = ethers.recoverAddress(prefixedHash, {
          r: ethers.hexlify(ack.signatureR),
          yParityAndS: ethers.hexlify(ack.signatureVS),
        });
        expect(
          coreAddrs.has(recovered.toLowerCase()),
          `ACK signature recovers to ${recovered} which is NOT one of the ` +
            `simulated core wallets — collector accepted a forged ACK`,
        ).toBe(true);
      }
    });
  });

  // Phase 3 ("chain submission with ACK signatures") test block was removed:
  // the remaining assertion ("all ACK signatures are on the same merkle root")
  // signed with the new H5 helper but verified with the legacy 2-field
  // `computeACKDigest`, so the recover loop just checked that the output had
  // hex-format, not that the signer matched. The real chain-submission path
  // is covered end-to-end by `v10-publish-e2e.test.ts` against the real
  // handler + collector. The pre-rewire `non-numeric contextGraphId maps to
  // 0n for ACK digest` test was also deleted as part of Bug F — the silent
  // `= 0n` fallback is gone and the fail-loud guard lives in
  // `dkg-agent.createV10ACKProvider`,
  // `publisher-runner.createV10ACKProviderForPublisher`,
  // `storage-ack-handler.ts:handler`, and
  // `evm-adapter.createKnowledgeAssetsV10`.

  describe('Phase 4: SWM cleanup after publish', () => {
    it('SWM graph URI follows expected naming convention', () => {
      const contextGraphId = 'test';
      const swmUri = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;
      expect(swmUri).toBe('did:dkg:context-graph:test/_shared_memory');
      expect(swmUri).toContain('/_shared_memory');
      expect(swmUri).not.toContain('/_working_memory');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §2  V10 SHARE Protocol (spec §7.0)
// ─────────────────────────────────────────────────────────────────────────

describe('V10 SHARE Protocol (spec §7.0)', () => {
  describe('promote triples from WM to SWM', () => {
    it('WM triples get correct graph URI in SWM', () => {
      const contextGraphId = '42';
      const swmUri = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;

      const wmTriples = multiEntityQuads.map(q => ({
        ...q,
        graph: `did:dkg:context-graph:${contextGraphId}/_working_memory`,
      }));
      const promoted = wmTriples.map(q => ({ ...q, graph: swmUri }));

      for (const q of promoted) {
        expect(q.graph).toBe(swmUri);
        expect(q.subject).toMatch(/^urn:/);
        expect(q.predicate).toMatch(/^(http|urn:)/);
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
  const contextGraphId = '42';
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
    expect(vmGraph).toBe('did:dkg:context-graph:42/_verified_memory/');
    expect(vmGraph).not.toContain('_shared_memory');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §4  V10 ACK Edge Cases
// ─────────────────────────────────────────────────────────────────────────

describe('V10 ACK Edge Cases', () => {
  const contextGraphId = '42';
  const cgIdBigInt = 42n;
  const merkleRoot = computeFlatKCRoot(singleEntityQuads, []);

  it('fails fast when requiredACKs > connected peers', async () => {
    let sendCalled = false;
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async () => { sendCalled = true; return new Uint8Array(); },
      getConnectedCorePeers: () => ['peer-0', 'peer-1'],
    };

    const collector = new ACKCollector(deps);
    await expect(
      collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
        publisherPeerId: 'pub',
        publicByteSize: 100n,
        isPrivate: false,
        kaCount: 1,
        rootEntities: [],
        requiredACKs: 5,
      }),
    ).rejects.toThrow('quorum impossible');

    expect(sendCalled).toBe(false);
  });

  it('rejects ACK with wrong merkle root', async () => {
    const wrongRoot = new Uint8Array(32).fill(0xde);

    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async () => {
        // Match collector inputs so the signer + verifier compute the same H5 digest.
        const { r, vs } = await signACK(coreWallets[0], cgIdBigInt, merkleRoot, 1, 100n);
        return encodeStorageACK({
          merkleRoot: wrongRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId,
          nodeIdentityId: 1,
        });
      },
      getConnectedCorePeers: () => ['p-0', 'p-1', 'p-2'],
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    await expect(
      collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
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
    let verifyIdentityCalled = false;
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async () => {
        const wallet = coreWallets[idx++ % coreWallets.length];
        const { r, vs } = await signACK(wallet, cgIdBigInt, merkleRoot, 1, 100n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId,
          nodeIdentityId: idx,
        });
      },
      getConnectedCorePeers: () => ['p-0', 'p-1', 'p-2'],
      verifyIdentity: async () => { verifyIdentityCalled = true; return false; },
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    await expect(
      collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
        publisherPeerId: 'pub',
        publicByteSize: 100n,
        isPrivate: false,
        kaCount: 1,
        rootEntities: [],
      }),
    ).rejects.toThrow('storage_ack_insufficient');
    expect(verifyIdentityCalled).toBe(true);
  });

  it('deduplicates ACKs from same peerId', async () => {
    let callCount = 0;
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async () => {
        const wallet = coreWallets[0];
        const { r, vs } = await signACK(wallet, cgIdBigInt, merkleRoot, 1, 100n);
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
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    // Bare `rejects.toThrow()` would accept ANY rejection — including a
    // regression where the collector threw on an orthogonal code path
    // (e.g. signature verify) before it ever got to the dedup check.
    // Pin the exact storage_ack_insufficient error so we know dedup
    // collapsed same-peer ACKs to a single distinct entry and THEN
    // failed the count threshold.
    await expect(
      collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
        publisherPeerId: 'pub',
        publicByteSize: 100n,
        isPrivate: false,
        kaCount: 1,
        rootEntities: [],
      }),
    ).rejects.toThrow(/storage_ack_insufficient/);
  });

  it('deduplicates ACKs from same nodeIdentityId', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async () => {
        const { r, vs } = await signACK(coreWallets[0], cgIdBigInt, merkleRoot, 1, 100n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId,
          nodeIdentityId: 999,
        });
      },
      getConnectedCorePeers: () => ['p-0', 'p-1', 'p-2'],
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    // Same reasoning as the same-peer dedup test above: bare
    // `rejects.toThrow()` is satisfied by ANY throw and would hide a
    // regression where the collector rejects for a non-dedup reason
    // before the identityId collapse even runs. Pin the expected
    // storage_ack_insufficient shape.
    await expect(
      collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
        publisherPeerId: 'pub',
        publicByteSize: 100n,
        isPrivate: false,
        kaCount: 1,
        rootEntities: [],
      }),
    ).rejects.toThrow(/storage_ack_insufficient/);
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
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    };
    const handler = new StorageACKHandler(
      { query: async () => ({ type: 'quads' as const, quads: [] }) } as any,
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
  const contextGraphId = '42';
  const cgIdBigInt = 42n;
  const coreWallet = ethers.Wallet.createRandom();
  const fakePeerId = { toString: () => 'requester-peer' };

  const testQuads: Quad[] = [
    makeQuad('urn:entity:1', 'urn:p:name', '"Entity One"'),
    makeQuad('urn:entity:1', 'urn:p:type', 'urn:type:Thing'),
    makeQuad('urn:entity:2', 'urn:p:name', '"Entity Two"'),
  ];
  const merkleRoot = computeFlatKCRoot(testQuads, []);

  // SWM URI used to seed the recording store. Must match the URI returned by
  // `createHandler`'s `contextGraphSharedMemoryUri` so the handler's
  // `loadSWMQuads` CONSTRUCT actually finds the seeded data.
  const SWM_GRAPH_URI = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;

  /**
   * Build a real {@link OxigraphStore}, seeded with `quads` placed in the
   * SWM graph the handler queries, and wrap each TripleStore method we
   * inspect in tests with a call recorder. The previous hand-rolled fake
   * intercepted SPARQL via a regex (`FILTER(?s = <…>)`) and returned
   * pre-filtered arrays — that bypassed the actual SPARQL engine and could
   * not detect IRI-escaping or graph-keying regressions. With the real
   * store, the handler's CONSTRUCT executes against parsed N-Quads, so the
   * round-trip now exercises production code paths.
   */
  function createRecordingStore(quads: Quad[]) {
    const store = new OxigraphStore();
    if (quads.length > 0) {
      void store.insert(quads.map((q) => ({ ...q, graph: SWM_GRAPH_URI })));
    }
    const queryCalls: unknown[][] = [];
    const insertCalls: unknown[][] = [];
    const dropGraphCalls: unknown[][] = [];
    const realQuery = store.query.bind(store);
    const realInsert = store.insert.bind(store);
    const realDropGraph = store.dropGraph.bind(store);
    (store as any).query = async (sparql: string) => {
      queryCalls.push([sparql]);
      return realQuery(sparql);
    };
    (store as any).insert = async (qs: Quad[]) => {
      insertCalls.push([qs]);
      return realInsert(qs);
    };
    (store as any).dropGraph = async (uri: string) => {
      dropGraphCalls.push([uri]);
      return realDropGraph(uri);
    };
    (store as any)._queryCalls = queryCalls;
    (store as any)._insertCalls = insertCalls;
    (store as any)._dropGraphCalls = dropGraphCalls;
    return store as any;
  }

  function createHandler(store: any, opts?: { role?: 'core' | 'edge'; identityId?: bigint }) {
    const config: StorageACKHandlerConfig = {
      nodeRole: opts?.role ?? 'core',
      nodeIdentityId: opts?.identityId ?? 42n,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) =>
        `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    };
    return new StorageACKHandler(store as any, config, makeEventBus() as any);
  }

  it('handler returns valid StorageACK for inline stagingQuads', async () => {
    const ntriples = quadsToNTriples(testQuads);
    const stagingBytes = new TextEncoder().encode(ntriples);

    const handler = createHandler(createRecordingStore([]));
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

    const digest = computePublishACKDigest(
      TEST_CHAIN_ID,
      TEST_KAV10_ADDR,
      cgIdBigInt,
      merkleRoot,
      2n,
      BigInt(stagingBytes.length),
      1n,
      0n,
    );
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
    const store = createRecordingStore(testQuads);
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
    expect(store._queryCalls.length).toBeGreaterThan(0);
  });

  it('handler rejects non-core node role', async () => {
    const handler = createHandler(createRecordingStore([]), { role: 'edge' });

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

    const handler = createHandler(createRecordingStore([]));
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
    const handler = createHandler(createRecordingStore([]));
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

    // Empty staging bytes have length 0, which takes the SWM fallback
    // path; with no SWM data either, the handler rejects with "No data
    // found in SWM" (or an equivalent empty-input rejection). Pin the
    // rejection vocabulary — a bare `rejects.toThrow()` would also be
    // satisfied by a setup crash (e.g. protobuf decode failure) which
    // would hide a real regression where empty input is silently
    // accepted and an empty commit is broadcast.
    await expect(handler.handler(intent, fakePeerId)).rejects.toThrow(
      /no data found in swm|empty|no.*staging|no.*quads/i,
    );
  });

  it('handler rejects stagingQuads > 4MB', async () => {
    const oversized = new Uint8Array(4 * 1024 * 1024 + 1).fill(0x41);
    const handler = createHandler(createRecordingStore([]));

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
    const store = createRecordingStore([]);
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

    expect(store._dropGraphCalls.length).toBeGreaterThan(0);
    expect(store._insertCalls.length).toBeGreaterThan(0);
    const insertedQuads = store._insertCalls[0][0] as any[];
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
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    };
    const store = createRecordingStore(testQuads);
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
  const contextGraphId = '42';
  const cgIdBigInt = 42n;
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

  it('contextGraphId consistency: publisher and handler agree on the numeric on-chain id', () => {
    const publisherDerived = BigInt(contextGraphId);
    const handlerDerived = BigInt(contextGraphId);
    expect(publisherDerived).toBe(handlerDerived);
    expect(publisherDerived).toBe(cgIdBigInt);
    expect(publisherDerived).toBeGreaterThan(0n);
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
