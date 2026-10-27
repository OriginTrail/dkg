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
  /** Wire descriptors deduplicate lexical values; stored envelopes require exact RDF literals. */
  syntax: 'wire' | 'stored';
  /** Required admission verifies routing and rejects legacy root bindings. */
  context: 'required' | 'external';
}

/** Decoding is complete before context admission or common structural validation. */
interface DecodedGraphFields {
  ual: string;
  contentScopeVersion: bigint;
  assertionVersion: bigint;
  publicTripleCount: bigint;
  privateTripleCount: bigint;
  privateMerkleRoot?: Uint8Array;
  merkleRoot: Uint8Array;
  assertionGraph: string;
  subGraphName?: string;
}
interface MetadataFields {
  required(field: string): string;
  optional(field: string): string | undefined;
  integer(value: string, field: string): bigint;
  root(value: string, field: string): Uint8Array;
  literal(value: string): string;
}

function selectMetadataFields(objects: Map<string, string[]>): Pick<MetadataFields, 'required' | 'optional'> {
  const optional = (field: string): string | undefined => {
    const values = objects.get(`${DKG}${field}`) ?? [];
    if (values.length > 1) throw new Error(`ambiguous ${field} metadata`);
    return values[0];
  };
  return { optional, required: field => {
    const value = optional(field);
    if (value === undefined) throw new Error(`missing ${field} metadata`);
    return value;
  } };
}
function decodeInteger(raw: string, field: string, syntax: RegExp): bigint {
  if (!syntax.test(raw)) throw new Error(`invalid ${field}: ${raw}`);
  return BigInt(raw);
}
function decodeRoot(raw: string, field: string): Uint8Array {
  const hex = raw.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${field} must be exactly 32 bytes of hexadecimal data`);
  return Uint8Array.from(hex.match(/.{2}/g)!.map(pair => Number.parseInt(pair, 16)));
}
function decodeGraphFields(fields: MetadataFields): DecodedGraphFields {
  const privateRoot = fields.optional('privateMerkleRoot');
  const subGraph = fields.optional('subGraphName');
  return {
    ual: fields.required('kaUal'),
    contentScopeVersion: fields.integer(fields.required('contentScopeVersion'), 'contentScopeVersion'),
    assertionVersion: fields.integer(fields.required('assertionVersion'), 'assertionVersion'),
    publicTripleCount: fields.integer(fields.required('publicTripleCount'), 'publicTripleCount'),
    privateTripleCount: fields.integer(fields.required('privateTripleCount'), 'privateTripleCount'),
    merkleRoot: fields.root(fields.required('merkleRoot'), 'merkleRoot'),
    ...(privateRoot === undefined ? {} : { privateMerkleRoot: fields.root(privateRoot, 'privateMerkleRoot') }),
    assertionGraph: fields.required('assertionGraph'),
    ...(subGraph === undefined ? {} : { subGraphName: fields.literal(subGraph) }),
    // Context is admitted separately; unrelated external-context rows retain their old acceptance rules.
  };
}
const stripWireLiteral = (raw: string) => raw.replace(/^"(.*)"(?:\^\^.*|@.*)?$/, '$1');
function decodeWireGraphFields(rows: readonly MetadataRow[]): { fields: DecodedGraphFields; context(): string | undefined } {
  const objects = metadataObjectsByPredicate(rows);
  for (const [predicate, values] of objects) objects.set(predicate, [...new Set(values.map(stripWireLiteral))]);
  const selected = selectMetadataFields(objects);
  return { fields: decodeGraphFields({ ...selected,
    integer: (raw, field) => decodeInteger(raw, field, /^-?\d+$/),
    // Preserve the historical wire decoder's second wrapper strip for roots and subgraph names.
    root: (raw, field) => decodeRoot(stripWireLiteral(raw), field), literal: stripWireLiteral,
  }), context: () => selected.optional('contextGraph') };
}
function decodeStoredGraphFields(rows: readonly MetadataRow[]): { fields: DecodedGraphFields; context(): string | undefined } {
  const selected = selectMetadataFields(metadataObjectsByPredicate(rows));
  const literal = (raw: string): string => {
    const value = rdfLiteralLexicalValue(raw);
    if (value === undefined) throw new Error('invalid RDF literal');
    return value;
  };
  const fields = decodeGraphFields({ ...selected,
    integer: (raw, field) => decodeInteger(literal(raw), field, /^(0|[1-9]\d*)$/),
    root: (raw, field) => decodeRoot(literal(raw), field), literal,
  });
  if (fields.contentScopeVersion !== BigInt(GRAPH_KA_CONTENT_SCOPE_VERSION)) throw new Error('invalid contentScopeVersion');
  assertSafeIri(fields.assertionGraph);
  return { fields, context: () => selected.optional('contextGraph') };
}

function admitGraphMetadataContext(rows: readonly MetadataRow[], contextGraph: string | undefined, expected?: string): string {
  if (contextGraph === undefined) throw new Error('missing contextGraph metadata');
  const prefix = 'did:dkg:context-graph:';
  if (!contextGraph.startsWith(prefix)) throw new Error(`invalid contextGraph metadata: ${contextGraph}`);
  const id = contextGraph.slice(prefix.length);
  if (!id) throw new Error('empty context graph id');
  if (expected !== undefined && id !== expected) throw new Error('contextGraph mismatch');
  for (const row of rows) {
    if (row.graph !== `${contextGraph}/_meta`) throw new Error(`metadata graph mismatch: expected ${contextGraph}/_meta, found ${row.graph}`);
    if (row.predicate === `${DKG}rootEntity` || row.predicate === `${DKG}partOf`) throw new Error('graph-scoped KA metadata must not contain legacy root bindings');
  }
  return id;
}

/** No syntax modes: all fields have one decoded representation here. */
function validateGraphStructure(fields: DecodedGraphFields, ual: string, contextGraphId: string): GraphKnowledgeAssetStructure {
  if (fields.ual !== ual) throw new Error(`kaUal mismatch: found ${fields.ual}`);
  const scope = createGraphKnowledgeAssetScope(ual, fields.assertionVersion);
  if (fields.subGraphName !== undefined) {
    const validation = validateSubGraphName(fields.subGraphName);
    if (!validation.valid) throw new Error(`invalid subGraphName: ${validation.reason}`);
  }
  const expected = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory, scope, fields.subGraphName);
  if (fields.assertionGraph !== expected) throw new Error(`assertionGraph mismatch: expected ${expected}, found ${fields.assertionGraph}`);
  const count = (value: bigint, field: string) => {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`invalid ${field}: ${value}`);
    return Number(value);
  };
  const publicTripleCount = count(fields.publicTripleCount, 'publicTripleCount');
  const privateTripleCount = count(fields.privateTripleCount, 'privateTripleCount');
  if (publicTripleCount === 0 && privateTripleCount === 0) throw new Error('empty graph-scoped asset');
  if (privateTripleCount > 0 && fields.privateMerkleRoot === undefined) throw new Error('missing privateMerkleRoot metadata');
  if (privateTripleCount === 0 && fields.privateMerkleRoot !== undefined) throw new Error('privateMerkleRoot present without private content');
  return { ual: scope.ual, contextGraphId, contentScopeVersion: fields.contentScopeVersion.toString(),
    assertionVersion: fields.assertionVersion.toString(), publicTripleCount, privateTripleCount,
    ...(fields.privateMerkleRoot === undefined ? {} : { privateMerkleRoot: fields.privateMerkleRoot }),
    assertionGraph: fields.assertionGraph, ...(fields.subGraphName === undefined ? {} : { subGraphName: fields.subGraphName }),
    merkleRoot: fields.merkleRoot };
}

/** Boundary decoding, context admission and structural validation have distinct contracts. */
export function parseGraphKnowledgeAssetStructure(
  rows: readonly MetadataRow[], input: { ual: string; contextGraphId?: string },
  policy: GraphKnowledgeAssetStructurePolicy,
): GraphKnowledgeAssetStructure {
  const decoded = policy.syntax === 'wire' ? decodeWireGraphFields(rows) : decodeStoredGraphFields(rows);
  const contextGraphId = policy.context === 'required'
    ? admitGraphMetadataContext(rows, decoded.context(), input.contextGraphId) : input.contextGraphId;
  if (contextGraphId === undefined) throw new Error('missing context graph id');
  const structure = validateGraphStructure(decoded.fields, input.ual, contextGraphId);
  if (policy.context === 'required' && structure.ual !== input.ual) throw new Error(`non-canonical kaUal: expected ${structure.ual}`);
  return structure;
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
