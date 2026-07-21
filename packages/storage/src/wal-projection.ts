import {
  assertSafeIri,
  assertSafeRdfTerm,
} from '@origintrail-official/dkg-core';
import type {
  Quad,
  QueryOptions,
  TripleStore,
} from './triple-store.js';

export const WAL_PROJECTION_MARKER_GRAPH = 'urn:dkg:wal:projection';
export const WAL_PROJECTION_SHADOW_GRAPH_PREFIX = 'urn:dkg:wal:shadow:v1:';
export const WAL_PROJECTION_TRANSACTION_VERSION = 'v1' as const;
export const WAL_PROJECTION_ADAPTER_VERSION_V1 = 1 as const;

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const PREDICATE_PREFIX = 'urn:dkg:wal:projection:v1:';
const PREDICATE = Object.freeze({
  adapterVersion: `${PREDICATE_PREFIX}adapterVersion`,
  namespaceId: `${PREDICATE_PREFIX}namespaceId`,
  logicalKey: `${PREDICATE_PREFIX}logicalKey`,
  activeHeadsDigest: `${PREDICATE_PREFIX}activeHeadsDigest`,
  conflictHeadsDigest: `${PREDICATE_PREFIX}conflictHeadsDigest`,
  stateDigest: `${PREDICATE_PREFIX}stateDigest`,
  sourceVectorId: `${PREDICATE_PREFIX}sourceVectorId`,
  materializationStatus: `${PREDICATE_PREFIX}materializationStatus`,
});
const MARKER_PREDICATE_COUNT = Object.keys(PREDICATE).length;

export type WalProjectionMaterializationStatusV1 =
  | 'APPLIED'
  | 'PENDING'
  | 'BLOCKED';

export interface WalProjectionGraphReplacementV1 {
  readonly graphUri: string;
  readonly quads: readonly Quad[];
}

export interface WalProjectionSubjectReplacementV1 {
  readonly graphUri: string;
  readonly subject: string;
  readonly quads: readonly Quad[];
}

/**
 * Complete storage plan already selected by the shared DKG semantic core.
 * This shape contains persistence instructions only; it carries no operation,
 * winner-selection, authorization, VM, finality, or cryptographic rule.
 */
export interface WalProjectionCommitInputV1 {
  readonly adapterVersion: 1;
  /** CAS for normal replay; REBUILD for an explicit complete local-WAL rebuild. */
  readonly mode: 'CAS' | 'REBUILD';
  readonly namespaceId: Uint8Array;
  readonly logicalKey: Uint8Array;
  readonly expectedActiveHeadsDigest: Uint8Array | null;
  readonly replaceGraphs: readonly WalProjectionGraphReplacementV1[];
  readonly replaceSubjects: readonly WalProjectionSubjectReplacementV1[];
  readonly deleteQuads: readonly Quad[];
  readonly insertQuads: readonly Quad[];
  readonly conflictGraphs: readonly WalProjectionGraphReplacementV1[];
  readonly newActiveHeadsDigest: Uint8Array;
  readonly newConflictHeadsDigest: Uint8Array;
  readonly newStateDigest: Uint8Array;
  readonly sourceVectorId: Uint8Array;
  readonly materializationStatus: WalProjectionMaterializationStatusV1;
}

export interface WalProjectionMarkerV1 {
  readonly adapterVersion: 1;
  readonly namespaceId: Uint8Array;
  readonly logicalKey: Uint8Array;
  readonly activeHeadsDigest: Uint8Array;
  readonly conflictHeadsDigest: Uint8Array;
  readonly stateDigest: Uint8Array;
  readonly sourceVectorId: Uint8Array;
  readonly materializationStatus: WalProjectionMaterializationStatusV1;
}

export type WalProjectionCommitResultV1 =
  | {
      readonly status: 'COMMITTED';
      readonly marker: WalProjectionMarkerV1;
    }
  | {
      readonly status: 'GUARD_FAILED';
      readonly marker: WalProjectionMarkerV1 | null;
    };

export interface WalProjectionCommitPlanV1 {
  readonly update: string;
  readonly marker: WalProjectionMarkerV1;
  readonly markerSubject: string;
  readonly touchedGraphs: readonly string[];
}

export class WalProjectionIntegrityError extends Error {
  readonly code = 'WAL_PROJECTION_INTEGRITY';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WalProjectionIntegrityError';
  }
}

export function isWalProjectionInternalGraph(graphUri: string): boolean {
  return graphUri === WAL_PROJECTION_MARKER_GRAPH
    || graphUri.startsWith(WAL_PROJECTION_SHADOW_GRAPH_PREFIX);
}

export function walProjectionMarkerSubjectV1(
  namespaceId: Uint8Array,
  logicalKey: Uint8Array,
): string {
  return `${WAL_PROJECTION_MARKER_GRAPH}:v1:${hex(fixedBytes(namespaceId, 'namespaceId'))}:${hex(fixedBytes(logicalKey, 'logicalKey'))}`;
}

export function walProjectionShadowGraphV1(
  namespaceId: Uint8Array,
  logicalKey: Uint8Array,
  slot: string,
): string {
  if (typeof slot !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(slot)) {
    throw new WalProjectionIntegrityError(
      'WAL projection graph slot must contain 1..128 URI-unreserved characters',
    );
  }
  return `${WAL_PROJECTION_SHADOW_GRAPH_PREFIX}${hex(fixedBytes(namespaceId, 'namespaceId'))}:${hex(fixedBytes(logicalKey, 'logicalKey'))}:${slot}`;
}

export function walProjectionStoreCapabilityV1(store: TripleStore): {
  readonly transactionVersion: 'v1' | null;
  readonly authoritativeEligible: boolean;
} {
  const supported = store.walProjectionTransactions === WAL_PROJECTION_TRANSACTION_VERSION
    && typeof store.commitWalProjectionV1 === 'function';
  return {
    transactionVersion: supported ? WAL_PROJECTION_TRANSACTION_VERSION : null,
    authoritativeEligible: supported,
  };
}

export async function tryCommitWalProjectionV1(
  store: TripleStore,
  input: WalProjectionCommitInputV1,
  options?: QueryOptions,
): Promise<WalProjectionCommitResultV1 | null> {
  if (!walProjectionStoreCapabilityV1(store).authoritativeEligible) return null;
  return store.commitWalProjectionV1!(input, options);
}

export function buildWalProjectionCommitPlanV1(
  input: WalProjectionCommitInputV1,
): WalProjectionCommitPlanV1 {
  if (input.adapterVersion !== WAL_PROJECTION_ADAPTER_VERSION_V1) {
    throw new WalProjectionIntegrityError('unsupported WAL projection adapter version');
  }
  const namespaceId = fixedBytes(input.namespaceId, 'namespaceId');
  const logicalKey = fixedBytes(input.logicalKey, 'logicalKey');
  const expected = input.expectedActiveHeadsDigest === null
    ? null
    : fixedBytes(input.expectedActiveHeadsDigest, 'expectedActiveHeadsDigest');
  const marker: WalProjectionMarkerV1 = {
    adapterVersion: WAL_PROJECTION_ADAPTER_VERSION_V1,
    namespaceId,
    logicalKey,
    activeHeadsDigest: fixedBytes(input.newActiveHeadsDigest, 'newActiveHeadsDigest'),
    conflictHeadsDigest: fixedBytes(input.newConflictHeadsDigest, 'newConflictHeadsDigest'),
    stateDigest: fixedBytes(input.newStateDigest, 'newStateDigest'),
    sourceVectorId: fixedBytes(input.sourceVectorId, 'sourceVectorId'),
    materializationStatus: materializationStatus(input.materializationStatus),
  };
  const markerSubject = walProjectionMarkerSubjectV1(namespaceId, logicalKey);
  const expectedGraphPrefix = `${WAL_PROJECTION_SHADOW_GRAPH_PREFIX}${hex(namespaceId)}:${hex(logicalKey)}:`;
  if (
    input.mode !== 'CAS'
    && input.mode !== 'REBUILD'
  ) throw new WalProjectionIntegrityError('invalid WAL projection commit mode');
  if (
    input.mode === 'REBUILD'
    && (
      input.expectedActiveHeadsDigest !== null
      || input.replaceSubjects.length > 0
      || input.deleteQuads.length > 0
      || input.insertQuads.length > 0
    )
  ) {
    throw new WalProjectionIntegrityError(
      'REBUILD requires a complete graph-only projection and no expected head digest',
    );
  }
  const fullReplacements = [
    ...input.replaceGraphs.map(value => ({ ...value, role: 'replaceGraphs' })),
    ...input.conflictGraphs.map(value => ({ ...value, role: 'conflictGraphs' })),
  ];
  const fullGraphs = new Set<string>();
  const subjectKeys = new Set<string>();
  const touched = new Set<string>();

  for (const [index, replacement] of fullReplacements.entries()) {
    const graph = projectionGraph(replacement.graphUri, expectedGraphPrefix, `${replacement.role}[${index}].graphUri`);
    if (fullGraphs.has(graph)) {
      throw new WalProjectionIntegrityError(`WAL projection graph ${graph} is replaced more than once`);
    }
    fullGraphs.add(graph);
    touched.add(graph);
    validateQuads(replacement.quads, graph, undefined, `${replacement.role}[${index}].quads`);
  }
  for (const [index, replacement] of input.replaceSubjects.entries()) {
    const graph = projectionGraph(replacement.graphUri, expectedGraphPrefix, `replaceSubjects[${index}].graphUri`);
    const subject = resource(replacement.subject, `replaceSubjects[${index}].subject`);
    if (fullGraphs.has(graph)) {
      throw new WalProjectionIntegrityError(`subject replacement overlaps complete graph replacement ${graph}`);
    }
    const key = `${graph}\0${subject}`;
    if (subjectKeys.has(key)) {
      throw new WalProjectionIntegrityError(`WAL projection subject ${subject} in ${graph} is replaced more than once`);
    }
    subjectKeys.add(key);
    touched.add(graph);
    validateQuads(replacement.quads, graph, subject, `replaceSubjects[${index}].quads`);
  }
  validateQuads(input.deleteQuads, undefined, undefined, 'deleteQuads', expectedGraphPrefix);
  validateQuads(input.insertQuads, undefined, undefined, 'insertQuads', expectedGraphPrefix);
  for (const quad of [...input.deleteQuads, ...input.insertQuads]) {
    if (fullGraphs.has(quad.graph) || subjectKeys.has(`${quad.graph}\0${resource(quad.subject, 'delta subject')}`)) {
      throw new WalProjectionIntegrityError('WAL projection delta overlaps a complete graph or subject replacement');
    }
    touched.add(quad.graph);
  }
  rejectDuplicateOrContradictoryDeltas(input.deleteQuads, input.insertQuads);

  const guard = input.mode === 'REBUILD'
    ? 'FILTER(true)'
    : markerGuard(markerSubject, namespaceId, logicalKey, expected);
  const operations: string[] = [];
  if (input.mode === 'REBUILD') {
    operations.push(`DELETE { GRAPH ?walRebuildGraph { ?walRebuildS ?walRebuildP ?walRebuildO } }
WHERE {
  GRAPH ?walRebuildGraph { ?walRebuildS ?walRebuildP ?walRebuildO }
  FILTER(STRSTARTS(STR(?walRebuildGraph), "${expectedGraphPrefix}"))
}`);
  }
  for (const replacement of fullReplacements) {
    operations.push(replaceGraphOperation(replacement.graphUri, replacement.quads, guard));
  }
  for (const replacement of input.replaceSubjects) {
    operations.push(replaceSubjectOperation(
      replacement.graphUri,
      replacement.subject,
      replacement.quads,
      guard,
    ));
  }
  if (input.deleteQuads.length > 0 || input.insertQuads.length > 0) {
    operations.push(deltaOperation(input.deleteQuads, input.insertQuads, guard));
  }
  operations.push(markerOperation(markerSubject, marker, guard));
  touched.add(WAL_PROJECTION_MARKER_GRAPH);
  return {
    update: operations.join(';\n'),
    marker,
    markerSubject,
    touchedGraphs: [...touched].sort(),
  };
}

export async function readWalProjectionMarkerV1(
  store: Pick<TripleStore, 'query'>,
  namespaceId: Uint8Array,
  logicalKey: Uint8Array,
  options?: QueryOptions,
): Promise<WalProjectionMarkerV1 | null> {
  const namespace = fixedBytes(namespaceId, 'namespaceId');
  const logical = fixedBytes(logicalKey, 'logicalKey');
  const subject = walProjectionMarkerSubjectV1(namespace, logical);
  const result = await store.query(`
SELECT ?adapterVersion ?namespaceId ?logicalKey ?activeHeadsDigest
       ?conflictHeadsDigest ?stateDigest ?sourceVectorId ?materializationStatus
WHERE {
  GRAPH <${WAL_PROJECTION_MARKER_GRAPH}> {
    <${subject}> <${PREDICATE.adapterVersion}> ?adapterVersion ;
      <${PREDICATE.namespaceId}> ?namespaceId ;
      <${PREDICATE.logicalKey}> ?logicalKey ;
      <${PREDICATE.activeHeadsDigest}> ?activeHeadsDigest ;
      <${PREDICATE.conflictHeadsDigest}> ?conflictHeadsDigest ;
      <${PREDICATE.stateDigest}> ?stateDigest ;
      <${PREDICATE.sourceVectorId}> ?sourceVectorId ;
      <${PREDICATE.materializationStatus}> ?materializationStatus .
  }
}`, options);
  if (result.type !== 'bindings') {
    throw new WalProjectionIntegrityError('WAL projection marker query returned a non-binding result');
  }
  if (result.bindings.length === 0) {
    const any = await store.query(
      `ASK { GRAPH <${WAL_PROJECTION_MARKER_GRAPH}> { <${subject}> ?p ?o } }`,
      options,
    );
    if (any.type !== 'boolean') {
      throw new WalProjectionIntegrityError('WAL projection marker integrity query returned a non-boolean result');
    }
    if (any.value) {
      throw new WalProjectionIntegrityError('WAL projection marker is incomplete or malformed');
    }
    return null;
  }
  if (result.bindings.length !== 1) {
    throw new WalProjectionIntegrityError('WAL projection marker contains duplicate field values');
  }
  const countResult = await store.query(`
SELECT (COUNT(*) AS ?count) WHERE {
  GRAPH <${WAL_PROJECTION_MARKER_GRAPH}> { <${subject}> ?p ?o }
}`, options);
  const countValue = countResult.type === 'bindings'
    ? countResult.bindings[0]?.count
    : undefined;
  const countMatch = countValue?.match(
    /^"([0-9]+)"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#integer>$/,
  );
  if (
    countResult.type !== 'bindings'
    || countResult.bindings.length !== 1
    || countMatch == null
    || Number(countMatch[1]) !== MARKER_PREDICATE_COUNT
  ) {
    throw new WalProjectionIntegrityError('WAL projection marker has an unexpected field count');
  }
  const row = result.bindings[0]!;
  const marker: WalProjectionMarkerV1 = {
    adapterVersion: parseAdapterVersion(row.adapterVersion),
    namespaceId: parseHexLiteral(row.namespaceId, 'namespaceId'),
    logicalKey: parseHexLiteral(row.logicalKey, 'logicalKey'),
    activeHeadsDigest: parseHexLiteral(row.activeHeadsDigest, 'activeHeadsDigest'),
    conflictHeadsDigest: parseHexLiteral(row.conflictHeadsDigest, 'conflictHeadsDigest'),
    stateDigest: parseHexLiteral(row.stateDigest, 'stateDigest'),
    sourceVectorId: parseHexLiteral(row.sourceVectorId, 'sourceVectorId'),
    materializationStatus: materializationStatus(parsePlainLiteral(row.materializationStatus, 'materializationStatus')),
  };
  if (!bytesEqual(marker.namespaceId, namespace) || !bytesEqual(marker.logicalKey, logical)) {
    throw new WalProjectionIntegrityError('WAL projection marker scope does not match its subject');
  }
  return marker;
}

export function walProjectionMarkerEqualsV1(
  left: WalProjectionMarkerV1 | null,
  right: WalProjectionMarkerV1 | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.adapterVersion === right.adapterVersion
    && left.materializationStatus === right.materializationStatus
    && bytesEqual(left.namespaceId, right.namespaceId)
    && bytesEqual(left.logicalKey, right.logicalKey)
    && bytesEqual(left.activeHeadsDigest, right.activeHeadsDigest)
    && bytesEqual(left.conflictHeadsDigest, right.conflictHeadsDigest)
    && bytesEqual(left.stateDigest, right.stateDigest)
    && bytesEqual(left.sourceVectorId, right.sourceVectorId);
}

function fixedBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new WalProjectionIntegrityError(`${label} must be exactly 32 bytes`);
  }
  return new Uint8Array(value);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function materializationStatus(value: string): WalProjectionMaterializationStatusV1 {
  if (!['APPLIED', 'PENDING', 'BLOCKED'].includes(value)) {
    throw new WalProjectionIntegrityError('invalid WAL projection materialization status');
  }
  return value as WalProjectionMaterializationStatusV1;
}

function projectionGraph(value: string, expectedPrefix: string, label: string): string {
  const graph = assertSafeIri(value);
  if (!graph.startsWith(expectedPrefix)) {
    throw new WalProjectionIntegrityError(`${label} must be an isolated graph in this WAL projection scope`);
  }
  return graph;
}

function validateQuads(
  quads: readonly Quad[],
  expectedGraph: string | undefined,
  expectedSubject: string | undefined,
  label: string,
  expectedPrefix?: string,
): void {
  if (!Array.isArray(quads)) throw new WalProjectionIntegrityError(`${label} must be an array`);
  for (const [index, quad] of quads.entries()) {
    if (quad === null || typeof quad !== 'object') {
      throw new WalProjectionIntegrityError(`${label}[${index}] must be an RDF quad`);
    }
    const graph = assertSafeIri(quad.graph);
    if (expectedGraph !== undefined && graph !== expectedGraph) {
      throw new WalProjectionIntegrityError(`${label}[${index}] targets the wrong graph`);
    }
    if (expectedPrefix !== undefined) projectionGraph(graph, expectedPrefix, `${label}[${index}].graph`);
    const subject = resource(quad.subject, `${label}[${index}].subject`);
    if (expectedSubject !== undefined && subject !== expectedSubject) {
      throw new WalProjectionIntegrityError(`${label}[${index}] targets the wrong subject`);
    }
    resource(quad.predicate, `${label}[${index}].predicate`);
    objectTerm(quad.object, `${label}[${index}].object`);
  }
}

function rejectDuplicateOrContradictoryDeltas(
  deletes: readonly Quad[],
  inserts: readonly Quad[],
): void {
  const deleted = new Set<string>();
  for (const quad of deletes) {
    const key = quadKey(quad);
    if (deleted.has(key)) throw new WalProjectionIntegrityError('deleteQuads contains a duplicate quad');
    deleted.add(key);
  }
  const inserted = new Set<string>();
  for (const quad of inserts) {
    const key = quadKey(quad);
    if (inserted.has(key)) throw new WalProjectionIntegrityError('insertQuads contains a duplicate quad');
    if (deleted.has(key)) throw new WalProjectionIntegrityError('the same WAL projection quad is both deleted and inserted');
    inserted.add(key);
  }
}

function quadKey(quad: Quad): string {
  return `${quad.graph}\0${quad.subject}\0${quad.predicate}\0${quad.object}`;
}

function markerGuard(
  subject: string,
  namespaceId: Uint8Array,
  logicalKey: Uint8Array,
  expected: Uint8Array | null,
): string {
  if (expected === null) {
    return `{ SELECT (COUNT(*) AS ?walMarkerCount) WHERE {
      GRAPH <${WAL_PROJECTION_MARKER_GRAPH}> { <${subject}> ?walMarkerP ?walMarkerO }
    } }
    FILTER(?walMarkerCount = 0)`;
  }
  return `{ SELECT (COUNT(*) AS ?walMarkerCount) WHERE {
      GRAPH <${WAL_PROJECTION_MARKER_GRAPH}> { <${subject}> ?walMarkerP ?walMarkerO }
    } }
    FILTER(?walMarkerCount = ${MARKER_PREDICATE_COUNT})
    GRAPH <${WAL_PROJECTION_MARKER_GRAPH}> {
      <${subject}> <${PREDICATE.adapterVersion}> "1"^^<${XSD_INTEGER}> ;
        <${PREDICATE.namespaceId}> "${hex(namespaceId)}" ;
        <${PREDICATE.logicalKey}> "${hex(logicalKey)}" ;
        <${PREDICATE.activeHeadsDigest}> "${hex(expected)}" ;
        <${PREDICATE.conflictHeadsDigest}> ?walConflictDigest ;
        <${PREDICATE.stateDigest}> ?walStateDigest ;
        <${PREDICATE.sourceVectorId}> ?walVectorId ;
        <${PREDICATE.materializationStatus}> ?walStatus .
    }`;
}

function replaceGraphOperation(
  graphUri: string,
  quads: readonly Quad[],
  guard: string,
): string {
  const graph = assertSafeIri(graphUri);
  const insert = quads.length === 0
    ? ''
    : `INSERT { GRAPH <${graph}> {\n${quads.map(quad => `    ${triple(quad)}`).join('\n')}\n  } }\n`;
  return `DELETE { GRAPH <${graph}> { ?walReplaceS ?walReplaceP ?walReplaceO } }
${insert}WHERE {
  ${guard}
  OPTIONAL { GRAPH <${graph}> { ?walReplaceS ?walReplaceP ?walReplaceO } }
}`;
}

function replaceSubjectOperation(
  graphUri: string,
  subjectValue: string,
  quads: readonly Quad[],
  guard: string,
): string {
  const graph = assertSafeIri(graphUri);
  const subject = resource(subjectValue, 'replacement subject');
  const insert = quads.length === 0
    ? ''
    : `INSERT { GRAPH <${graph}> {\n${quads.map(quad => `    ${triple(quad)}`).join('\n')}\n  } }\n`;
  return `DELETE { GRAPH <${graph}> { <${subject}> ?walSubjectP ?walSubjectO } }
${insert}WHERE {
  ${guard}
  OPTIONAL { GRAPH <${graph}> { <${subject}> ?walSubjectP ?walSubjectO } }
}`;
}

function deltaOperation(
  deletes: readonly Quad[],
  inserts: readonly Quad[],
  guard: string,
): string {
  const deleteTemplate = deletes.length === 0
    ? ''
    : `DELETE {\n${graphTemplates(deletes)}\n}\n`;
  const insertTemplate = inserts.length === 0
    ? ''
    : `INSERT {\n${graphTemplates(inserts)}\n}\n`;
  return `${deleteTemplate}${insertTemplate}WHERE {\n  ${guard}\n}`;
}

function markerOperation(
  subject: string,
  marker: WalProjectionMarkerV1,
  guard: string,
): string {
  const markerTriples = [
    `<${subject}> <${PREDICATE.adapterVersion}> "1"^^<${XSD_INTEGER}> .`,
    `<${subject}> <${PREDICATE.namespaceId}> "${hex(marker.namespaceId)}" .`,
    `<${subject}> <${PREDICATE.logicalKey}> "${hex(marker.logicalKey)}" .`,
    `<${subject}> <${PREDICATE.activeHeadsDigest}> "${hex(marker.activeHeadsDigest)}" .`,
    `<${subject}> <${PREDICATE.conflictHeadsDigest}> "${hex(marker.conflictHeadsDigest)}" .`,
    `<${subject}> <${PREDICATE.stateDigest}> "${hex(marker.stateDigest)}" .`,
    `<${subject}> <${PREDICATE.sourceVectorId}> "${hex(marker.sourceVectorId)}" .`,
    `<${subject}> <${PREDICATE.materializationStatus}> "${marker.materializationStatus}" .`,
  ].map(value => `    ${value}`).join('\n');
  return `DELETE { GRAPH <${WAL_PROJECTION_MARKER_GRAPH}> { <${subject}> ?walOldP ?walOldO } }
INSERT { GRAPH <${WAL_PROJECTION_MARKER_GRAPH}> {\n${markerTriples}\n  } }
WHERE {
  ${guard}
  OPTIONAL { GRAPH <${WAL_PROJECTION_MARKER_GRAPH}> { <${subject}> ?walOldP ?walOldO } }
}`;
}

function graphTemplates(quads: readonly Quad[]): string {
  const grouped = new Map<string, Quad[]>();
  for (const quad of quads) {
    const values = grouped.get(quad.graph) ?? [];
    values.push(quad);
    grouped.set(quad.graph, values);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([graph, values]) => `  GRAPH <${assertSafeIri(graph)}> {\n${values.map(quad => `    ${triple(quad)}`).join('\n')}\n  }`)
    .join('\n');
}

function triple(quad: Quad): string {
  return `<${resource(quad.subject, 'subject')}> <${resource(quad.predicate, 'predicate')}> ${objectTerm(quad.object, 'object')} .`;
}

function resource(value: string, label: string): string {
  if (typeof value !== 'string' || value.startsWith('"') || value.startsWith('_:')) {
    throw new WalProjectionIntegrityError(`WAL projection ${label} must be an IRI`);
  }
  const unwrapped = value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value;
  return assertSafeIri(unwrapped);
}

function objectTerm(value: string, label: string): string {
  if (typeof value !== 'string' || value.startsWith('_:')) {
    throw new WalProjectionIntegrityError(`WAL projection ${label} cannot be a blank node`);
  }
  if (!value.startsWith('"')) return `<${resource(value, label)}>`;
  const bareDatatype = value.match(/^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/);
  const normalized = bareDatatype
    ? `${bareDatatype[1]}^^<${resource(bareDatatype[2]!, `${label} datatype`)}>`
    : value;
  assertSafeRdfTerm(normalized);
  return normalized;
}

function parseAdapterVersion(value: string | undefined): 1 {
  if (value !== `"1"^^<${XSD_INTEGER}>`) {
    throw new WalProjectionIntegrityError('WAL projection marker has an unsupported adapter version');
  }
  return WAL_PROJECTION_ADAPTER_VERSION_V1;
}

function parsePlainLiteral(value: string | undefined, label: string): string {
  const match = value?.match(/^"([^"\\]*)"$/);
  if (!match) throw new WalProjectionIntegrityError(`WAL projection marker ${label} is malformed`);
  return match[1]!;
}

function parseHexLiteral(value: string | undefined, label: string): Uint8Array {
  const text = parsePlainLiteral(value, label);
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new WalProjectionIntegrityError(`WAL projection marker ${label} must be lowercase bytes32 hex`);
  }
  return new Uint8Array(Buffer.from(text, 'hex'));
}
