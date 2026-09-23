/**
 * Curated catalog StorageACK hardening: the inline catalog a curated publish
 * or update ships must be exactly a catalog partition of the Context Graph's
 * own DID, and it reaches the core's public `<cg>/_catalog` only after every
 * check and the signer gate have passed.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  STORAGE_ACK_DECLINE_CODES,
  TypedEventBus,
  computeCatalogRoot,
  contextGraphCatalogUri,
  decodeStorageACK,
  encodePublishIntent,
  encodeUpdateIntent,
  isStorageACKDecline,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';

const CG_ID = '42';
const CG_DID = `did:dkg:context-graph:${CG_ID}`;
const SOURCE_ID = 'research-cg';
const SOURCE_DID = `did:dkg:context-graph:${SOURCE_ID}`;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DCAT_DATASET = 'http://www.w3.org/ns/dcat#Dataset';
const DCT_IDENTIFIER = 'http://purl.org/dc/terms/identifier';
const PEER = { toString: () => 'curator-peer' };
const KA_ID = (BigInt('0x1111111111111111111111111111111111111111') << 96n) | 7n;

interface Triple { subject: string; predicate: string; object: string }

function floor(subject = CG_DID): Triple[] {
  return [
    { subject, predicate: RDF_TYPE, object: DCAT_DATASET },
    { subject, predicate: DCT_IDENTIFIER, object: `"${subject}"` },
  ];
}

function nquads(triples: readonly Triple[]): Uint8Array {
  return new TextEncoder().encode(triples
    .map((t) => `<${t.subject}> <${t.predicate}> ${t.object.startsWith('"') ? t.object : `<${t.object}>`} .`)
    .join('\n'));
}

function handler(options: { signerRegistered?: boolean } = {}) {
  const store = new OxigraphStore();
  const config: StorageACKHandlerConfig = {
    nodeRole: 'core',
    nodeIdentityId: 17n,
    signerWallet: ethers.Wallet.createRandom(),
    contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
    chainId: 31337n,
    kav10Address: '0x000000000000000000000000000000000000c10a',
    isCgCurated: async () => true,
    ...(options.signerRegistered === undefined
      ? {}
      : { isSignerRegistered: async () => options.signerRegistered! }),
  };
  return { store, handler: new StorageACKHandler(store, config, new TypedEventBus()) };
}

function publishIntent(triples: readonly Triple[], overrides: Record<string, unknown> = {}): Uint8Array {
  const bytes = nquads(triples);
  const catalog = computeCatalogRoot(triples);
  return encodePublishIntent({
    merkleRoot: ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('curated-private-root'))),
    contextGraphId: CG_ID,
    publisherPeerId: 'curator-peer',
    publicByteSize: bytes.length,
    isPrivate: true,
    kaCount: 1,
    rootEntities: [],
    stagingQuads: bytes,
    merkleLeafCount: 0,
    isEncryptedPayload: true,
    catalogRoot: catalog.root,
    catalogLeafCount: catalog.leafCount,
    ...overrides,
  });
}

function updateIntent(triples: readonly Triple[], overrides: Record<string, unknown> = {}): Uint8Array {
  const bytes = nquads(triples);
  const catalog = computeCatalogRoot(triples);
  return encodeUpdateIntent({
    kaId: KA_ID.toString(),
    contextGraphId: CG_ID,
    preUpdateMerkleRootCount: 1,
    newMerkleRoot: ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('curated-update-root'))),
    newByteSize: bytes.length,
    newTokenAmount: '1000',
    mintAmount: 0,
    burnTokenIds: [],
    newMerkleLeafCount: 1,
    publisherPeerId: 'curator-peer',
    stagingQuads: bytes,
    isEncryptedPayload: true,
    newCatalogRoot: catalog.root,
    newCatalogLeafCount: catalog.leafCount,
    ...overrides,
  });
}

const OUTSIDE_THE_PARTITION: Array<{ label: string; triples: Triple[] }> = [
  {
    label: 'a non-catalog predicate on the Context Graph DID',
    triples: [...floor(), { subject: CG_DID, predicate: 'http://schema.org/name', object: '"leaked"' }],
  },
  {
    label: 'a non-catalog rdf:type on the Context Graph DID',
    triples: [...floor(), { subject: CG_DID, predicate: RDF_TYPE, object: 'http://schema.org/Person' }],
  },
  {
    label: 'another subject',
    triples: [...floor(), { subject: 'urn:victim:entity', predicate: DCT_IDENTIFIER, object: '"forged"' }],
  },
  {
    label: 'only a foreign subject',
    triples: floor('urn:victim:entity'),
  },
];

describe('curated catalog StorageACK hardening', () => {
  describe('publish', () => {
    it.each(OUTSIDE_THE_PARTITION)('declines a catalog with $label and stores nothing', async ({ triples }) => {
      const { store, handler: h } = handler();

      const ack = decodeStorageACK(await h.handler(publishIntent(triples), PEER));

      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH);
      expect(await store.countQuads(contextGraphCatalogUri(CG_ID))).toBe(0);
    });

    it('signs a catalog on the SWM graph DID the intent names', async () => {
      const { store, handler: h } = handler();

      const ack = decodeStorageACK(await h.handler(
        publishIntent(floor(SOURCE_DID), { swmGraphId: SOURCE_ID }),
        PEER,
      ));

      expect(isStorageACKDecline(ack)).toBe(false);
      expect(await store.countQuads(contextGraphCatalogUri(CG_ID))).toBe(2);
    });

    it('does not store the catalog of a request declined after the catalog check', async () => {
      const { store, handler: h } = handler();

      const ack = decodeStorageACK(await h.handler(publishIntent(floor(), { kaCount: 2 }), PEER));

      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
      expect(await store.countQuads(contextGraphCatalogUri(CG_ID))).toBe(0);
    });

    it('does not store the catalog when the signer gate declines', async () => {
      const { store, handler: h } = handler({ signerRegistered: false });

      const ack = decodeStorageACK(await h.handler(publishIntent(floor()), PEER));

      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED);
      expect(await store.countQuads(contextGraphCatalogUri(CG_ID))).toBe(0);
    });

    it('stores the verified catalog and signs a valid curated publish', async () => {
      const { store, handler: h } = handler({ signerRegistered: true });

      const ack = decodeStorageACK(await h.handler(publishIntent(floor()), PEER));

      expect(isStorageACKDecline(ack)).toBe(false);
      expect(await store.countQuads(contextGraphCatalogUri(CG_ID))).toBe(2);
    });
  });

  describe('update', () => {
    it.each(OUTSIDE_THE_PARTITION)('declines a catalog with $label and stores nothing', async ({ triples }) => {
      const { store, handler: h } = handler();

      const ack = decodeStorageACK(await h.updateHandler(updateIntent(triples), PEER));

      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH);
      expect(await store.countQuads(contextGraphCatalogUri(CG_ID))).toBe(0);
    });

    it('does not store the catalog when the signer gate declines', async () => {
      const { store, handler: h } = handler({ signerRegistered: false });

      const ack = decodeStorageACK(await h.updateHandler(updateIntent(floor()), PEER));

      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED);
      expect(await store.countQuads(contextGraphCatalogUri(CG_ID))).toBe(0);
    });

    it('stores the rotated catalog and signs a valid curated update', async () => {
      const { store, handler: h } = handler({ signerRegistered: true });

      const ack = decodeStorageACK(await h.updateHandler(updateIntent(floor()), PEER));

      expect(isStorageACKDecline(ack)).toBe(false);
      expect(await store.countQuads(contextGraphCatalogUri(CG_ID))).toBe(2);
    });
  });
});
