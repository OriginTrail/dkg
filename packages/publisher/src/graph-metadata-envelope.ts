// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '@origintrail-official/dkg-storage';
import { GRAPH_KA_CONTENT_SCOPE_VERSION, MemoryLayer, createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri, assertSafeIri, validateSubGraphName } from '@origintrail-official/dkg-core';
const DKG = 'http://dkg.io/ontology/';

export interface ConfirmedGraphKnowledgeAssetMetadataEnvelope {
  assertionVersion: string;
  publicTripleCount: number;
  privateTripleCount: number;
  privateMerkleRoot?: Uint8Array;
  assertionGraph: string;
  subGraphName?: string;
  merkleRoot: Uint8Array;
  /** Present for receipt-backed finalization; absent for locally chain-authenticated sync. */
  transactionHash?: string;
  batchId: bigint;
}

export type ConfirmedGraphKnowledgeAssetMetadataRead =
  | { state: 'absent' }
  | { state: 'invalid' }
  | { state: 'confirmed'; envelope: ConfirmedGraphKnowledgeAssetMetadataEnvelope };


export function rdfLiteralLexicalValue(value: string): string | undefined {
  const match = /^("(?:\\.|[^"\\])*")/.exec(value);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}


function metadataObjectsByPredicate(
  rows: ReadonlyArray<{ predicate: string; object: string }>,
): Map<string, string[]> {
  const objects = new Map<string, string[]>();
  for (const row of rows) {
    const values = objects.get(row.predicate) ?? [];
    values.push(row.object);
    objects.set(row.predicate, values);
  }
  return objects;
}


function singleMetadataObject(
  objects: Map<string, string[]>,
  predicate: string,
): string | undefined {
  const values = objects.get(predicate) ?? [];
  return values.length === 1 ? values[0] : undefined;
}

function unsignedIntegerLiteral(value: string | undefined): bigint | undefined {
  const lexical = value === undefined ? undefined : rdfLiteralLexicalValue(value);
  if (lexical === undefined || !/^(0|[1-9]\d*)$/.test(lexical)) return undefined;
  try {
    return BigInt(lexical);
  } catch {
    return undefined;
  }
}

/** Canonical projection for bounded readers of the confirmed envelope below. */
export const GRAPH_KNOWLEDGE_ASSET_ENVELOPE_PREDICATES: readonly string[] = Object.freeze([
  'contentScopeVersion', 'assertionVersion', 'publicTripleCount', 'privateTripleCount', 'batchId',
  'merkleRoot', 'privateMerkleRoot', 'assertionGraph', 'kaUal', 'status', 'transactionHash', 'subGraphName',
].map(name => `${DKG}${name}`));

/** Confirmed-only consumers retain their chain-provenance requirement. */
export function parseConfirmedGraphKnowledgeAssetMetadataEnvelope(
  rows: readonly Pick<Quad, 'predicate' | 'object'>[],
  input: { contextGraphId: string; ual: string },
): ConfirmedGraphKnowledgeAssetMetadataRead {
  const parsed = parseGraphKnowledgeAssetMetadataEnvelope(rows, input);
  return parsed.state === 'tentative' ? { state: 'invalid' } : parsed;
}

export type GraphKnowledgeAssetMetadataRead = ConfirmedGraphKnowledgeAssetMetadataRead
  | { state: 'tentative'; envelope: Omit<ConfirmedGraphKnowledgeAssetMetadataEnvelope, 'batchId'> & { batchId?: bigint } };

/** Structural model shared by wire descriptors and locally stored envelopes. */
export interface GraphKnowledgeAssetStructure {
  ual: string;
  contextGraphId: string;
  contentScopeVersion: string;
  assertionVersion: string;
  publicTripleCount: number;
  privateTripleCount: number;
  privateMerkleRoot?: Uint8Array;
  assertionGraph: string;
  subGraphName?: string;
  merkleRoot: Uint8Array;
}

type MetadataRow = Pick<Quad, 'predicate' | 'object'> & Partial<Pick<Quad, 'graph'>>;
export interface GraphKnowledgeAssetStructurePolicy {
  /** Wire descriptors historically deduplicate lexical values; stored envelopes require exact RDF literals. */
  syntax: 'wire' | 'stored';
  /** Required admission verifies the context row, metadata graph and absence of legacy root bindings. */
  context: 'required' | 'external';
}

/** Decode structural fields once. Confirmation/provenance remains a separate policy below. */
export function parseGraphKnowledgeAssetStructure(
  rows: readonly MetadataRow[],
  input: { ual: string; contextGraphId?: string },
  policy: GraphKnowledgeAssetStructurePolicy,
): GraphKnowledgeAssetStructure {
  const wire = policy.syntax === 'wire';
  const strip = (raw: string) => raw.replace(/^"(.*)"(?:\^\^.*|@.*)?$/, '$1');
  const objects = metadataObjectsByPredicate(rows);
  const values = (field: string) => {
    const raw = objects.get(`${DKG}${field}`) ?? [];
    return wire ? [...new Set(raw.map(strip))] : raw;
  };
  const single = (field: string, optional = false): string | undefined => {
    const found = values(field);
    if (found.length > 1 || (!optional && found.length === 0)) {
      throw new Error(`${found.length ? 'ambiguous' : 'missing'} ${field} metadata`);
    }
    return found[0];
  };
  const literal = (raw: string | undefined) => raw === undefined ? undefined : wire ? raw : rdfLiteralLexicalValue(raw);
  const integer = (field: string): bigint => {
    const raw = literal(single(field));
    if (raw === undefined || !(wire ? /^-?\d+$/ : /^(0|[1-9]\d*)$/).test(raw)) throw new Error(`invalid ${field}: ${raw}`);
    return BigInt(raw);
  };
  const root = (raw: string, field: string): Uint8Array => {
    // Wire roots historically strip a second literal wrapper after distinctObjects.
    const hex = (wire ? strip(raw) : literal(raw))?.replace(/^0x/i, '');
    if (hex === undefined || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${field} must be exactly 32 bytes of hexadecimal data`);
    return Uint8Array.from(hex.match(/.{2}/g)!.map(pair => Number.parseInt(pair, 16)));
  };
  const metadataUal = single('kaUal');
  if (metadataUal !== input.ual) throw new Error(`kaUal mismatch: found ${metadataUal}`);
  const contentScopeVersion = integer('contentScopeVersion');
  if (!wire && contentScopeVersion !== BigInt(GRAPH_KA_CONTENT_SCOPE_VERSION)) throw new Error('invalid contentScopeVersion');
  const assertionVersion = integer('assertionVersion');
  const scope = createGraphKnowledgeAssetScope(input.ual, assertionVersion);
  if (policy.context === 'required' && scope.ual !== input.ual) throw new Error(`non-canonical kaUal: expected ${scope.ual}`);
  let contextGraphId = input.contextGraphId;
  if (policy.context === 'required') {
    const contextGraph = single('contextGraph')!;
    const prefix = 'did:dkg:context-graph:';
    if (!contextGraph.startsWith(prefix)) throw new Error(`invalid contextGraph metadata: ${contextGraph}`);
    const found = contextGraph.slice(prefix.length);
    if (!found) throw new Error('empty context graph id');
    if (contextGraphId !== undefined && found !== contextGraphId) throw new Error('contextGraph mismatch');
    contextGraphId = found;
    for (const row of rows) {
      if (row.graph !== `${contextGraph}/_meta`) throw new Error(`metadata graph mismatch: expected ${contextGraph}/_meta, found ${row.graph}`);
      if (row.predicate === `${DKG}rootEntity` || row.predicate === `${DKG}partOf`) throw new Error('graph-scoped KA metadata must not contain legacy root bindings');
    }
  }
  if (contextGraphId === undefined) throw new Error('missing context graph id');
  const subGraphRaw = single('subGraphName', true);
  const subGraphName = wire && subGraphRaw !== undefined ? strip(subGraphRaw) : literal(subGraphRaw);
  if (subGraphRaw !== undefined && subGraphName === undefined) throw new Error('invalid subGraphName');
  if (subGraphName !== undefined) {
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`invalid subGraphName: ${validation.reason}`);
  }
  const assertionGraph = single('assertionGraph')!;
  if (!wire) assertSafeIri(assertionGraph);
  const expectedGraph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory, scope, subGraphName);
  if (assertionGraph !== expectedGraph) throw new Error(`assertionGraph mismatch: expected ${expectedGraph}, found ${assertionGraph}`);
  const count = (field: string) => {
    const value = integer(field);
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`invalid ${field}: ${value}`);
    return Number(value);
  };
  const publicTripleCount = count('publicTripleCount');
  const privateTripleCount = count('privateTripleCount');
  if (publicTripleCount === 0 && privateTripleCount === 0) throw new Error('empty graph-scoped asset');
  const privateRaw = single('privateMerkleRoot', true);
  if (privateTripleCount > 0 && privateRaw === undefined) throw new Error('missing privateMerkleRoot metadata');
  if (privateTripleCount === 0 && privateRaw !== undefined) throw new Error('privateMerkleRoot present without private content');
  return {
    ual: input.ual, contextGraphId, contentScopeVersion: contentScopeVersion.toString(),
    assertionVersion: assertionVersion.toString(), publicTripleCount, privateTripleCount,
    ...(privateRaw === undefined ? {} : { privateMerkleRoot: root(privateRaw, 'privateMerkleRoot') }),
    assertionGraph, ...(subGraphName === undefined ? {} : { subGraphName }),
    merkleRoot: root(single('merkleRoot')!, 'merkleRoot'),
  };
}

/** Parse the exact envelope, preserving tentative status for explicit no-chain consumers. */
export function parseGraphKnowledgeAssetMetadataEnvelope(
  rows: readonly MetadataRow[],
  input: { contextGraphId: string; ual: string },
  admission: 'external-context' | 'stored-context' = 'external-context',
): GraphKnowledgeAssetMetadataRead {
  const objects = metadataObjectsByPredicate(rows);
  if ((objects.get(`${DKG}contentScopeVersion`) ?? []).length === 0) return { state: 'absent' };
  let structure: GraphKnowledgeAssetStructure;
  try {
    structure = parseGraphKnowledgeAssetStructure(rows, input,
      { syntax: 'stored', context: admission === 'stored-context' ? 'required' : 'external' });
  } catch { return { state: 'invalid' }; }
  const batchId = unsignedIntegerLiteral(singleMetadataObject(objects, `${DKG}batchId`));
  const status = rdfLiteralLexicalValue(singleMetadataObject(objects, `${DKG}status`) ?? '');
  const transactionHashValues = objects.get(`${DKG}transactionHash`) ?? [];
  const transactionHash = transactionHashValues.length === 1
    ? rdfLiteralLexicalValue(transactionHashValues[0])?.trim() : undefined;
  if ((status !== 'confirmed' && status !== 'tentative')
    || (status === 'confirmed' && batchId === undefined)
    || ((objects.get(`${DKG}batchId`) ?? []).length > 0 && batchId === undefined)
    || transactionHashValues.length > 1
    || (transactionHashValues.length === 1 && (transactionHash === undefined || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)))) {
    return { state: 'invalid' };
  }
  // Preserve the public envelope shape; wire-only routing/version fields stay in the normalized structure.
  const { ual: _ual, contextGraphId: _context, contentScopeVersion: _scopeVersion, ...fields } = structure;
  const envelope = { ...fields, ...(transactionHash ? { transactionHash } : {}) };
  return status === 'confirmed'
    ? { state: 'confirmed', envelope: { ...envelope, batchId: batchId! } }
    : { state: 'tentative', envelope: { ...envelope, ...(batchId === undefined ? {} : { batchId }) } };
}
