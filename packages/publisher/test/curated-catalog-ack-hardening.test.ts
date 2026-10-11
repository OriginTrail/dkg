/**
 * Curated catalog StorageACK hardening: the inline catalog a curated publish
 * or update ships must be exactly a catalog partition of the Context Graph's
 * own DID, and it reaches the core's public `<cg>/_catalog` only after every
 * check and the signer gate have passed.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  DKG_ONTOLOGY,
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

/** A valid catalog that differs from `floor()`, so replacing one with the other is visible. */
const ROTATED: Triple[] = [
  ...floor(),
  { subject: CG_DID, predicate: DKG_ONTOLOGY.DCT_ACCESS_RIGHTS, object: DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED },
];

function nquads(triples: readonly Triple[]): Uint8Array {
  return new TextEncoder().encode(triples
    .map((t) => `<${t.subject}> <${t.predicate}> ${t.object.startsWith('"') ? t.object : `<${t.object}>`} .`)
    .join('\n'));
}

function handler(options: { signerRegistered?: () => boolean } = {}) {
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
      : { isSignerRegistered: async () => options.signerRegistered!() }),
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

type Handler = ReturnType<typeof handler>['handler'];

/** The two curated ACK paths, which must verify and persist a catalog identically. */
const PATHS = [
  {
    name: 'publish',
    label: 'curated ACK',
    intent: publishIntent,
    send: (h: Handler, bytes: Uint8Array) => h.handler(bytes, PEER),
    claim: (root: Uint8Array, leafCount: number) => ({ catalogRoot: root, catalogLeafCount: leafCount }),
  },
  {
    name: 'update',
    label: 'curated UPDATE ACK',
    intent: updateIntent,
    send: (h: Handler, bytes: Uint8Array) => h.updateHandler(bytes, PEER),
    claim: (root: Uint8Array, leafCount: number) => ({ newCatalogRoot: root, newCatalogLeafCount: leafCount }),
  },
] as const;

type Path = (typeof PATHS)[number];

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

/** Every committed-leaf disagreement, as a request against `ROTATED`. */
const COMMITMENT_MISMATCHES: Array<{
  label: string;
  message: string;
  request: (path: Path) => Uint8Array;
}> = [
  {
    label: 'a catalog with no committed leaf',
    message: ': inline catalog parsed to zero committed leaves',
    // `dkg:committedRoot` is a catalog predicate the committed leaf-set strips.
    request: (path) => {
      const stampOnly = [{ subject: CG_DID, predicate: DKG_ONTOLOGY.DKG_COMMITTED_ROOT, object: '"0xabc"' }];
      return path.intent(stampOnly);
    },
  },
  {
    label: 'a leaf count the catalog does not have',
    message: ' leaf-count mismatch: rebuilt 3 catalog leaves but publisher claims 4',
    request: (path) => path.intent(ROTATED, path.claim(computeCatalogRoot(ROTATED).root, 4)),
  },
  {
    label: 'a root the catalog does not rebuild to',
    message: ' root mismatch: rebuilt catalog root=',
    request: (path) => path.intent(ROTATED, path.claim(computeCatalogRoot(floor()).root, ROTATED.length)),
  },
];

/** The catalog graph's triples, order-independent. */
async function storedCatalog(store: OxigraphStore): Promise<string[]> {
  const result = await store.query(
    `SELECT ?s ?p ?o WHERE { GRAPH <${contextGraphCatalogUri(CG_ID)}> { ?s ?p ?o } }`,
  );
  if (result.type !== 'bindings') throw new Error(`unexpected ${result.type} result`);
  return result.bindings.map((row) => `${row['s']} ${row['p']} ${row['o']}`).sort();
}

/**
 * A core whose `<cg>/_catalog` already holds the catalog of an accepted
 * request. A declined request must leave it exactly as it is: a persist that
 * ran before the decline would replace it, and one that cleared the graph
 * first would empty it.
 */
async function coreWithStoredCatalog(path: Path) {
  const signer = { registered: true };
  const core = handler({ signerRegistered: () => signer.registered });
  const seed = decodeStorageACK(await path.send(core.handler, path.intent(floor())));
  expect(isStorageACKDecline(seed)).toBe(false);
  const stored = await storedCatalog(core.store);
  expect(stored).toHaveLength(floor().length);
  return { ...core, signer, stored };
}

describe.each(PATHS)('curated $name StorageACK catalog hardening', (path) => {
  it.each(OUTSIDE_THE_PARTITION)('declines a catalog with $label and stores nothing', async ({ triples }) => {
    const { store, handler: h } = handler();

    const ack = decodeStorageACK(await path.send(h, path.intent(triples)));

    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH);
    expect(await store.countQuads(contextGraphCatalogUri(CG_ID))).toBe(0);
  });

  it('signs a catalog on the SWM graph DID the intent names', async () => {
    const { store, handler: h } = handler();

    const ack = decodeStorageACK(await path.send(h, path.intent(floor(SOURCE_DID), { swmGraphId: SOURCE_ID })));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(await store.countQuads(contextGraphCatalogUri(CG_ID))).toBe(2);
  });

  it.each(COMMITMENT_MISMATCHES)(
    'declines $label, naming the path, and keeps the stored catalog',
    async ({ message, request }) => {
      const core = await coreWithStoredCatalog(path);

      const ack = decodeStorageACK(await path.send(core.handler, request(path)));

      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH);
      expect(ack.declineMessage).toContain(`${path.label}${message}`);
      expect(await storedCatalog(core.store)).toEqual(core.stored);
    },
  );

  it('keeps the stored catalog when the signer gate declines', async () => {
    const core = await coreWithStoredCatalog(path);
    core.signer.registered = false;

    const ack = decodeStorageACK(await path.send(core.handler, path.intent(ROTATED)));

    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED);
    expect(await storedCatalog(core.store)).toEqual(core.stored);
  });

  it('replaces the stored catalog with the verified one and signs', async () => {
    const core = await coreWithStoredCatalog(path);

    const ack = decodeStorageACK(await path.send(core.handler, path.intent(ROTATED)));

    expect(isStorageACKDecline(ack)).toBe(false);
    const stored = await storedCatalog(core.store);
    expect(stored).toHaveLength(ROTATED.length);
    expect(stored).toEqual(expect.arrayContaining(core.stored));
  });
});

describe('curated publish StorageACK catalog persistence', () => {
  it('keeps the stored catalog when a check after the catalog declines', async () => {
    const core = await coreWithStoredCatalog(PATHS[0]);

    const ack = decodeStorageACK(await core.handler.handler(publishIntent(ROTATED, { kaCount: 2 }), PEER));

    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
    expect(await storedCatalog(core.store)).toEqual(core.stored);
  });
});
