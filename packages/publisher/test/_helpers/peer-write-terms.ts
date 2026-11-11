/**
 * A peer's publish or KA update that carries an RDF term the grammar does not
 * allow must be refused before the term reaches the store, with nothing
 * written. Each scenario runs a well-formed control first, so a refusal for
 * any other reason cannot pass as a refusal of the term.
 *
 * Shared by the in-process suite (`test/peer-write-term-validation.test.ts`)
 * the live Blazegraph suite
 * (`test-live/peer-write-term-validation.blazegraph.test.ts`) and the cli's
 * suite on the pinned oxigraph-server
 * (`packages/cli/test/peer-write-term-validation-oxigraph-server.test.ts`).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  contextGraphDataUri,
  contextGraphLayerUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  decodePublishAck,
  encodeKAUpdateRequest,
  encodePublishRequest,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';
import type {
  PublishHandler,
  UpdateHandler,
  computeFlatKCRootV10,
  parseSimpleNQuads,
} from '../../src/index.js';

/**
 * The publisher exports the scenarios drive, passed in so a suite outside
 * this package runs them against the built package, not a second copy of
 * the sources.
 */
export interface PeerWritePublisherApi {
  readonly PublishHandler: typeof PublishHandler;
  readonly UpdateHandler: typeof UpdateHandler;
  readonly computeFlatKCRootV10: typeof computeFlatKCRootV10;
  readonly parseSimpleNQuads: typeof parseSimpleNQuads;
}

/** Object terms that no RDF grammar allows, and a substring that identifies each in a store call. */
export const MALFORMED_OBJECT_TERMS = [
  {
    label: 'a language tag with a character a tag may not hold',
    term: '"refused value"@en_GB',
    marker: '@en_GB',
  },
  {
    label: 'a blank-node label with a character a label may not hold',
    term: '_:node!refused',
    marker: 'node!refused',
  },
] as const;

export interface PeerWriteTestStore {
  readonly store: TripleStore;
  dispose(): Promise<void>;
}

export interface PeerWriteStoreFactory {
  /** Names the store in test titles. */
  readonly name: string;
  /** A store for one test; isolated from other tests' graphs by unique graph names. */
  open(): Promise<PeerWriteTestStore>;
}

const READ_METHODS = new Set([
  'query', 'countQuads', 'hasGraph', 'listGraphs', 'listGraphsByPrefix', 'close', 'flush',
]);

/**
 * Wraps `inner` so every call other than a read is recorded with its
 * arguments, before it runs.
 */
export function recordStoreWrites(inner: TripleStore): { store: TripleStore; writes: string[] } {
  const writes: string[] = [];
  const store = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (typeof prop !== 'string' || READ_METHODS.has(prop)) return value.bind(target);
      return (...args: unknown[]) => {
        writes.push(`${prop} ${serializeArguments(args)}`);
        return value.apply(target, args);
      };
    },
  });
  return { store, writes };
}

function serializeArguments(args: readonly unknown[]): string {
  try {
    return JSON.stringify(args, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  } catch {
    return String(args);
  }
}

const PUBLISHER = '0x1111111111111111111111111111111111111111';
const PEER = { toString: () => '12D3KooWTermValidationPeer' };
const SCHEMA_NAME = 'http://schema.org/name';
const SCHEMA_DESCRIPTION = 'http://schema.org/description';
const WELL_FORMED = '"kept value"@en-GB';

function nquad(subject: string, predicate: string, object: string, graph: string): string {
  const renderedObject = object.startsWith('"') || object.startsWith('_:') ? object : `<${object}>`;
  return `<${subject}> <${predicate}> ${renderedObject} <${graph}> .`;
}

function nquadOf(quad: { subject: string; predicate: string; object: string }, graph: string): string {
  return nquad(quad.subject, quad.predicate, quad.object, graph);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function uniqueContextGraph(): string {
  return `term-validation-${randomUUID()}`;
}

/**
 * The written quad a scenario varies: an object term, or its subject,
 * predicate and object. A legacy scenario uses the subject as its manifest
 * root too.
 */
export type PeerWritePayload = string | { readonly subject?: string; readonly predicate?: string; readonly object: string };

function payload(variant: PeerWritePayload, subject: string, predicate: string): { subject: string; predicate: string; object: string } {
  return typeof variant === 'string'
    ? { subject, predicate, object: variant }
    : { subject: variant.subject ?? subject, predicate: variant.predicate ?? predicate, object: variant.object };
}

/** What a scenario observed: whether the node accepted the write, and what reached the store. */
export interface PeerWriteOutcome {
  readonly accepted: boolean;
  /** Quads in the graph the write targets, after it. */
  readonly targetQuads: number;
  /** Quads in the whole store before and after the write. */
  readonly before: number;
  readonly after: number;
  /** Every non-read store call the handler made. */
  readonly writes: readonly string[];
}

/** A direct-protocol publish of one root entity, in the legacy (manifest) envelope. */
export async function legacyPublish(
  api: PeerWritePublisherApi,
  store: TripleStore,
  variant: PeerWritePayload,
): Promise<PeerWriteOutcome> {
  const contextGraphId = uniqueContextGraph();
  const dataGraph = contextGraphDataUri(contextGraphId);
  const written = payload(variant, `urn:term-validation:${randomUUID()}`, SCHEMA_DESCRIPTION);
  const root = written.subject;
  await new GraphManager(store).ensureContextGraph(contextGraphId);
  const before = await store.countQuads();
  const recorder = recordStoreWrites(store);
  const handler = new api.PublishHandler(recorder.store, new TypedEventBus());
  const ack = decodePublishAck(await handler.handler(encodePublishRequest({
    ual: `did:dkg:mock:31337/${PUBLISHER}/1`,
    nquads: utf8([
      nquad(root, SCHEMA_NAME, '"kept"', dataGraph),
      nquad(root, written.predicate, written.object, dataGraph),
    ].join('\n')),
    contextGraphId,
    kas: [{ tokenId: 1, rootEntity: root, privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
    publisherIdentity: new Uint8Array(32),
    publisherAddress: PUBLISHER,
    startKAId: 1,
    endKAId: 1,
    chainId: 'mock:31337',
    publisherSignatureR: new Uint8Array(0),
    publisherSignatureVs: new Uint8Array(0),
  }), PEER as never));
  return {
    accepted: ack.accepted,
    targetQuads: await store.countQuads(dataGraph),
    before,
    after: await store.countQuads(),
    writes: recorder.writes,
  };
}

/** A direct-protocol publish of one graph-scoped Knowledge Asset. */
export async function graphScopedPublish(
  api: PeerWritePublisherApi,
  store: TripleStore,
  variant: PeerWritePayload,
): Promise<PeerWriteOutcome> {
  const contextGraphId = uniqueContextGraph();
  const chainId = 'otp:20430';
  const kaNumber = 7n;
  const ual = `did:dkg:${chainId}/${PUBLISHER}/${kaNumber}`;
  const kaId = (BigInt(PUBLISHER) << 96n) | kaNumber;
  const vmGraph = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(ual, 1),
  );
  await new GraphManager(store).ensureContextGraph(contextGraphId);
  const before = await store.countQuads();
  const recorder = recordStoreWrites(store);
  const handler = new api.PublishHandler(recorder.store, new TypedEventBus());
  const ack = decodePublishAck(await handler.handler(encodePublishRequest({
    ual,
    nquads: utf8(nquadOf(payload(variant, 'urn:asset:subject', 'urn:asset:predicate'), vmGraph)),
    contextGraphId,
    kas: [],
    publisherIdentity: new Uint8Array(32),
    publisherAddress: PUBLISHER,
    startKAId: kaId,
    endKAId: kaId,
    chainId,
    publisherSignatureR: new Uint8Array(0),
    publisherSignatureVs: new Uint8Array(0),
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    accessPolicy: 'public',
    allowedPeers: [],
  }), PEER as never));
  return {
    accepted: ack.accepted,
    targetQuads: await store.countQuads(vmGraph),
    before,
    after: await store.countQuads(),
    writes: recorder.writes,
  };
}

/** A chain-verified KA update gossip message in the legacy (manifest) envelope. */
export async function legacyUpdate(
  api: PeerWritePublisherApi,
  store: TripleStore,
  variant: PeerWritePayload,
): Promise<PeerWriteOutcome> {
  const contextGraphId = uniqueContextGraph();
  const batchId = 77n;
  const written = payload(variant, `urn:term-validation:${randomUUID()}`, SCHEMA_DESCRIPTION);
  const root = written.subject;
  const labelGraph = contextGraphDataUri(contextGraphId);
  const vmGraph = contextGraphLayerUri(
    contextGraphId,
    MemoryLayer.VerifiableMemory,
    '0x' + (batchId >> 96n).toString(16).padStart(40, '0'),
    batchId & ((1n << 96n) - 1n),
  );
  const text = [
    nquad(root, SCHEMA_NAME, '"kept"', labelGraph),
    nquad(root, written.predicate, written.object, labelGraph),
  ].join('\n');
  const merkleRoot = api.computeFlatKCRootV10(api.parseSimpleNQuads(text), []);
  const chain = {
    chainId: 'mock:31337',
    verifyKAUpdate: async () => ({ verified: true, onChainMerkleRoot: merkleRoot, blockNumber: 250, txIndex: 1 }),
    getDKGKnowledgeAssetsAddress: async () => '0x2222222222222222222222222222222222222222',
  } as unknown as ChainAdapter;
  await new GraphManager(store).ensureContextGraph(contextGraphId);
  const before = await store.countQuads();
  const recorder = recordStoreWrites(store);
  const handler = new api.UpdateHandler(recorder.store, chain, new TypedEventBus());
  await handler.handle(encodeKAUpdateRequest({
    contextGraphId,
    batchId,
    nquads: utf8(text),
    manifest: [{ rootEntity: root, privateTripleCount: 0 }],
    publisherPeerId: PEER.toString(),
    publisherAddress: PUBLISHER,
    txHash: `0x${'ab'.repeat(32)}`,
    blockNumber: 250n,
    newMerkleRoot: merkleRoot,
    timestampMs: BigInt(Date.now()),
  }), PEER.toString());
  const targetQuads = await store.countQuads(vmGraph);
  return { accepted: targetQuads > 0, targetQuads, before, after: await store.countQuads(), writes: recorder.writes };
}

/** A chain-verified graph-scoped KA update gossip message for an already-synced asset. */
export async function graphScopedUpdate(
  api: PeerWritePublisherApi,
  store: TripleStore,
  variant: PeerWritePayload,
): Promise<PeerWriteOutcome> {
  const contextGraphId = uniqueContextGraph();
  const chainId = 'otp:20430';
  const ual = `did:dkg:${chainId}/${PUBLISHER}/7`;
  const kaId = (BigInt(PUBLISHER) << 96n) | 7n;
  const metaGraph = contextGraphMetaUri(contextGraphId);
  const vmGraph = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(ual, '2'),
  );
  const dkg = 'http://dkg.io/ontology/';
  const xsdInteger = 'http://www.w3.org/2001/XMLSchema#integer';
  const graphManager = new GraphManager(store);
  await graphManager.ensureContextGraph(contextGraphId);
  await store.insert([
    { subject: ual, predicate: `${dkg}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${xsdInteger}>`, graph: metaGraph },
    { subject: ual, predicate: `${dkg}assertionVersion`, object: `"1"^^<${xsdInteger}>`, graph: metaGraph },
    { subject: ual, predicate: `${dkg}accessPolicy`, object: '"public"', graph: metaGraph },
    { subject: ual, predicate: `${dkg}publisherPeerId`, object: '"original-peer"', graph: metaGraph },
  ]);
  const text = nquadOf(payload(variant, 'urn:asset:subject', 'urn:asset:predicate'), vmGraph);
  const merkleRoot = api.computeFlatKCRootV10(
    api.parseSimpleNQuads(text).map((quad) => ({ ...quad, graph: '' })),
    [],
  );
  const chain = {
    chainId,
    verifyKAUpdate: async () => ({
      verified: true,
      onChainMerkleRoot: merkleRoot,
      blockNumber: 20,
      txIndex: 3,
      merkleRootCount: 2n,
    }),
    getKAContextGraphId: async () => 42n,
  } as unknown as ChainAdapter;
  const before = await store.countQuads();
  const recorder = recordStoreWrites(store);
  const handler = new api.UpdateHandler(recorder.store, chain, new TypedEventBus(), {
    knownBatchContextGraphs: new Map([[kaId.toString(), contextGraphId]]),
    resolveOnChainCgId: async (name) => name === contextGraphId ? '42' : null,
  });
  await handler.handle(encodeKAUpdateRequest({
    contextGraphId,
    batchId: kaId,
    nquads: utf8(text),
    manifest: [],
    publisherPeerId: PEER.toString(),
    publisherAddress: PUBLISHER,
    txHash: `0x${'ab'.repeat(32)}`,
    blockNumber: 20,
    newMerkleRoot: merkleRoot,
    timestampMs: Date.now(),
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: ual,
    assertionVersion: '2',
    publicTripleCount: 1,
    privateTripleCount: 0,
  }), PEER.toString());
  const targetQuads = await store.countQuads(vmGraph);
  return { accepted: targetQuads > 0, targetQuads, before, after: await store.countQuads(), writes: recorder.writes };
}

const SCENARIOS = [
  { name: 'direct publish, manifest envelope', run: legacyPublish, controlQuads: 2 },
  { name: 'direct publish, graph-scoped envelope', run: graphScopedPublish, controlQuads: 1 },
  { name: 'KA update gossip, manifest envelope', run: legacyUpdate, controlQuads: 2 },
  { name: 'KA update gossip, graph-scoped envelope', run: graphScopedUpdate, controlQuads: 1 },
] as const;

/** Declares one suite per scenario against the stores `factory` opens. */
export function describePeerWriteTermValidation(
  factory: PeerWriteStoreFactory,
  api: PeerWritePublisherApi,
): void {
  describe(`peer write term validation on ${factory.name}`, () => {
    for (const scenario of SCENARIOS) {
      describe(scenario.name, () => {
        it('stores a well-formed write (control)', async () => {
          const { store, dispose } = await factory.open();
          try {
            const outcome = await scenario.run(api, store, WELL_FORMED);
            expect(outcome.accepted).toBe(true);
            expect(outcome.targetQuads).toBe(scenario.controlQuads);
          } finally {
            await dispose();
          }
        });

        it.each(MALFORMED_OBJECT_TERMS)('refuses $label and writes nothing', async ({ term, marker }) => {
          const { store, dispose } = await factory.open();
          try {
            const outcome = await scenario.run(api, store, term);
            expect(outcome.accepted).toBe(false);
            expect(outcome.targetQuads).toBe(0);
            expect(outcome.writes.filter((write) => write.includes(marker))).toEqual([]);
            expect(outcome.after).toBe(outcome.before);
          } finally {
            await dispose();
          }
        });
      });
    }
  });
}

/**
 * Protocol metadata a peer's write may not carry: a trust-level row, which a
 * node stamps itself, and a subject in a reserved namespace. Each comes with
 * a substring that identifies it in a store call.
 */
export const RECEIVED_PROTOCOL_METADATA = [
  {
    label: 'a trust-level row',
    payload: { predicate: 'http://dkg.io/ontology/trustLevel', object: '"3"^^<http://www.w3.org/2001/XMLSchema#integer>' },
    marker: 'ontology/trustLevel',
  },
  {
    label: 'a subject in a reserved namespace',
    payload: { subject: 'urn:dkg:file:peer-write', object: '"refused value"' },
    marker: 'urn:dkg:file:peer-write',
  },
] as const;

/** Declares one suite per scenario: each refuses protocol metadata and writes nothing. */
export function describePeerWriteProtocolMetadata(
  factory: PeerWriteStoreFactory,
  api: PeerWritePublisherApi,
): void {
  describe(`peer write protocol metadata on ${factory.name}`, () => {
    for (const scenario of SCENARIOS) {
      describe(scenario.name, () => {
        it.each(RECEIVED_PROTOCOL_METADATA)('refuses $label and writes nothing', async ({ payload, marker }) => {
          const { store, dispose } = await factory.open();
          try {
            const outcome = await scenario.run(api, store, payload);
            expect(outcome.accepted).toBe(false);
            expect(outcome.targetQuads).toBe(0);
            expect(outcome.writes.filter((write) => write.includes(marker))).toEqual([]);
            expect(outcome.after).toBe(outcome.before);
          } finally {
            await dispose();
          }
        });
      });
    }
  });
}

