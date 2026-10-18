import { ethers } from 'ethers';
import {
  ASSERTION_SEAL_PREDICATES,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  assertionLifecycleUri,
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  isTrustLevelQuad,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  PrivateContentStore,
  type OxigraphStore,
  type Quad,
} from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  computePrivateRootV10,
  assertNoKnowledgeAssetPayloadNamedGraphs,
  skolemizeKnowledgeAssetParts,
} from '../../src/index.js';
import type { DKGPublisher } from '../../src/dkg-publisher.js';

const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = '<http://www.w3.org/2001/XMLSchema#integer>';
const RESERVED_PREFIXES = ['urn:dkg:file:', 'urn:dkg:extraction:'];

function stripStoredTerm(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const literal = /^"(.*)"(?:\^\^<[^>]+>)?$/.exec(trimmed);
  if (literal) return literal[1];
  const iri = /^<([^>]+)>$/.exec(trimmed);
  return iri?.[1] ?? trimmed;
}

function fixtureNumber(contextGraphId: string, agentAddress: string, name: string): bigint {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(`${contextGraphId}\0${agentAddress}\0${name}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return BigInt((hash >>> 0) + 1);
}

function isProtocolMetadata(quad: Quad): boolean {
  const subject = quad.subject.toLowerCase();
  return RESERVED_PREFIXES.some((prefix) => subject.startsWith(prefix))
    || isTrustLevelQuad(quad);
}

/**
 * Publisher-unit equivalent of agent.assertion.finalize(). It deliberately
 * uses the same canonicalization, exact UAL graph, Merkle construction, seal
 * shape, lifecycle identity, and cleanup order; only the signature bytes are
 * inert because publisher lifecycle tests do not submit this seal on-chain.
 */
export async function finalizeRootlessAssertionForTest(params: {
  publisher: DKGPublisher;
  store: OxigraphStore;
  contextGraphId: string;
  name: string;
  agentAddress: string;
  subGraphName?: string;
  assertionVersion?: string | number | bigint;
}): Promise<{
  kaUal: string;
  assertionVersion: string;
  graphUri: string;
  sharedGraphUri: string;
  publicQuads: Quad[];
  privateQuads: Quad[];
}> {
  const {
    publisher,
    store,
    contextGraphId,
    name,
    subGraphName,
  } = params;
  // Direct publisher tests intentionally exercise callers that have not passed
  // through the agent's checksum normalization. Address lifecycle graphs by the
  // exact value used at assertionCreate, while keeping the signed author and UAL
  // identity canonical.
  const lifecycleAgentAddress = params.agentAddress;
  const authorAddress = ethers.getAddress(params.agentAddress);
  const assertionUri = contextGraphAssertionUri(
    contextGraphId,
    lifecycleAgentAddress,
    name,
    subGraphName,
  );
  const lifecycleUri = assertionLifecycleUri(
    contextGraphId,
    lifecycleAgentAddress,
    name,
    subGraphName,
  );
  const metaGraph = contextGraphMetaUri(contextGraphId);
  const sourceGraphUri = await publisher.wmGraphUri(
    contextGraphId,
    lifecycleAgentAddress,
    name,
    subGraphName,
  );
  const rawPublic = (await publisher.assertionQuery(
    contextGraphId,
    name,
    lifecycleAgentAddress,
    subGraphName,
  )).filter((quad) => !isProtocolMetadata(quad));
  const rawPrivate = (await publisher.assertionQueryPrivate(
    contextGraphId,
    name,
    lifecycleAgentAddress,
    subGraphName,
  )).filter((quad) => !isProtocolMetadata(quad));
  if (rawPublic.length === 0 && rawPrivate.length === 0) {
    throw new Error(`Cannot finalize empty test assertion ${name}`);
  }

  assertNoKnowledgeAssetPayloadNamedGraphs(rawPublic, rawPrivate);

  const normalized = await skolemizeKnowledgeAssetParts(rawPublic, rawPrivate, {
    allowCanonicalSkolemTerms: true,
  });
  const privateMerkleRoot = computePrivateRootV10(normalized.privateQuads);
  const merkleRoot = computeFlatKCRootV10(
    normalized.publicQuads,
    privateMerkleRoot ? [privateMerkleRoot] : [],
  );

  const identity = await store.query(
    `SELECT ?n ?u ?v WHERE { GRAPH <${metaGraph}> { ` +
      `OPTIONAL { <${lifecycleUri}> <${DKG}kaId> ?n } ` +
      `OPTIONAL { <${lifecycleUri}> <${DKG}reservedUal> ?u } ` +
      `OPTIONAL { <${lifecycleUri}> <${DKG}assertionVersion> ?v } } } LIMIT 1`,
  );
  const row = identity.type === 'bindings' ? identity.bindings[0] : undefined;
  const storedNumber = stripStoredTerm(row?.['n']);
  const kaNumber = storedNumber !== undefined
    ? BigInt(storedNumber)
    : fixtureNumber(contextGraphId, lifecycleAgentAddress, name);
  const storedUal = stripStoredTerm(row?.['u']);
  const kaUal = storedUal
    ?? `did:dkg:31337/${authorAddress.toLowerCase()}/${kaNumber}`;
  const assertionVersion = String(
    params.assertionVersion
      ?? stripStoredTerm(row?.['v'])
      ?? '1',
  );
  const scope = createGraphKnowledgeAssetScope(kaUal, assertionVersion);
  const reservedKaId = (BigInt(authorAddress) << 96n) | kaNumber;

  const graphUri = await publisher.materializeCanonicalWorkingMemory(
    contextGraphId,
    scope.ual,
    scope.assertionVersion,
    normalized.publicQuads,
    subGraphName,
  );
  const sharedGraphUri = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.SharedWorkingMemory,
    scope,
    subGraphName,
  );
  const privateStore = new PrivateContentStore(store, new GraphManager(store));
  await privateStore.replaceKnowledgeAssetPrivateTriples(
    contextGraphId,
    scope,
    normalized.privateQuads,
    subGraphName,
  );

  for (const predicate of Object.values(ASSERTION_SEAL_PREDICATES)) {
    await store.deleteByPattern({ graph: metaGraph, subject: assertionUri, predicate });
  }
  const sealQuads = buildAssertionSealQuads({
    assertionUri,
    metaGraph,
    merkleRoot,
    authorAddress,
    authorAttestationR: new Uint8Array(32).fill(1),
    authorAttestationVS: new Uint8Array(32).fill(2),
    authorSchemeVersion: 1,
    chainId: 31337n,
    kav10Address: '0x0000000000000000000000000000000000000001',
    reservedKaId,
    finalizedAtIso: new Date(0).toISOString(),
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: scope.ual,
    assertionVersion: scope.assertionVersion,
    publicTripleCount: normalized.publicQuads.length,
    ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
    privateTripleCount: normalized.privateQuads.length,
  });
  const merkleHex = ethers.hexlify(merkleRoot).slice(2);
  await store.deleteByPattern({
    graph: metaGraph,
    subject: lifecycleUri,
    predicate: ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION,
  });
  await store.insert([
    ...sealQuads,
    {
      subject: lifecycleUri,
      predicate: `${DKG}kaId`,
      object: `"${kaNumber}"^^${XSD_INTEGER}`,
      graph: metaGraph,
    },
    {
      subject: lifecycleUri,
      predicate: `${DKG}reservedUal`,
      object: `"${scope.ual}"`,
      graph: metaGraph,
    },
    {
      subject: lifecycleUri,
      predicate: ASSERTION_SEAL_PREDICATES.CONTENT_SCOPE_VERSION,
      object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^${XSD_INTEGER}`,
      graph: metaGraph,
    },
    {
      subject: lifecycleUri,
      predicate: ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION,
      object: `"${scope.assertionVersion}"^^${XSD_INTEGER}`,
      graph: metaGraph,
    },
    {
      subject: lifecycleUri,
      predicate: `${DKG}wmCurrentAssertion`,
      object: `"${merkleHex}"`,
      graph: metaGraph,
    },
  ]);
  await publisher.cleanupCanonicalWorkingMemorySources(
    contextGraphId,
    name,
    lifecycleAgentAddress,
    graphUri,
    [sourceGraphUri],
    subGraphName,
  );
  await privateStore.deleteKnowledgeAssetPrivateDraft(
    contextGraphId,
    lifecycleAgentAddress,
    name,
    subGraphName,
  );

  return {
    kaUal: scope.ual,
    assertionVersion: scope.assertionVersion,
    graphUri,
    sharedGraphUri,
    publicQuads: normalized.publicQuads,
    privateQuads: normalized.privateQuads,
  };
}
