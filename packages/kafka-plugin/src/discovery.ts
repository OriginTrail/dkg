const DKG_STREAMS = 'https://ontology.dkg.io/streams#';
const SCHEMA = 'https://schema.org/';
const DKG_ONT = 'http://dkg.io/ontology/';
const ROOT_ENTITY = `${DKG_ONT}rootEntity`;
// RFC ka-metadata-trim P3.1 read-both: the collapsed `_meta` shape carries
// `dkg:rootEntity` directly on the UAL subject (no `<ual>/<n> dkg:partOf
// <ual>` token rows), so every discovery query UNIONs the legacy partOf join
// with the collapsed UAL-subject match. `dkg:publishedAt` on the KC/UAL row
// is KEPT writer-side (generateKCMetadata) specifically for these queries'
// newest-first ordering.
const PART_OF = `${DKG_ONT}partOf`;
const PUBLISHED_AT = `${DKG_ONT}publishedAt`;
const STATUS = `${DKG_ONT}status`;
const SUB_GRAPH_NAME = `${DKG_ONT}subGraphName`;
const PRIVATE_DATA_ANCHOR = `${DKG_ONT}privateDataAnchor`;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const KAFKA_STREAM_TYPE = `${DKG_STREAMS}KafkaStream`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_NUMERIC = /^(?:decimal|float|double|integer|long|int|short|byte|nonPositiveInteger|negativeInteger|nonNegativeInteger|positiveInteger|unsignedLong|unsignedInt|unsignedShort|unsignedByte)$/;
const XSD_INTEGER = /^(?:integer|long|int|short|byte|nonPositiveInteger|negativeInteger|nonNegativeInteger|positiveInteger|unsignedLong|unsignedInt|unsignedShort|unsignedByte)$/;
const CONTEXT_GRAPH_ID = /^[\w:/.@-]+$/;

const UNSAFE_IRI_CHARS = /[<>"{}|\\^`\s]/;

function metaUri(contextGraphId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/_meta`;
}

function dataUri(contextGraphId: string, subGraphName?: string): string {
  return subGraphName
    ? `did:dkg:context-graph:${contextGraphId}/${subGraphName}`
    : `did:dkg:context-graph:${contextGraphId}`;
}

function privateUri(contextGraphId: string, subGraphName?: string): string {
  return subGraphName
    ? `did:dkg:context-graph:${contextGraphId}/${subGraphName}/_private`
    : `did:dkg:context-graph:${contextGraphId}/_private`;
}

function assertSafeCgId(cgId: string): void {
  if (!cgId || cgId.length > 256 || !CONTEXT_GRAPH_ID.test(cgId)) {
    throw new Error(`Invalid contextGraphId: contains illegal character in "${cgId}"`);
  }
}

function assertSafeUal(ual: string): void {
  if (!ual || UNSAFE_IRI_CHARS.test(ual)) {
    throw new Error(`Invalid UAL: contains illegal character in "${ual}"`);
  }
}

function assertSafeSubGraphName(subGraphName: string): void {
  if (
    !subGraphName ||
    subGraphName.startsWith('_') ||
    subGraphName.includes('/') ||
    UNSAFE_IRI_CHARS.test(subGraphName) ||
    subGraphName === 'context' ||
    subGraphName === 'assertion' ||
    subGraphName === 'draft'
  ) {
    throw new Error(`Invalid subGraphName: contains illegal character or reserved segment in "${subGraphName}"`);
  }
}

function registrationScopeClause(ualTerm: string, subGraphName: string | undefined, indent: string): string {
  const scope = subGraphName === undefined
    ? `FILTER NOT EXISTS { ${ualTerm} <${SUB_GRAPH_NAME}> ?_subGraphName . }`
    : `${ualTerm} <${SUB_GRAPH_NAME}> "${subGraphName}" .`;
  return `${indent}${ualTerm} <${STATUS}> ?registrationStatus .
${indent}FILTER(?registrationStatus IN ("confirmed", "tentative"))
${indent}${scope}`;
}

export interface ListQueryParams {
  contextGraphId: string;
  subGraphName?: string;
  limit: number;
  offset: number;
}

export interface CountQueryParams {
  contextGraphId: string;
  subGraphName?: string;
}

export interface SingleQueryParams {
  contextGraphId: string;
  subGraphName?: string;
  ual: string;
}

export function buildListQuery({ contextGraphId, subGraphName, limit, offset }: ListQueryParams): string {
  assertSafeCgId(contextGraphId);
  if (subGraphName !== undefined) assertSafeSubGraphName(subGraphName);
  const meta = metaUri(contextGraphId);
  const data = dataUri(contextGraphId, subGraphName);
  const privateGraph = privateUri(contextGraphId, subGraphName);
  return `SELECT ?ual ?root ?receivedAt ?p ?o WHERE {
  {
    SELECT DISTINCT ?ual ?root ?receivedAt WHERE {
      GRAPH <${meta}> {
        { ?ka <${PART_OF}> ?ual . ?ka <${ROOT_ENTITY}> ?root . }
        UNION
        { ?ual <${ROOT_ENTITY}> ?root . }
${registrationScopeClause('?ual', subGraphName, '        ')}
        ?ual <${PUBLISHED_AT}> ?receivedAt .
      }
      {
        GRAPH <${data}> {
          ?root a <${KAFKA_STREAM_TYPE}> .
        }
      }
      UNION
      {
        GRAPH <${data}> {
          ?root <${PRIVATE_DATA_ANCHOR}> "true" .
        }
        GRAPH <${privateGraph}> {
          ?root a <${KAFKA_STREAM_TYPE}> .
        }
      }
    }
    ORDER BY DESC(?receivedAt)
    LIMIT ${limit} OFFSET ${offset}
  }
  {
    GRAPH <${data}> {
      ?root a <${KAFKA_STREAM_TYPE}> .
      ?root ?p ?o .
    }
  }
  UNION
  {
    GRAPH <${data}> {
      ?root <${PRIVATE_DATA_ANCHOR}> "true" .
    }
    GRAPH <${privateGraph}> { ?root ?p ?o . }
  }
}
ORDER BY DESC(?receivedAt) ?ual ?root ?p ?o`;
}

export function buildCountQuery({ contextGraphId, subGraphName }: CountQueryParams): string {
  assertSafeCgId(contextGraphId);
  if (subGraphName !== undefined) assertSafeSubGraphName(subGraphName);
  const meta = metaUri(contextGraphId);
  const data = dataUri(contextGraphId, subGraphName);
  const privateGraph = privateUri(contextGraphId, subGraphName);
  return `SELECT (COUNT(DISTINCT ?ual) AS ?count) WHERE {
  GRAPH <${meta}> {
    { ?ka <${PART_OF}> ?ual . ?ka <${ROOT_ENTITY}> ?root . }
    UNION
    { ?ual <${ROOT_ENTITY}> ?root . }
${registrationScopeClause('?ual', subGraphName, '    ')}
  }
  {
    GRAPH <${data}> { ?root a <${KAFKA_STREAM_TYPE}> . }
  }
  UNION
  {
    GRAPH <${data}> { ?root <${PRIVATE_DATA_ANCHOR}> "true" . }
    GRAPH <${privateGraph}> { ?root a <${KAFKA_STREAM_TYPE}> . }
  }
}`;
}

export function buildSingleByUalQuery({ contextGraphId, subGraphName, ual }: SingleQueryParams): string {
  assertSafeCgId(contextGraphId);
  if (subGraphName !== undefined) assertSafeSubGraphName(subGraphName);
  assertSafeUal(ual);
  const meta = metaUri(contextGraphId);
  const data = dataUri(contextGraphId, subGraphName);
  const privateGraph = privateUri(contextGraphId, subGraphName);
  return `SELECT ?root ?p ?o WHERE {
  GRAPH <${meta}> {
    { ?ka <${PART_OF}> <${ual}> . ?ka <${ROOT_ENTITY}> ?root . }
    UNION
    { <${ual}> <${ROOT_ENTITY}> ?root . }
${registrationScopeClause(`<${ual}>`, subGraphName, '    ')}
  }
  {
    GRAPH <${data}> {
      ?root a <${KAFKA_STREAM_TYPE}> .
      ?root ?p ?o .
    }
  }
  UNION
  {
    GRAPH <${data}> {
      ?root <${PRIVATE_DATA_ANCHOR}> "true" .
    }
    GRAPH <${privateGraph}> {
      ?root a <${KAFKA_STREAM_TYPE}> .
      ?root ?p ?o .
    }
  }
}`;
}

type BindingValue = unknown;
type BindingRow = Record<string, BindingValue>;

export type KafkaStreamKa = {
  '@context': Record<string, string>;
  '@id'?: string;
  '@type': string | string[];
  [k: string]: unknown;
};

export function bindingsToKa(bindings: ReadonlyArray<BindingRow>): KafkaStreamKa | null {
  if (bindings.length === 0) return null;

  const baselineCtx: Record<string, string> = {
    'dkg-streams': DKG_STREAMS,
    schema: SCHEMA,
  };
  const namespaceToPrefix = new Map<string, string>(
    Object.entries(baselineCtx).map(([prefix, iri]) => [iri, prefix]),
  );
  const ctx: Record<string, string> = { ...baselineCtx };
  const types: string[] = [];
  const seenTypes = new Set<string>();
  const properties: Record<string, unknown> = {};
  let id: string | undefined;

  for (const row of bindings) {
    const ualVal = unwrapBinding(row.ual);
    if (ualVal && !id) id = ualVal;
    const predicate = unwrapBinding(row.p);
    const rawObject = unwrapBinding(row.o);
    const objectRaw = rawObject;
    if (!predicate || objectRaw === undefined) continue;
    if (predicate === PRIVATE_DATA_ANCHOR) continue;
    if (predicate === RDF_TYPE) {
      const typeIri = stripIriQuoting(objectRaw);
      const compacted = compactIriWithCtx(typeIri, ctx, namespaceToPrefix);
      if (!seenTypes.has(compacted)) {
        seenTypes.add(compacted);
        types.push(compacted);
      }
      continue;
    }
    const key = compactIriWithCtx(predicate, ctx, namespaceToPrefix);
    appendProperty(properties, key, decodeRdfTerm(objectRaw));
  }

  const sortedTypes = sortBaselineFirst(types);
  const finalType: string | string[] =
    sortedTypes.length === 0
      ? KAFKA_STREAM_TYPE_PREFIXED
      : sortedTypes.length === 1
      ? sortedTypes[0]
      : sortedTypes;

  const ka: KafkaStreamKa = {
    '@context': ctx,
    '@type': finalType,
    ...properties,
  };
  if (id) ka['@id'] = id;
  return ka;
}

const KAFKA_STREAM_TYPE_PREFIXED = 'dkg-streams:KafkaStream';

function appendProperty(properties: Record<string, unknown>, key: string, value: unknown): void {
  if (!(key in properties)) {
    properties[key] = value;
    return;
  }
  const existing = properties[key];
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  properties[key] = [existing, value];
}

function sortBaselineFirst(types: ReadonlyArray<string>): string[] {
  const baseline: string[] = [];
  const rest: string[] = [];
  for (const t of types) {
    if (t === KAFKA_STREAM_TYPE_PREFIXED) baseline.push(t);
    else rest.push(t);
  }
  rest.sort();
  return [...baseline, ...rest];
}

function compactIriWithCtx(
  iri: string,
  ctx: Record<string, string>,
  namespaceToPrefix: Map<string, string>,
): string {
  const split = splitIri(iri);
  if (!split) return iri;
  const { namespace, local } = split;
  const existingPrefix = namespaceToPrefix.get(namespace);
  if (existingPrefix) return `${existingPrefix}:${local}`;
  const prefix = synthesisePrefix(namespace, ctx);
  ctx[prefix] = namespace;
  namespaceToPrefix.set(namespace, prefix);
  return `${prefix}:${local}`;
}

function splitIri(iri: string): { namespace: string; local: string } | null {
  const hash = iri.lastIndexOf('#');
  if (hash > 0 && hash < iri.length - 1) {
    return { namespace: iri.slice(0, hash + 1), local: iri.slice(hash + 1) };
  }
  const slash = iri.lastIndexOf('/');
  if (slash > 0 && slash < iri.length - 1) {
    return { namespace: iri.slice(0, slash + 1), local: iri.slice(slash + 1) };
  }
  return null;
}

function synthesisePrefix(namespace: string, ctx: Record<string, string>): string {
  const stem = derivePrefixStem(namespace);
  if (!(stem in ctx)) return stem;
  let n = 2;
  while (`${stem}${n}` in ctx) n++;
  return `${stem}${n}`;
}

function derivePrefixStem(namespace: string): string {
  const cleaned = namespace.replace(/^[a-z]+:\/\//, '').replace(/[/#]+$/, '');
  const firstSegment = cleaned.split(/[/.#]/)[0];
  const safe = firstSegment.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
  return safe.length > 0 ? safe : 'ns';
}

function stripIriQuoting(raw: string): string {
  if (raw.length >= 2 && raw.charCodeAt(0) === 0x3c /* < */ && raw.charCodeAt(raw.length - 1) === 0x3e /* > */) {
    return raw.slice(1, -1);
  }
  return raw;
}

function unwrapBinding(v: BindingValue): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const inner = (v as { value: unknown }).value;
    return typeof inner === 'string' ? inner : undefined;
  }
  return undefined;
}

function decodeRdfTerm(raw: string): string | number | boolean {
  if (raw.length === 0 || raw.charCodeAt(0) !== 0x22 /* " */) return raw;
  const match = /^"((?:\\.|[^"\\])*)"(?:@[\w-]+|\^\^<([^>]+)>)?$/.exec(raw);
  if (!match) return raw;
  const value = unescapeNQuadsLiteral(match[1]);
  const datatype = match[2];
  if (datatype === `${XSD}boolean`) {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  if (datatype?.startsWith(XSD) && XSD_NUMERIC.test(datatype.slice(XSD.length))) {
    const n = Number(value);
    if (isLosslessNumericLiteral(value, n, datatype.slice(XSD.length))) return n;
  }
  return value;
}

function isLosslessNumericLiteral(value: string, n: number, localDatatype: string): boolean {
  if (!Number.isFinite(n)) return false;
  if (XSD_INTEGER.test(localDatatype)) return Number.isSafeInteger(n);
  return String(n) === value;
}

function unescapeNQuadsLiteral(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }

    const escaped = s[++i];
    if (escaped === undefined) return `${out}\\`;
    if (escaped === 't') out += '\t';
    else if (escaped === 'b') out += '\b';
    else if (escaped === 'n') out += '\n';
    else if (escaped === 'r') out += '\r';
    else if (escaped === 'f') out += '\f';
    else if (escaped === '"' || escaped === "'" || escaped === '\\') out += escaped;
    else if (escaped === 'u' || escaped === 'U') {
      const width = escaped === 'u' ? 4 : 8;
      const hex = s.slice(i + 1, i + 1 + width);
      if (/^[0-9A-Fa-f]+$/.test(hex) && hex.length === width) {
        const codePoint = Number.parseInt(hex, 16);
        out += codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : escaped;
        i += width;
      } else {
        out += escaped;
      }
    } else {
      out += escaped;
    }
  }
  return out;
}
