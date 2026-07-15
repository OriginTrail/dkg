import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10 as computeStructuredKCRoot,
  skolemizeByEntity,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { appendInPlace } from './append-in-place.js';

const DKG_NS = 'http://dkg.io/ontology/';
const MERKLE_ROOT = `${DKG_NS}merkleRoot`;
const CONTENT_SCOPE_VERSION = `${DKG_NS}contentScopeVersion`;
const KA_UAL = `${DKG_NS}kaUal`;
const ASSERTION_VERSION = `${DKG_NS}assertionVersion`;
const ASSERTION_GRAPH = `${DKG_NS}assertionGraph`;
const CONTEXT_GRAPH = `${DKG_NS}contextGraph`;
const PUBLIC_TRIPLE_COUNT = `${DKG_NS}publicTripleCount`;
const PRIVATE_TRIPLE_COUNT = `${DKG_NS}privateTripleCount`;
const PRIVATE_MERKLE_ROOT = `${DKG_NS}privateMerkleRoot`;
const SUB_GRAPH_NAME = `${DKG_NS}subGraphName`;
const ROOT_ENTITY = `${DKG_NS}rootEntity`;
const PART_OF = `${DKG_NS}partOf`;
const SKOLEM_SUFFIX = '/.well-known/genid/';

/**
 * Predicates that make a durable metadata record part of a KA integrity
 * envelope. Keep this list beside the verifier that interprets the envelope:
 * changelog cursor planning must fail closed when any one of these fields is
 * present, even when a malformed record is missing its Merkle root.
 */
const DURABLE_INTEGRITY_META_PREDICATES: ReadonlySet<string> = new Set([
  MERKLE_ROOT,
  CONTENT_SCOPE_VERSION,
  KA_UAL,
  ASSERTION_VERSION,
  ASSERTION_GRAPH,
  PUBLIC_TRIPLE_COUNT,
  PRIVATE_TRIPLE_COUNT,
  PRIVATE_MERKLE_ROOT,
]);

export interface DurableMetaGraphClassification {
  hasMerkleRoot: boolean;
  hasIntegrityEnvelope: boolean;
}

/** Classify a parsed durable metadata record using the verifier's predicates. */
export function classifyDurableMetaGraph(
  quads: readonly Quad[],
): DurableMetaGraphClassification {
  let hasMerkleRoot = false;
  let hasIntegrityEnvelope = false;
  for (const quad of quads) {
    if (quad.predicate === MERKLE_ROOT) hasMerkleRoot = true;
    if (DURABLE_INTEGRITY_META_PREDICATES.has(quad.predicate)) {
      hasIntegrityEnvelope = true;
    }
    if (hasMerkleRoot && hasIntegrityEnvelope) break;
  }
  return { hasMerkleRoot, hasIntegrityEnvelope };
}

export interface DurableIntegrityLogEntry {
  level: 'debug' | 'warn';
  message: string;
}

export interface DurableIntegritySelection {
  dataIndexes: number[];
  metaIndexes: number[];
  rejected: number;
  /** Verified V2 assets whose exact public assertion graph is intentionally empty. */
  verifiedZeroPublicAssets: number;
  logs: DurableIntegrityLogEntry[];
}

interface GraphScopedDescriptor {
  ual: string;
  assertionGraph: string;
  publicTripleCount: number;
  privateRoot?: Uint8Array;
  claimedRootHex: string;
}

/**
 * Verify one complete durable-sync batch and return indexes into the caller's
 * arrays. V2 assets are selected by their exact UAL-derived VM graph; legacy
 * assets retain the quarantined root-scoped verifier.
 */
export function selectVerifiedDurableSyncQuads(
  dataQuads: readonly Quad[],
  metaQuads: readonly Quad[],
  acceptUnverified = false,
): DurableIntegritySelection {
  const logs: DurableIntegrityLogEntry[] = [];
  if (metaQuads.length === 0) {
    if (!acceptUnverified && dataQuads.length > 0) {
      logs.push({
        level: 'warn',
        message: `Rejecting sync batch: received ${dataQuads.length} data triples but no KA integrity metadata`,
      });
      return {
        dataIndexes: [],
        metaIndexes: [],
        rejected: 1,
        verifiedZeroPublicAssets: 0,
        logs,
      };
    }
    return {
      dataIndexes: allIndexes(dataQuads),
      metaIndexes: [],
      rejected: 0,
      verifiedZeroPublicAssets: 0,
      logs,
    };
  }

  const metaBySubject = new Map<string, Quad[]>();
  const dataIndexesByGraph = new Map<string, number[]>();
  for (const quad of metaQuads) {
    const rows = metaBySubject.get(quad.subject);
    if (rows) rows.push(quad);
    else metaBySubject.set(quad.subject, [quad]);
  }
  for (let index = 0; index < dataQuads.length; index++) {
    const graph = dataQuads[index]!.graph;
    const indexes = dataIndexesByGraph.get(graph);
    if (indexes) indexes.push(index);
    else dataIndexesByGraph.set(graph, [index]);
  }

  const merkleSubjects = new Set<string>();
  const markerSubjects = new Set<string>();
  for (const quad of metaQuads) {
    if (quad.predicate === MERKLE_ROOT) merkleSubjects.add(quad.subject);
    if (quad.predicate === CONTENT_SCOPE_VERSION) markerSubjects.add(quad.subject);
  }

  if (merkleSubjects.size === 0 && markerSubjects.size === 0) {
    if (!acceptUnverified && dataQuads.length > 0) {
      logs.push({
        level: 'warn',
        message: `Rejecting sync batch: received ${dataQuads.length} data triples without a Merkle-bound KA descriptor`,
      });
      return {
        dataIndexes: [],
        metaIndexes: [],
        rejected: 1,
        verifiedZeroPublicAssets: 0,
        logs,
      };
    }
    return {
      dataIndexes: allIndexes(dataQuads),
      metaIndexes: allIndexes(metaQuads),
      rejected: 0,
      verifiedZeroPublicAssets: 0,
      logs,
    };
  }

  const graphDescriptors = new Map<string, GraphScopedDescriptor>();
  const legacyKcUals = new Set<string>();
  const invalidKcUals = new Set<string>();
  let fatalUnscopedFailure = false;

  for (const subject of new Set([...merkleSubjects, ...markerSubjects])) {
    const rows = metaBySubject.get(subject) ?? [];
    const markerValues = distinctObjects(rows, CONTENT_SCOPE_VERSION);
    if (markerValues.length === 0) {
      legacyKcUals.add(subject);
      continue;
    }

    try {
      const versions = [...new Set(markerValues.map((raw) => parseInteger(raw, 'contentScopeVersion').toString()))];
      if (versions.length !== 1) {
        throw new Error('ambiguous contentScopeVersion metadata');
      }
      const version = BigInt(versions[0]!);
      if (version === 1n) {
        legacyKcUals.add(subject);
        continue;
      }
      if (version !== BigInt(GRAPH_KA_CONTENT_SCOPE_VERSION)) {
        throw new Error(`unsupported contentScopeVersion ${version}`);
      }
      if (!merkleSubjects.has(subject)) {
        throw new Error('missing merkleRoot metadata');
      }
      graphDescriptors.set(subject, parseGraphScopedDescriptor(subject, rows));
    } catch (error) {
      invalidKcUals.add(subject);
      fatalUnscopedFailure = true;
      logs.push({
        level: acceptUnverified ? 'debug' : 'warn',
        message: `Invalid graph-scoped KA metadata for ${subject}: ${errorMessage(error)}`,
      });
    }
  }

  // One physical graph is one V2 KA. A second metadata subject claiming the
  // same graph makes ownership ambiguous, so reject the batch rather than let
  // either subject authenticate the other's payload.
  const graphOwners = new Map<string, string>();
  for (const [ual, descriptor] of graphDescriptors) {
    const owner = graphOwners.get(descriptor.assertionGraph);
    if (owner && owner !== ual) {
      invalidKcUals.add(owner);
      invalidKcUals.add(ual);
      graphDescriptors.delete(owner);
      graphDescriptors.delete(ual);
      fatalUnscopedFailure = true;
      logs.push({
        level: acceptUnverified ? 'debug' : 'warn',
        message: `Graph-scoped KA assertion graph ${descriptor.assertionGraph} has multiple owners`,
      });
    } else {
      graphOwners.set(descriptor.assertionGraph, ual);
    }
  }

  const verifiedKcUals = new Set<string>();
  const rejectedKcUals = new Set<string>(invalidKcUals);
  const graphVerification = new Map<string, boolean>();
  let verifiedZeroPublicAssets = 0;

  for (const [ual, descriptor] of graphDescriptors) {
    const indexes = dataIndexesByGraph.get(descriptor.assertionGraph) ?? [];
    const publicQuads = indexes.map((index) => dataQuads[index]!);
    let computedHex: string | undefined;
    if (publicQuads.length === descriptor.publicTripleCount) {
      computedHex = toHex(computeStructuredKCRoot(
        publicQuads,
        descriptor.privateRoot ? [descriptor.privateRoot] : [],
      ));
    } else {
      // A short exact graph may mean that part of the advertised V2 payload
      // arrived under another graph (or that a paged fetch was incomplete).
      // Its ownership is unknowable from RDF subjects, so reject the whole
      // batch instead of letting those quads pass as unrelated data.
      fatalUnscopedFailure = true;
    }
    const verified = computedHex === descriptor.claimedRootHex;
    graphVerification.set(descriptor.assertionGraph, verified);
    if (verified) {
      verifiedKcUals.add(ual);
      if (descriptor.publicTripleCount === 0) verifiedZeroPublicAssets += 1;
      continue;
    }

    rejectedKcUals.add(ual);
    const detail = publicQuads.length !== descriptor.publicTripleCount
      ? `public triple count mismatch: metadata=${descriptor.publicTripleCount}, fetched=${publicQuads.length}`
      : `claimed ${descriptor.claimedRootHex.slice(0, 16)}…, computed ${(computedHex ?? '').slice(0, 16)}…`;
    logs.push({
      level: acceptUnverified ? 'debug' : 'warn',
      message: `Merkle mismatch for graph-scoped KA ${ual}${acceptUnverified ? ' (system context graph, accepted)' : ''}: ${detail}`,
    });
  }

  // Legacy read-only verification. Token rows use partOf; collapsed legacy
  // rows self-map from the merkle-bearing UAL to their rootEntity rows.
  const kaToKc = new Map<string, string>();
  const kaRootEntities = new Map<string, string[]>();
  for (const quad of metaQuads) {
    if (quad.predicate === PART_OF) {
      const kcUal = stripLiteral(quad.object);
      if (legacyKcUals.has(kcUal)) kaToKc.set(quad.subject, kcUal);
    } else if (quad.predicate === ROOT_ENTITY) {
      const roots = kaRootEntities.get(quad.subject);
      const root = stripLiteral(quad.object);
      if (roots) roots.push(root);
      else kaRootEntities.set(quad.subject, [root]);
    }
  }
  for (const kcUal of legacyKcUals) {
    if (kaRootEntities.has(kcUal) && !kaToKc.has(kcUal)) {
      kaToKc.set(kcUal, kcUal);
    }
  }

  const kcRootEntities = new Map<string, string[]>();
  for (const [kaUri, kcUal] of kaToKc) {
    const roots = kaRootEntities.get(kaUri);
    if (!roots) continue;
    let joined = kcRootEntities.get(kcUal);
    if (!joined) {
      joined = [];
      kcRootEntities.set(kcUal, joined);
    }
    for (const root of roots) {
      if (!joined.includes(root)) joined.push(root);
    }
  }

  const rootEntityToKcs = new Map<string, string[]>();
  for (const [kcUal, roots] of kcRootEntities) {
    for (const root of roots) {
      const owners = rootEntityToKcs.get(root);
      if (owners) owners.push(kcUal);
      else rootEntityToKcs.set(root, [kcUal]);
    }
  }
  const overlappingLegacyKcs = new Set<string>();
  for (const owners of rootEntityToKcs.values()) {
    if (owners.length > 1) owners.forEach((owner) => overlappingLegacyKcs.add(owner));
  }

  const partitioned = skolemizeByEntity(dataQuads as Quad[]);
  for (const kcUal of legacyKcUals) {
    if (!merkleSubjects.has(kcUal)) continue;
    const roots = kcRootEntities.get(kcUal) ?? [];
    let claimedRoots: string[];
    try {
      claimedRoots = distinctObjects(metaBySubject.get(kcUal) ?? [], MERKLE_ROOT)
        .map((raw) => normalizeHex32(raw, 'merkleRoot'));
    } catch (error) {
      rejectedKcUals.add(kcUal);
      if (roots.length === 0) fatalUnscopedFailure = true;
      logs.push({
        level: acceptUnverified ? 'debug' : 'warn',
        message: `Unverifiable legacy KA ${kcUal}: ${errorMessage(error)}`,
      });
      continue;
    }
    if (claimedRoots.length !== 1 || roots.length === 0) {
      rejectedKcUals.add(kcUal);
      fatalUnscopedFailure = true;
      logs.push({
        level: acceptUnverified ? 'debug' : 'warn',
        message: `Unverifiable legacy KA ${kcUal}: ${claimedRoots.length !== 1 ? 'ambiguous merkleRoot' : 'missing rootEntity metadata'}`,
      });
      continue;
    }
    if (overlappingLegacyKcs.has(kcUal)) {
      verifiedKcUals.add(kcUal);
      logs.push({
        level: 'debug',
        message: `Skipping legacy Merkle check for ${kcUal}: root entity is shared across versions`,
      });
      continue;
    }

    try {
      const publicQuads: Quad[] = [];
      for (const root of roots) appendInPlace(publicQuads, partitioned.get(root) ?? []);
      const privateRoots: Uint8Array[] = [];
      for (const [kaUri, owner] of kaToKc) {
        if (owner !== kcUal) continue;
        for (const raw of distinctObjects(metaBySubject.get(kaUri) ?? [], PRIVATE_MERKLE_ROOT)) {
          privateRoots.push(hexToBytes(normalizeHex32(raw, 'privateMerkleRoot')));
        }
      }
      const computedHex = toHex(computeStructuredKCRoot(publicQuads, privateRoots));
      if (computedHex === claimedRoots[0]) {
        verifiedKcUals.add(kcUal);
      } else {
        rejectedKcUals.add(kcUal);
        logs.push({
          level: acceptUnverified ? 'debug' : 'warn',
          message: `Merkle mismatch for ${kcUal}${acceptUnverified ? ' (system context graph, accepted)' : ''}: claimed ${claimedRoots[0]!.slice(0, 16)}…, computed ${computedHex.slice(0, 16)}…`,
        });
      }
    } catch (error) {
      rejectedKcUals.add(kcUal);
      logs.push({
        level: acceptUnverified ? 'debug' : 'warn',
        message: `Merkle verification error for ${kcUal}: ${errorMessage(error)}`,
      });
    }
  }

  const rejected = rejectedKcUals.size;
  if (acceptUnverified && rejected > 0) {
    // Preserve the established audit wording consumed by worker/runtime
    // diagnostics while the verifier supports both legacy KCs and V2 KAs.
    logs.push({ level: 'debug', message: `Accepting ${rejected} unverified KC(s) (system context graph)` });
    return {
      dataIndexes: allIndexes(dataQuads),
      metaIndexes: allIndexes(metaQuads),
      rejected: 0,
      verifiedZeroPublicAssets,
      logs,
    };
  }
  if (fatalUnscopedFailure) {
    return { dataIndexes: [], metaIndexes: [], rejected, verifiedZeroPublicAssets, logs };
  }

  const verifiedLegacyRoots = new Set<string>();
  const allLegacyRoots = new Set<string>();
  for (const [kcUal, roots] of kcRootEntities) {
    for (const root of roots) {
      allLegacyRoots.add(root);
      if (verifiedKcUals.has(kcUal)) verifiedLegacyRoots.add(root);
    }
  }

  const dataIndexes: number[] = [];
  for (let index = 0; index < dataQuads.length; index++) {
    const quad = dataQuads[index]!;
    const graphVerified = graphVerification.get(quad.graph);
    if (graphVerified !== undefined) {
      if (graphVerified) dataIndexes.push(index);
      continue;
    }
    const legacyOwner = findLegacyRootOwner(quad.subject, allLegacyRoots);
    if (!legacyOwner || verifiedLegacyRoots.has(legacyOwner)) dataIndexes.push(index);
  }

  const metaIndexes: number[] = [];
  for (let index = 0; index < metaQuads.length; index++) {
    const quad = metaQuads[index]!;
    if (merkleSubjects.has(quad.subject) || markerSubjects.has(quad.subject)) {
      if (verifiedKcUals.has(quad.subject)) metaIndexes.push(index);
      continue;
    }
    const owner = kaToKc.get(quad.subject);
    if (!owner || verifiedKcUals.has(owner)) metaIndexes.push(index);
  }

  return { dataIndexes, metaIndexes, rejected, verifiedZeroPublicAssets, logs };
}

function parseGraphScopedDescriptor(ual: string, rows: readonly Quad[]): GraphScopedDescriptor {
  const requireSingle = (predicate: string, field: string): string => {
    const values = distinctObjects(rows, predicate);
    if (values.length !== 1) {
      throw new Error(`${values.length === 0 ? 'missing' : 'ambiguous'} ${field} metadata`);
    }
    return values[0]!;
  };
  const optionalSingle = (predicate: string, field: string): string | undefined => {
    const values = distinctObjects(rows, predicate);
    if (values.length > 1) throw new Error(`ambiguous ${field} metadata`);
    return values[0];
  };

  const metadataUal = requireSingle(KA_UAL, 'kaUal');
  if (metadataUal !== ual) throw new Error(`kaUal mismatch: found ${metadataUal}`);
  const assertionVersion = parseInteger(
    requireSingle(ASSERTION_VERSION, 'assertionVersion'),
    'assertionVersion',
  );
  const scope = createGraphKnowledgeAssetScope(ual, assertionVersion);
  if (scope.ual !== ual) throw new Error(`non-canonical kaUal: expected ${scope.ual}`);

  const contextGraphUri = requireSingle(CONTEXT_GRAPH, 'contextGraph');
  const contextGraphPrefix = 'did:dkg:context-graph:';
  if (!contextGraphUri.startsWith(contextGraphPrefix)) {
    throw new Error(`invalid contextGraph metadata: ${contextGraphUri}`);
  }
  const contextGraphId = contextGraphUri.slice(contextGraphPrefix.length);
  if (!contextGraphId) throw new Error('empty context graph id');
  const expectedMetaGraph = `${contextGraphUri}/_meta`;
  for (const row of rows) {
    if (row.graph !== expectedMetaGraph) {
      throw new Error(`metadata graph mismatch: expected ${expectedMetaGraph}, found ${row.graph}`);
    }
    if (row.predicate === ROOT_ENTITY || row.predicate === PART_OF) {
      throw new Error('graph-scoped KA metadata must not contain legacy root bindings');
    }
  }

  const subGraphRaw = optionalSingle(SUB_GRAPH_NAME, 'subGraphName');
  const subGraphName = subGraphRaw === undefined ? undefined : stripLiteral(subGraphRaw);
  if (subGraphName !== undefined) {
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`invalid subGraphName: ${validation.reason}`);
  }

  const expectedAssertionGraph = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.VerifiableMemory,
    scope,
    subGraphName,
  );
  const assertionGraph = requireSingle(ASSERTION_GRAPH, 'assertionGraph');
  if (assertionGraph !== expectedAssertionGraph) {
    throw new Error(`assertionGraph mismatch: expected ${expectedAssertionGraph}, found ${assertionGraph}`);
  }

  const publicTripleCount = safeCount(
    requireSingle(PUBLIC_TRIPLE_COUNT, 'publicTripleCount'),
    'publicTripleCount',
  );
  const privateTripleCount = safeCount(
    requireSingle(PRIVATE_TRIPLE_COUNT, 'privateTripleCount'),
    'privateTripleCount',
  );
  if (publicTripleCount === 0 && privateTripleCount === 0) {
    throw new Error('empty graph-scoped asset');
  }
  const privateRootValues = distinctObjects(rows, PRIVATE_MERKLE_ROOT);
  if (privateTripleCount > 0 && privateRootValues.length !== 1) {
    throw new Error(`${privateRootValues.length === 0 ? 'missing' : 'ambiguous'} privateMerkleRoot metadata`);
  }
  if (privateTripleCount === 0 && privateRootValues.length > 0) {
    throw new Error('privateMerkleRoot present without private content');
  }

  return {
    ual,
    assertionGraph,
    publicTripleCount,
    privateRoot: privateRootValues[0]
      ? hexToBytes(normalizeHex32(privateRootValues[0], 'privateMerkleRoot'))
      : undefined,
    claimedRootHex: normalizeHex32(requireSingle(MERKLE_ROOT, 'merkleRoot'), 'merkleRoot'),
  };
}

function distinctObjects(rows: readonly Quad[], predicate: string): string[] {
  return [...new Set(rows.filter((quad) => quad.predicate === predicate).map((quad) => stripLiteral(quad.object)))];
}

function parseInteger(raw: string, field: string): bigint {
  if (!/^-?\d+$/.test(raw)) throw new Error(`invalid ${field}: ${raw}`);
  return BigInt(raw);
}

function safeCount(raw: string, field: string): number {
  const value = parseInteger(raw, field);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`invalid ${field}: ${value}`);
  }
  return Number(value);
}

function normalizeHex32(raw: string, field: string): string {
  const hex = stripLiteral(raw).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${field} must be exactly 32 bytes of hexadecimal data`);
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
}

function stripLiteral(raw: string): string {
  const match = raw.match(/^"(.*)"(?:\^\^.*|@.*)?$/);
  return match ? match[1]! : raw;
}

function findLegacyRootOwner(subject: string, roots: ReadonlySet<string>): string | undefined {
  for (const root of roots) {
    if (subject === root || subject.startsWith(`${root}${SKOLEM_SUFFIX}`)) return root;
  }
  return undefined;
}

function allIndexes(source: readonly unknown[]): number[] {
  return Array.from({ length: source.length }, (_, index) => index);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
