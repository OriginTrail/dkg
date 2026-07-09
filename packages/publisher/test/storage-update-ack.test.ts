import { describe, it, expect, vi } from 'vitest';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from '../src/merkle.js';
import {
  encodeUpdateIntent,
  decodeStorageACK,
  computeUpdateACKDigest,
  computeCatalogRoot,
  isStorageACKDecline,
  STORAGE_ACK_DECLINE_CODES,
  PROTOCOL_STORAGE_UPDATE_ACK,
  TypedEventBus,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

/**
 * Wrap a REAL OxigraphStore so only the named ops throw the classic mid-
 * worker-restart oxigraph failure ('store is closed'); everything else keeps
 * hitting the live store. Mirrors `storeWithFailingOps` in
 * storage-ack-core-unavailable.test.ts — the curated-catalog UPDATE store-
 * failure regression below drives the real persist path (parse → verify →
 * deleteByPattern → insert) up to the armed failure.
 */
function storeWithFailingOps(
  base: OxigraphStore,
  failingOps: readonly ('query' | 'insert' | 'dropGraph' | 'deleteByPattern')[],
): TripleStore {
  return new Proxy(base as unknown as TripleStore, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && (failingOps as readonly string[]).includes(prop)) {
        return async () => {
          throw new Error('store is closed');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('V10 UPDATE StorageACK — peer handler + collector quorum', () => {
  const contextGraphId = '42';
  const cgIdBigInt = 42n;
  const kaId = 987654321n;
  const preUpdateMerkleRootCount = 1n;
  const newTokenAmount = 1500n;
  const mintAmount = 0n;
  const burnTokenIds: bigint[] = [];

  const updatedQuads: Quad[] = [
    makeQuad('urn:entity:1', 'urn:p', 'urn:o1'),
    makeQuad('urn:entity:1', 'urn:p', 'urn:o2-updated'),
    makeQuad('urn:entity:2', 'urn:p', 'urn:o3'),
  ];
  const newMerkleRoot = computeFlatKCRoot(updatedQuads, []);
  const newMerkleLeafCount = computeFlatKCMerkleLeafCountV10(updatedQuads, []);
  // 4-term N-Quad serialization, same as the publisher's update() path.
  const nquadsStr = updatedQuads
    .map((q) => `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph}> .`)
    .join('\n');
  const stagingQuads = new TextEncoder().encode(nquadsStr);
  const newByteSize = BigInt(stagingQuads.length);

  const fakePeerId = { toString: () => 'publisher-peer' };

  function makeConfig(
    wallet: ethers.Wallet,
    identityId: bigint,
    overrides: Partial<StorageACKHandlerConfig> = {},
  ): StorageACKHandlerConfig {
    return {
      nodeRole: 'core',
      nodeIdentityId: identityId,
      signerWallet: wallet,
      contextGraphSharedMemoryUri: (cgId: string) =>
        `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      isCgCurated: async () => true,
      ...overrides,
    };
  }

  function buildIntent(): Uint8Array {
    return encodeUpdateIntent({
      kaId: kaId.toString(),
      contextGraphId,
      preUpdateMerkleRootCount: Number(preUpdateMerkleRootCount),
      newMerkleRoot,
      newByteSize: Number(newByteSize),
      newTokenAmount: newTokenAmount.toString(),
      mintAmount: Number(mintAmount),
      burnTokenIds: burnTokenIds.map((b) => b.toString()),
      newMerkleLeafCount,
      publisherPeerId: 'publisher-0',
      stagingQuads,
    });
  }

  function expectedDigest(): Uint8Array {
    return computeUpdateACKDigest(
      TEST_CHAIN_ID,
      TEST_KAV10_ADDR,
      cgIdBigInt,
      kaId,
      preUpdateMerkleRootCount,
      newMerkleRoot,
      newByteSize,
      newTokenAmount,
      mintAmount,
      burnTokenIds,
      BigInt(newMerkleLeafCount),
    );
  }

  // OT-RFC-49 WS-D — curated UPDATE catalog ACK. A curated update ships the
  // PUBLIC `_catalog` N-quads inline; the core REBUILDS the catalog root and
  // DECLINEs CATALOG_ROOT_MISMATCH on disagreement — the PRIVATE newMerkleRoot
  // stays trusted (the core holds no plaintext). byteSize parity is vs
  // `newByteSize` (UpdateIntent has NO publicByteSize, unlike PublishIntent),
  // which the producer sets to the catalog footprint.
  describe('isEncryptedPayload (curated catalog ACK path — OT-RFC-49 WS-D)', () => {
    const cgDid = `did:dkg:context-graph:${contextGraphId}`;
    const catalogTriples = [
      { subject: cgDid, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://www.w3.org/ns/dcat#Dataset' },
      { subject: cgDid, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#PrivateContextGraph' },
      { subject: cgDid, predicate: 'http://purl.org/dc/terms/identifier', object: `"${cgDid}"` },
    ];
    const catalogNquads = catalogTriples
      .map((t) => `<${t.subject}> <${t.predicate}> ${t.object.startsWith('"') ? t.object : `<${t.object}>`} .`)
      .join('\n');
    const catalogBytes = new TextEncoder().encode(catalogNquads);
    const expectedCatalog = computeCatalogRoot(catalogTriples);
    const catalogRoot = expectedCatalog.root;
    const catalogLeafCount = expectedCatalog.leafCount;
    // The PRIVATE flat-KC root the core cannot recompute — trusted + signed verbatim.
    const claimedPrivateRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('curated-update-private-root')));

    function curatedUpdateIntent(overrides: Record<string, unknown> = {}): Uint8Array {
      return encodeUpdateIntent({
        kaId: kaId.toString(),
        contextGraphId,
        preUpdateMerkleRootCount: Number(preUpdateMerkleRootCount),
        newMerkleRoot: claimedPrivateRoot,
        newByteSize: catalogBytes.length, // byteSize = catalog footprint (the trap)
        newTokenAmount: newTokenAmount.toString(),
        mintAmount: Number(mintAmount),
        burnTokenIds: burnTokenIds.map((b) => b.toString()),
        newMerkleLeafCount,
        publisherPeerId: 'curator-edge',
        stagingQuads: catalogBytes,
        isEncryptedPayload: true,
        newCatalogRoot: catalogRoot,
        newCatalogLeafCount: catalogLeafCount,
        ...overrides,
      });
    }

    function curatedDigest(): Uint8Array {
      return computeUpdateACKDigest(
        TEST_CHAIN_ID,
        TEST_KAV10_ADDR,
        cgIdBigInt,
        kaId,
        preUpdateMerkleRootCount,
        claimedPrivateRoot,
        BigInt(catalogBytes.length),
        newTokenAmount,
        mintAmount,
        burnTokenIds,
        BigInt(newMerkleLeafCount),
        catalogRoot,
        BigInt(catalogLeafCount),
      );
    }

    function makeHandler(wallet: ethers.Wallet, store = new OxigraphStore()) {
      return new StorageACKHandler(store as any, makeConfig(wallet, 42n), new TypedEventBus() as any);
    }

    it('rebuilds + verifies the catalog root, persists <cg>/_catalog, and signs the catalog ACK digest', async () => {
      const wallet = ethers.Wallet.createRandom();
      const store = new OxigraphStore();
      const handler = makeHandler(wallet, store);

      const ack = decodeStorageACK(await handler.updateHandler(curatedUpdateIntent(), fakePeerId));
      expect(isStorageACKDecline(ack)).toBe(false);

      // The ACK carries the trusted PRIVATE merkleRoot (the core never recomputes it).
      const decodedRoot = ack.merkleRoot instanceof Uint8Array ? ack.merkleRoot : new Uint8Array(ack.merkleRoot);
      expect(Buffer.from(decodedRoot).equals(Buffer.from(claimedPrivateRoot))).toBe(true);

      // The digest is signed over the CATALOG commitment (not opaque ciphertext).
      const recovered = ethers.recoverAddress(ethers.hashMessage(curatedDigest()), {
        r: ethers.hexlify(ack.coreNodeSignatureR instanceof Uint8Array ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR)),
        yParityAndS: ethers.hexlify(ack.coreNodeSignatureVS instanceof Uint8Array ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS)),
      });
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());

      // The verified public catalog is REPLACE-persisted to `<cg>/_catalog`.
      const persisted = await store.query(`SELECT ?s WHERE { GRAPH <${cgDid}/_catalog> { ?s ?p ?o } } LIMIT 1`);
      expect(persisted.type).toBe('bindings');
      if (persisted.type === 'bindings') expect(persisted.bindings.length).toBeGreaterThan(0);
    });

    it('DECLINEs CATALOG_ROOT_MISMATCH when the rebuilt root != the claimed newCatalogRoot', async () => {
      const handler = makeHandler(ethers.Wallet.createRandom());
      const wrongRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('wrong-catalog-root')));
      const ack = decodeStorageACK(await handler.updateHandler(curatedUpdateIntent({ newCatalogRoot: wrongRoot }), fakePeerId));
      expect(isStorageACKDecline(ack)).toBe(true);
      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH);
    });

    it('DECLINEs CATALOG_ROOT_MISMATCH on byteSize fraud (newByteSize != inline catalog bytes)', async () => {
      const handler = makeHandler(ethers.Wallet.createRandom());
      const ack = decodeStorageACK(await handler.updateHandler(curatedUpdateIntent({ newByteSize: catalogBytes.length + 100 }), fakePeerId));
      expect(isStorageACKDecline(ack)).toBe(true);
      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH);
    });

    it('DECLINEs CATALOG_ROOT_MISMATCH when the inline catalog stagingQuads is missing', async () => {
      const handler = makeHandler(ethers.Wallet.createRandom());
      const ack = decodeStorageACK(await handler.updateHandler(curatedUpdateIntent({ stagingQuads: undefined, newByteSize: 0 }), fakePeerId));
      expect(isStorageACKDecline(ack)).toBe(true);
      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH);
    });

    it('leaves a non-curated (public) update untouched — no catalog gate, MERKLE recompute path', async () => {
      // Regression guard: isEncryptedPayload=false skips the curated block entirely.
      const handler = makeHandler(ethers.Wallet.createRandom());
      const ack = decodeStorageACK(await handler.updateHandler(buildIntent(), fakePeerId));
      expect(isStorageACKDecline(ack)).toBe(false);
    });

    it('curated catalog persist / deleteByPattern throws → CORE_TEMPORARILY_UNAVAILABLE ("store unavailable"), NO signed ACK', async () => {
      // Dead-air regression (otReviewAgent #1408:650): a curated UPDATE with a
      // VALID rotated catalog root whose `<cg>/_catalog` REPLACE (deleteByPattern)
      // hits a closed store used to throw out of the handler → stream reset →
      // publisher no_response. It must instead reply with the transient decline.
      const onDecline = vi.fn();
      const store = storeWithFailingOps(new OxigraphStore(), ['deleteByPattern']);
      const handler = new StorageACKHandler(
        store as any,
        makeConfig(ethers.Wallet.createRandom(), 42n, { onDecline }),
        new TypedEventBus() as any,
      );
      const ack = decodeStorageACK(await handler.updateHandler(curatedUpdateIntent(), fakePeerId));

      expect(isStorageACKDecline(ack)).toBe(true);
      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
      expect(ack.declineMessage).toBe('store unavailable');
      // No signed ACK rides a decline — the signature fields stay empty.
      const r = ack.coreNodeSignatureR instanceof Uint8Array
        ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR ?? []);
      expect(r.length).toBe(0);
      // Wire hygiene: raw store error stays OFF the wire, but reaches the hook.
      expect(ack.declineMessage).not.toContain('store is closed');
      expect(onDecline).toHaveBeenCalledOnce();
      expect(onDecline.mock.calls[0]?.[0]).toMatchObject({
        code: STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE,
        contextGraphId,
        message: expect.stringContaining('store is closed'),
      });
    });

    it('curated catalog persist / insert throws → CORE_TEMPORARILY_UNAVAILABLE ("store unavailable"), NO signed ACK', async () => {
      // Same durability invariant, second store call: deletes succeed but the
      // catalog INSERT hits the closed store. Still a transient decline.
      const store = storeWithFailingOps(new OxigraphStore(), ['insert']);
      const handler = makeHandler(ethers.Wallet.createRandom(), store as any);
      const ack = decodeStorageACK(await handler.updateHandler(curatedUpdateIntent(), fakePeerId));

      expect(isStorageACKDecline(ack)).toBe(true);
      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
      expect(ack.declineMessage).toBe('store unavailable');
      const r = ack.coreNodeSignatureR instanceof Uint8Array
        ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR ?? []);
      expect(r.length).toBe(0);
    });
  });

  it('peer signs computeUpdateACKDigest and the signature recovers to the operational key', async () => {
    const wallet = ethers.Wallet.createRandom();
    const handler = new StorageACKHandler(
      new OxigraphStore() as any,
      makeConfig(wallet, 42n),
      new TypedEventBus() as any,
    );

    const response = await handler.updateHandler(buildIntent(), fakePeerId);
    const ack = decodeStorageACK(response);
    expect(isStorageACKDecline(ack)).toBe(false);

    // merkleRoot field carries newMerkleRoot.
    const decodedRoot = ack.merkleRoot instanceof Uint8Array ? ack.merkleRoot : new Uint8Array(ack.merkleRoot);
    expect(Buffer.from(decodedRoot).equals(Buffer.from(newMerkleRoot))).toBe(true);

    const recovered = ethers.recoverAddress(ethers.hashMessage(expectedDigest()), {
      r: ethers.hexlify(ack.coreNodeSignatureR instanceof Uint8Array ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR)),
      yParityAndS: ethers.hexlify(ack.coreNodeSignatureVS instanceof Uint8Array ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS)),
    });
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('declines with MERKLE_MISMATCH_IN_SWM when newMerkleRoot does not match the quads', async () => {
    const wallet = ethers.Wallet.createRandom();
    const handler = new StorageACKHandler(
      new OxigraphStore() as any,
      makeConfig(wallet, 42n),
      new TypedEventBus() as any,
    );
    const wrongRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('wrong')));
    const intent = encodeUpdateIntent({
      kaId: kaId.toString(),
      contextGraphId,
      preUpdateMerkleRootCount: Number(preUpdateMerkleRootCount),
      newMerkleRoot: wrongRoot,
      newByteSize: Number(newByteSize),
      newTokenAmount: newTokenAmount.toString(),
      newMerkleLeafCount,
      publisherPeerId: 'publisher-0',
      stagingQuads,
    });
    const ack = decodeStorageACK(await handler.updateHandler(intent, fakePeerId));
    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
  });

  it('calls the decline hook for UPDATE typed declines', async () => {
    const wallet = ethers.Wallet.createRandom();
    const onDecline = vi.fn();
    const handler = new StorageACKHandler(
      new OxigraphStore() as any,
      makeConfig(wallet, 42n, { onDecline }),
      new TypedEventBus() as any,
    );
    const intent = encodeUpdateIntent({
      kaId: kaId.toString(),
      contextGraphId,
      preUpdateMerkleRootCount: Number(preUpdateMerkleRootCount),
      newMerkleRoot,
      newByteSize: Number(newByteSize),
      newTokenAmount: newTokenAmount.toString(),
      mintAmount: Number(mintAmount),
      burnTokenIds: burnTokenIds.map((b) => b.toString()),
      newMerkleLeafCount,
      publisherPeerId: 'publisher-0',
    });

    const ack = decodeStorageACK(await handler.updateHandler(intent, fakePeerId));

    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM);
    expect(onDecline).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledWith({
      code: STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM,
      contextGraphId,
      message: expect.stringContaining('UpdateStorageACK: no data found in SWM graph'),
    });
  });

  // #1283 — PUBLIC-update byteSize floor. The pre-fix updateHandler verified
  // only the new Merkle root and signed the publisher-supplied `newByteSize`
  // with NO floor, so a publisher could ship a correct new root while
  // under-declaring `newByteSize` (e.g. 1) to underpay the on-chain
  // storage-growth charge (the contract only charges when newByteSize >
  // currentByteSize). The fix mirrors the public-PUBLISH floor into the two
  // public-update branches. The discriminator that makes these tests prove the
  // *floor* (not the merkle gate, which runs first): keep `newMerkleRoot`
  // CORRECT and assert the SPECIFIC BYTESIZE_UNDERCLAIM decline code.
  describe('#1283 public-update byteSize floor', () => {
    function makeHandler(wallet: ethers.Wallet, store = new OxigraphStore()) {
      return new StorageACKHandler(store as any, makeConfig(wallet, 42n), new TypedEventBus() as any);
    }

    // INLINE public update: CORRECT root, overridable newByteSize.
    function publicInlineUpdateIntent(overrides: Record<string, unknown> = {}): Uint8Array {
      return encodeUpdateIntent({
        kaId: kaId.toString(),
        contextGraphId,
        preUpdateMerkleRootCount: Number(preUpdateMerkleRootCount),
        newMerkleRoot, // correct: computeFlatKCRoot(updatedQuads, [])
        newByteSize: Number(newByteSize),
        newTokenAmount: newTokenAmount.toString(),
        mintAmount: Number(mintAmount),
        burnTokenIds: burnTokenIds.map((b) => b.toString()),
        newMerkleLeafCount,
        publisherPeerId: 'publisher-0',
        stagingQuads,
        ...overrides,
      });
    }

    it('(a) INLINE under-claim → BYTESIZE_UNDERCLAIM decline (correct root, newByteSize=1)', async () => {
      // Correct new root passes the MERKLE gate (which runs FIRST), so a decline
      // here can only come from the new byteSize floor. Pre-fix this signed a
      // valid ACK (no floor existed); the fix turns it into a typed decline.
      const handler = makeHandler(ethers.Wallet.createRandom());
      const decoded = decodeStorageACK(
        await handler.updateHandler(publicInlineUpdateIntent({ newByteSize: 1 }), fakePeerId),
      );
      expect(isStorageACKDecline(decoded)).toBe(true);
      expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.BYTESIZE_UNDERCLAIM);
      expect(decoded.declineMessage).toContain('under-claim');
      // And it is NOT a signed ACK: the signature fields are empty on a decline.
      const r = decoded.coreNodeSignatureR instanceof Uint8Array
        ? decoded.coreNodeSignatureR : new Uint8Array(decoded.coreNodeSignatureR);
      expect(r.length).toBe(0);
    });

    it('(b) positive control — INLINE newByteSize == stagingQuads.length → VALID signed ACK', async () => {
      // The floor is `newByteSize < floor`, so equality is accepted. Prove a
      // REAL ACK by recovering the signer over the exact 13-field update digest.
      const wallet = ethers.Wallet.createRandom();
      const handler = makeHandler(wallet);
      const decoded = decodeStorageACK(
        await handler.updateHandler(publicInlineUpdateIntent({ newByteSize: Number(newByteSize) }), fakePeerId),
      );
      expect(isStorageACKDecline(decoded)).toBe(false);

      const decodedRoot = decoded.merkleRoot instanceof Uint8Array
        ? decoded.merkleRoot : new Uint8Array(decoded.merkleRoot);
      expect(Buffer.from(decodedRoot).equals(Buffer.from(newMerkleRoot))).toBe(true);

      const recovered = ethers.recoverAddress(ethers.hashMessage(expectedDigest()), {
        r: ethers.hexlify(decoded.coreNodeSignatureR instanceof Uint8Array
          ? decoded.coreNodeSignatureR : new Uint8Array(decoded.coreNodeSignatureR)),
        yParityAndS: ethers.hexlify(decoded.coreNodeSignatureVS instanceof Uint8Array
          ? decoded.coreNodeSignatureVS : new Uint8Array(decoded.coreNodeSignatureVS)),
      });
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    });

    it('(b2) positive control — INLINE newByteSize ABOVE the floor → VALID signed ACK', async () => {
      const wallet = ethers.Wallet.createRandom();
      const handler = makeHandler(wallet);
      const decoded = decodeStorageACK(
        await handler.updateHandler(
          publicInlineUpdateIntent({ newByteSize: Number(newByteSize) + 1000 }),
          fakePeerId,
        ),
      );
      expect(isStorageACKDecline(decoded)).toBe(false);
      // Digest binds the (larger) claimed newByteSize, recovers to the signer.
      const digestAbove = computeUpdateACKDigest(
        TEST_CHAIN_ID,
        TEST_KAV10_ADDR,
        cgIdBigInt,
        kaId,
        preUpdateMerkleRootCount,
        newMerkleRoot,
        newByteSize + 1000n,
        newTokenAmount,
        mintAmount,
        burnTokenIds,
        BigInt(newMerkleLeafCount),
      );
      const recovered = ethers.recoverAddress(ethers.hashMessage(digestAbove), {
        r: ethers.hexlify(decoded.coreNodeSignatureR instanceof Uint8Array
          ? decoded.coreNodeSignatureR : new Uint8Array(decoded.coreNodeSignatureR)),
        yParityAndS: ethers.hexlify(decoded.coreNodeSignatureVS instanceof Uint8Array
          ? decoded.coreNodeSignatureVS : new Uint8Array(decoded.coreNodeSignatureVS)),
      });
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    });

    it('(c) SWM-fallback under-claim → BYTESIZE_UNDERCLAIM decline (no stagingQuads, correct root, newByteSize=1)', async () => {
      // No inline payload: the data lives in SWM at `<cg>/_shared_memory` (the
      // legacy read-both bucket the loadSWMQuads CONSTRUCT reads). The recompute
      // matches `newMerkleRoot`, so the MERKLE gate passes and only the new
      // Σ(UTF-8 term bytes) floor can decline.
      const store = new OxigraphStore();
      const swmGraph = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;
      await store.insert(updatedQuads.map((q) => ({ ...q, graph: swmGraph })));
      const handler = makeHandler(ethers.Wallet.createRandom(), store);

      const swmIntent = encodeUpdateIntent({
        kaId: kaId.toString(),
        contextGraphId,
        preUpdateMerkleRootCount: Number(preUpdateMerkleRootCount),
        newMerkleRoot, // correct: recompute over the SWM quads matches this
        newByteSize: 1,
        newTokenAmount: newTokenAmount.toString(),
        mintAmount: Number(mintAmount),
        burnTokenIds: burnTokenIds.map((b) => b.toString()),
        newMerkleLeafCount,
        publisherPeerId: 'publisher-0',
        // no stagingQuads → SWM-fallback branch
      });

      const decoded = decodeStorageACK(await handler.updateHandler(swmIntent, fakePeerId));
      expect(isStorageACKDecline(decoded)).toBe(true);
      expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.BYTESIZE_UNDERCLAIM);
      expect(decoded.declineMessage).toContain('under-claim');
    });

    it('(c2) SWM-fallback positive control — newByteSize at the Σ UTF-8 term-byte floor → VALID signed ACK', async () => {
      // The serialization-independent SWM floor is Σ(UTF-8 byteLength(s,p,o));
      // claiming exactly that floor is accepted (gate is `< floor`).
      const store = new OxigraphStore();
      const swmGraph = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;
      await store.insert(updatedQuads.map((q) => ({ ...q, graph: swmGraph })));
      const wallet = ethers.Wallet.createRandom();
      const handler = makeHandler(wallet, store);

      const swmFloor = updatedQuads.reduce(
        (acc, q) =>
          acc +
          Buffer.byteLength(q.subject, 'utf8') +
          Buffer.byteLength(q.predicate, 'utf8') +
          Buffer.byteLength(q.object, 'utf8'),
        0,
      );

      const swmIntent = encodeUpdateIntent({
        kaId: kaId.toString(),
        contextGraphId,
        preUpdateMerkleRootCount: Number(preUpdateMerkleRootCount),
        newMerkleRoot,
        newByteSize: swmFloor,
        newTokenAmount: newTokenAmount.toString(),
        mintAmount: Number(mintAmount),
        burnTokenIds: burnTokenIds.map((b) => b.toString()),
        newMerkleLeafCount,
        publisherPeerId: 'publisher-0',
      });

      const decoded = decodeStorageACK(await handler.updateHandler(swmIntent, fakePeerId));
      expect(isStorageACKDecline(decoded)).toBe(false);
      const digestSwm = computeUpdateACKDigest(
        TEST_CHAIN_ID,
        TEST_KAV10_ADDR,
        cgIdBigInt,
        kaId,
        preUpdateMerkleRootCount,
        newMerkleRoot,
        BigInt(swmFloor),
        newTokenAmount,
        mintAmount,
        burnTokenIds,
        BigInt(newMerkleLeafCount),
      );
      const recovered = ethers.recoverAddress(ethers.hashMessage(digestSwm), {
        r: ethers.hexlify(decoded.coreNodeSignatureR instanceof Uint8Array
          ? decoded.coreNodeSignatureR : new Uint8Array(decoded.coreNodeSignatureR)),
        yParityAndS: ethers.hexlify(decoded.coreNodeSignatureVS instanceof Uint8Array
          ? decoded.coreNodeSignatureVS : new Uint8Array(decoded.coreNodeSignatureVS)),
      });
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    });
  });

  it('collectUpdate reaches a 3-of-4 quorum, recovering each signer against the update digest', async () => {
    const coreWallets = [
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
    ];
    // One real handler instance per peer (distinct signer + identity).
    const handlers = coreWallets.map((w, i) =>
      new StorageACKHandler(new OxigraphStore() as any, makeConfig(w, BigInt(i + 1)), new TypedEventBus() as any),
    );

    const recoveredByPeer = new Map<string, string>();
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (peerId, protocol, data) => {
        expect(protocol).toBe(PROTOCOL_STORAGE_UPDATE_ACK);
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        return handlers[idx].updateHandler(data, { toString: () => peerId });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3'],
      // Pre-flight: accept every signer; record the recovered address so we
      // can assert the collector recovered the correct operational keys.
      verifyIdentity: async (recoveredAddress, identityId) => {
        recoveredByPeer.set(identityId.toString(), recoveredAddress);
        return true;
      },
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    const result = await collector.collectUpdate({
      kaId,
      contextGraphId: cgIdBigInt,
      preUpdateMerkleRootCount,
      newMerkleRoot,
      newByteSize,
      newTokenAmount,
      mintAmount,
      burnTokenIds,
      newMerkleLeafCount,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      publisherPeerId: 'publisher-0',
      requiredACKs: 3,
      stagingQuads,
    });

    expect(result.acks).toHaveLength(3);
    expect(result.contextGraphId).toBe(cgIdBigInt);
    expect(Buffer.from(result.merkleRoot).equals(Buffer.from(newMerkleRoot))).toBe(true);
    for (const ack of result.acks) {
      expect(ack.signatureR.length).toBe(32);
      expect(ack.signatureVS.length).toBe(32);
      expect(ack.nodeIdentityId).toBeGreaterThan(0n);
      // Each collected identity recovered to its core wallet.
      const idx = Number(ack.nodeIdentityId) - 1;
      expect(recoveredByPeer.get(ack.nodeIdentityId.toString())?.toLowerCase()).toBe(
        coreWallets[idx].address.toLowerCase(),
      );
    }
  });

  it('collectUpdate throws QuorumUnmet when fewer peers than required can sign', async () => {
    const coreWallets = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
    const handlers = coreWallets.map((w, i) =>
      new StorageACKHandler(new OxigraphStore() as any, makeConfig(w, BigInt(i + 1)), new TypedEventBus() as any),
    );
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (peerId, _protocol, data) => {
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        return handlers[idx].updateHandler(data, { toString: () => peerId });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1'],
      verifyIdentity: async () => true,
      log: () => {},
    };
    const collector = new ACKCollector(deps);
    await expect(
      collector.collectUpdate({
        kaId,
        contextGraphId: cgIdBigInt,
        preUpdateMerkleRootCount,
        newMerkleRoot,
        newByteSize,
        newTokenAmount,
        mintAmount,
        burnTokenIds,
        newMerkleLeafCount,
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
        publisherPeerId: 'publisher-0',
        requiredACKs: 3,
        stagingQuads,
      }),
    ).rejects.toThrow(/quorum impossible/i);
  });
});
