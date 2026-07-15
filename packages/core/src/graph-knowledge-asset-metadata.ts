import {
  parseRdfLiteralTerm,
} from '@origintrail-official/dkg-rdf-utils';
import {
  contextGraphDataUri,
  contextGraphMetaUri,
  validateContextGraphId,
  validateSubGraphName,
} from './constants.js';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  type GraphKnowledgeAssetScope,
} from './ka-content-scope.js';
import { MemoryLayer } from './memory-model.js';
import { assertSafeIri, isSafeIri } from './sparql-safe.js';

const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';
const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SYSTEM_ONTOLOGY_GRAPH = contextGraphDataUri('ontology');
const SYSTEM_AGENTS_GRAPH = contextGraphDataUri('agents');
const ROOT_CONTEXT_GRAPH_TYPES = [
  'https://dkg.network/ontology#ContextGraph',
  'http://dkg.io/ontology/ContextGraph',
] as const;
const SUB_GRAPH_TYPES = [
  'https://dkg.network/ontology#SubGraph',
  'http://dkg.io/ontology/SubGraph',
] as const;
const PARENT_CONTEXT_GRAPH_PREDICATES = [
  'https://dkg.network/ontology#parentContextGraph',
  'http://dkg.io/ontology/parentContextGraph',
] as const;

const METADATA_PREDICATES = {
  scopeVersion: `${DKG}contentScopeVersion`,
  kaUal: `${DKG}kaUal`,
  assertionVersion: `${DKG}assertionVersion`,
  assertionGraph: `${DKG}assertionGraph`,
  contextGraph: `${DKG}contextGraph`,
  publicTripleCount: `${DKG}publicTripleCount`,
  privateTripleCount: `${DKG}privateTripleCount`,
  privateMerkleRoot: `${DKG}privateMerkleRoot`,
  accessPolicy: `${DKG}accessPolicy`,
  publisherPeerId: `${DKG}publisherPeerId`,
  attributedTo: `${PROV}wasAttributedTo`,
  sgName: `${DKG}subGraphName`,
  allowedPeer: `${DKG}allowedPeer`,
} as const;

type MetadataField = keyof typeof METADATA_PREDICATES;
type ParsedField = MetadataField | 'g';

const METADATA_FIELDS = Object.keys(METADATA_PREDICATES) as MetadataField[];
const FIELD_BY_PREDICATE = new Map<string, MetadataField>(
  METADATA_FIELDS.map((field) => [METADATA_PREDICATES[field], field]),
);

/** One vertical property/value row returned by the canonical metadata query. */
export interface GraphKnowledgeAssetMetadataPropertyBinding {
  readonly g: string;
  readonly predicate: string;
  readonly value: string;
}

/**
 * Compatibility shape for already-projected binding fixtures/callers. The
 * canonical query uses property/value rows so multi-valued fields cannot form
 * an OPTIONAL cross-product, but the parser accepts this shape as well.
 */
export interface GraphKnowledgeAssetMetadataProjectedBinding {
  readonly g?: string;
  readonly predicate?: never;
  readonly value?: never;
  readonly scopeVersion?: string;
  readonly kaUal?: string;
  readonly assertionVersion?: string;
  readonly assertionGraph?: string;
  readonly contextGraph?: string;
  readonly publicTripleCount?: string;
  readonly privateTripleCount?: string;
  readonly privateMerkleRoot?: string;
  readonly accessPolicy?: string;
  readonly publisherPeerId?: string;
  readonly attributedTo?: string;
  readonly sgName?: string;
  readonly allowedPeer?: string;
}

export type GraphKnowledgeAssetMetadataBinding =
  | GraphKnowledgeAssetMetadataPropertyBinding
  | GraphKnowledgeAssetMetadataProjectedBinding
  | Readonly<Record<string, string | undefined>>;

export type GraphKnowledgeAssetAccessPolicy = 'public' | 'ownerOnly' | 'allowList';

/** Canonical, validated graph-scoped KA control-plane metadata. */
export interface ParsedGraphKnowledgeAssetMetadata {
  readonly contentScopeVersion: typeof GRAPH_KA_CONTENT_SCOPE_VERSION;
  readonly scope: GraphKnowledgeAssetScope;
  readonly ual: string;
  readonly assertionVersion: string;
  readonly assertionGraph: string;
  readonly metadataGraph: string;
  readonly contextGraphUri: string;
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly publicTripleCount: number;
  readonly privateTripleCount: number;
  readonly privateMerkleRoot?: Uint8Array;
  readonly accessPolicy?: GraphKnowledgeAssetAccessPolicy;
  readonly publisherPeerId?: string;
  readonly attributedTo?: string;
  readonly allowedPeers: readonly string[];
}

export type GraphKnowledgeAssetMetadataParseResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'legacy' }
  | { readonly kind: 'graph'; readonly metadata: ParsedGraphKnowledgeAssetMetadata };

/**
 * Require a context-graph subject to be declared in an authoritative root
 * registry. Open roots are registered in the system ontology graph; curated
 * roots keep the same declaration in their own control-plane metadata graph.
 * Payload and named-subgraph graphs are deliberately excluded.
 */
function buildTrustedRootContextGraphRegistrationFilter(
  contextGraphVariable: string,
  metadataGraphVariable: string,
): string {
  const variablePattern = /^\?[A-Za-z_][A-Za-z0-9_]*$/;
  if (!variablePattern.test(contextGraphVariable) || !variablePattern.test(metadataGraphVariable)) {
    throw new Error('Trusted context-graph registration filter requires SPARQL variables');
  }
  const rootTypes = ROOT_CONTEXT_GRAPH_TYPES.map((iri) => `<${iri}>`).join(' ');
  const subGraphTypes = SUB_GRAPH_TYPES.map((iri) => `<${iri}>`).join(' ');
  const parentPredicates = PARENT_CONTEXT_GRAPH_PREDICATES
    .map((iri) => `<${iri}>`)
    .join(' ');
  const rootRegistryGraphs = `<${SYSTEM_ONTOLOGY_GRAPH}> <${SYSTEM_AGENTS_GRAPH}>`;
  return `FILTER EXISTS {
      VALUES ?_dkgRootContextGraphType { ${rootTypes} }
      VALUES ?_dkgRootRegistryGraph { ${rootRegistryGraphs} }
      {
        GRAPH ?_dkgRootRegistryGraph {
          ${contextGraphVariable} <${RDF_TYPE}> ?_dkgRootContextGraphType .
        }
      }
      UNION
      {
        GRAPH ${metadataGraphVariable} {
          ${contextGraphVariable} <${RDF_TYPE}> ?_dkgRootContextGraphType .
        }
      }
    }
    FILTER NOT EXISTS {
      GRAPH ?_dkgParentMetaGraph {
        ${contextGraphVariable} <${RDF_TYPE}> ?_dkgSubGraphType .
        ${contextGraphVariable} ?_dkgParentPredicate ?_dkgParentContextGraph .
      }
      VALUES ?_dkgSubGraphType { ${subGraphTypes} }
      VALUES ?_dkgParentPredicate { ${parentPredicates} }
      FILTER(
        STR(?_dkgParentMetaGraph) = CONCAT(STR(?_dkgParentContextGraph), "/_meta")
      )
      VALUES ?_dkgParentRootType { ${rootTypes} }
      VALUES ?_dkgParentRegistryGraph { ${rootRegistryGraphs} }
      {
        GRAPH ?_dkgParentRegistryGraph {
          ?_dkgParentContextGraph <${RDF_TYPE}> ?_dkgParentRootType .
        }
      }
      UNION
      {
        GRAPH ?_dkgParentMetaGraph {
          ?_dkgParentContextGraph <${RDF_TYPE}> ?_dkgParentRootType .
        }
      }
    }
    FILTER NOT EXISTS {
      VALUES ?_dkgAliasRootType { ${rootTypes} }
      VALUES ?_dkgAliasRegistryGraph { ${rootRegistryGraphs} }
      {
        GRAPH ?_dkgAliasRegistryGraph {
          ${metadataGraphVariable} <${RDF_TYPE}> ?_dkgAliasRootType .
        }
      }
      UNION
      {
        GRAPH ?_dkgAliasMetaGraph {
          ${metadataGraphVariable} <${RDF_TYPE}> ?_dkgAliasRootType .
        }
        FILTER(STR(?_dkgAliasMetaGraph) = CONCAT(STR(${metadataGraphVariable}), "/_meta"))
      }
    }`;
}

/**
 * Build the one canonical graph-scoped metadata lookup.
 *
 * Rows are deliberately vertical (`predicate`, `value`) instead of a group of
 * OPTIONAL columns. A KA with several allowed peers therefore stays linear in
 * its metadata size rather than multiplying every optional value together.
 * The graph-name filter is independent of the metadata payload: an incomplete
 * V2 marker in a trusted `/_meta` graph remains visible and fails in the parser,
 * while marker triples authored inside KA payload graphs are ignored.
 */
export function buildGraphKnowledgeAssetMetadataQuery(ual: string): string {
  const safeUal = assertSafeIri(ual);
  const predicates = METADATA_FIELDS
    .map((field) => `<${METADATA_PREDICATES[field]}>`)
    .join('\n      ');

  return `SELECT ?g ?predicate ?value WHERE {
    GRAPH ?g {
      <${safeUal}> ?predicate ?value .
      VALUES ?predicate {
        ${predicates}
      }
      FILTER EXISTS {
        <${safeUal}> <${METADATA_PREDICATES.scopeVersion}> ?_scopeMarker .
      }
      <${safeUal}> <${METADATA_PREDICATES.contextGraph}> ?_contextGraph .
    }
    FILTER(STR(?g) = CONCAT(STR(?_contextGraph), "/_meta"))
    ${buildTrustedRootContextGraphRegistrationFilter('?_contextGraph', '?g')}
  }`;
}

/** Build the complete trusted legacy metadata lookup used by query reads. */
export function buildLegacyKnowledgeAssetMetadataQuery(ual: string): string {
  const safeUal = assertSafeIri(ual);
  return `SELECT ?ka ?rootEntity ?ctxGraph ?sgName WHERE {
    GRAPH ?g {
      {
        ?ka <${DKG}rootEntity> ?rootEntity .
        ?ka <${DKG}partOf> <${safeUal}> .
      }
      UNION
      {
        <${safeUal}> <${DKG}rootEntity> ?rootEntity .
        BIND(<${safeUal}> AS ?ka)
      }
      <${safeUal}> <${DKG}contextGraph> ?ctxGraph .
      OPTIONAL { <${safeUal}> <${DKG}subGraphName> ?sgName }
      BIND(CONCAT(STR(?ctxGraph), "/_meta") AS ?expectedMetaGraph)
      FILTER(STR(?g) = ?expectedMetaGraph)
    }
    ${buildTrustedRootContextGraphRegistrationFilter('?ctxGraph', '?g')}
  } ORDER BY ?ka`;
}

/** Build the complete trusted legacy metadata lookup used by private access. */
export function buildLegacyKnowledgeAssetAccessMetadataQuery(ual: string): string {
  const safeUal = assertSafeIri(ual);
  return `SELECT ?rootEntity ?contextGraph ?kc ?privateMerkleRoot ?privateTripleCount ?accessPolicy ?publisherPeerId ?attributedTo ?sgName WHERE {
    GRAPH ?g {
      {
        <${safeUal}> <${DKG}rootEntity> ?rootEntity .
        <${safeUal}> <${DKG}partOf> ?kc .
      }
      UNION
      {
        <${safeUal}> <${DKG}rootEntity> ?rootEntity .
        BIND(<${safeUal}> AS ?kc)
      }
      ?kc <${DKG}contextGraph> ?contextGraph .
      OPTIONAL { <${safeUal}> <${DKG}privateMerkleRoot> ?privateMerkleRoot }
      OPTIONAL { <${safeUal}> <${DKG}privateTripleCount> ?privateTripleCount }
      OPTIONAL { ?kc <${DKG}accessPolicy> ?accessPolicy }
      OPTIONAL { ?kc <${DKG}publisherPeerId> ?publisherPeerId }
      OPTIONAL { ?kc <${PROV}wasAttributedTo> ?attributedTo }
      OPTIONAL { ?kc <${DKG}subGraphName> ?sgName }
      BIND(CONCAT(STR(?contextGraph), "/_meta") AS ?expectedMetaGraph)
      FILTER(STR(?g) = ?expectedMetaGraph)
    }
    ${buildTrustedRootContextGraphRegistrationFilter('?contextGraph', '?g')}
  }`;
}

/**
 * Parse graph-scoped KA bindings without allowing malformed V2 metadata to
 * fall through to the legacy reader.
 */
export function parseGraphKnowledgeAssetMetadataBindings(
  ual: string,
  rows: readonly GraphKnowledgeAssetMetadataBinding[],
): GraphKnowledgeAssetMetadataParseResult {
  if (rows.length === 0) return { kind: 'absent' };

  const valuesByField = pivotBindings(ual, rows);
  const values = (field: ParsedField): string[] => [
    ...(valuesByField.get(field) ?? []),
  ];
  const requireSingle = (field: ParsedField): string => {
    const candidates = values(field);
    if (candidates.length !== 1) {
      throw new Error(
        `Graph-scoped KA ${ual} has ${candidates.length === 0 ? 'missing' : 'ambiguous'} ${field} metadata`,
      );
    }
    return candidates[0] as string;
  };
  const optionalSingle = (field: MetadataField): string | undefined => {
    const candidates = values(field);
    if (candidates.length > 1) {
      throw new Error(`Graph-scoped KA ${ual} has ambiguous ${field} metadata`);
    }
    return candidates[0];
  };

  const rawScopeVersions = values('scopeVersion');
  if (rawScopeVersions.length === 0) {
    throw new Error(`Graph-scoped KA ${ual} has missing contentScopeVersion metadata`);
  }
  if (rawScopeVersions.length !== 1) {
    throw new Error(`Graph-scoped KA ${ual} has ambiguous contentScopeVersion metadata`);
  }
  const scopeVersion = parseInteger(
    ual,
    rawScopeVersions[0] as string,
    'contentScopeVersion',
  );
  if (scopeVersion === 0n || scopeVersion === 1n) return { kind: 'legacy' };
  if (scopeVersion !== BigInt(GRAPH_KA_CONTENT_SCOPE_VERSION)) {
    throw new Error(`Unsupported KA contentScopeVersion: ${scopeVersion}`);
  }

  const metadataGraph = requireIri(ual, requireSingle('g'), 'metadata graph');
  const metadataUal = requireIri(ual, requireSingle('kaUal'), 'kaUal');
  if (metadataUal !== ual) {
    throw new Error(
      `Graph-scoped KA metadata UAL mismatch: requested ${ual}, found ${metadataUal}`,
    );
  }

  const assertionVersionRaw = decodeBindingValue(
    ual,
    requireSingle('assertionVersion'),
    'assertionVersion',
  );
  const assertionVersion = parseInteger(
    ual,
    requireSingle('assertionVersion'),
    'assertionVersion',
  ).toString();
  if (assertionVersionRaw !== assertionVersion) {
    throw new Error(
      `Graph-scoped KA ${ual} has non-canonical assertionVersion: ${assertionVersionRaw}`,
    );
  }
  const scope = createGraphKnowledgeAssetScope(metadataUal, assertionVersion);
  if (scope.ual !== metadataUal) {
    throw new Error(
      `Graph-scoped KA metadata has non-canonical kaUal: ${metadataUal}`,
    );
  }

  const contextGraphUri = requireIri(
    ual,
    requireSingle('contextGraph'),
    'contextGraph',
  );
  if (!contextGraphUri.startsWith(CONTEXT_GRAPH_PREFIX)) {
    throw new Error(
      `Graph-scoped KA ${ual} has invalid contextGraph metadata: ${contextGraphUri}`,
    );
  }
  const contextGraphId = contextGraphUri.slice(CONTEXT_GRAPH_PREFIX.length);
  const contextGraphValidation = validateContextGraphId(contextGraphId);
  if (!contextGraphValidation.valid) {
    throw new Error(
      `Graph-scoped KA ${ual} has invalid contextGraph metadata: ${contextGraphValidation.reason}`,
    );
  }
  const expectedMetaGraph = contextGraphMetaUri(contextGraphId);
  if (metadataGraph !== expectedMetaGraph) {
    throw new Error(
      `Graph-scoped KA ${ual} metadata graph mismatch: ` +
        `expected ${expectedMetaGraph}, found ${metadataGraph}`,
    );
  }

  const rawSubGraphName = optionalSingle('sgName');
  const subGraphName = rawSubGraphName === undefined
    ? undefined
    : decodeBindingValue(ual, rawSubGraphName, 'subGraphName');
  if (subGraphName !== undefined) {
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) {
      throw new Error(
        `Graph-scoped KA ${ual} has invalid subGraphName: ${validation.reason}`,
      );
    }
  }

  const expectedAssertionGraph = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.VerifiableMemory,
    scope,
    subGraphName,
  );
  const assertionGraph = requireIri(
    ual,
    requireSingle('assertionGraph'),
    'assertionGraph',
  );
  if (assertionGraph !== expectedAssertionGraph) {
    throw new Error(
      `Graph-scoped KA ${ual} assertionGraph mismatch: ` +
        `expected ${expectedAssertionGraph}, found ${assertionGraph}`,
    );
  }

  const publicTripleCount = parseSafeCount(
    ual,
    requireSingle('publicTripleCount'),
    'publicTripleCount',
  );
  const privateTripleCount = parseSafeCount(
    ual,
    requireSingle('privateTripleCount'),
    'privateTripleCount',
  );
  if (publicTripleCount === 0 && privateTripleCount === 0) {
    throw new Error(`Graph-scoped KA ${ual} metadata cannot describe an empty asset`);
  }

  const privateRootCandidates = values('privateMerkleRoot');
  if (privateTripleCount > 0 && privateRootCandidates.length !== 1) {
    throw new Error(
      `Graph-scoped KA ${ual} requires exactly one privateMerkleRoot for private content`,
    );
  }
  if (privateTripleCount === 0 && privateRootCandidates.length !== 0) {
    throw new Error(
      `Graph-scoped KA ${ual} has a privateMerkleRoot without private content`,
    );
  }
  const privateMerkleRoot = privateRootCandidates[0] === undefined
    ? undefined
    : decodeHexBytes32(ual, privateRootCandidates[0]);

  const accessPolicy = decodeAccessPolicy(ual, optionalSingle('accessPolicy'));
  const publisherPeerId = decodeOptionalValue(
    ual,
    optionalSingle('publisherPeerId'),
    'publisherPeerId',
  );
  const attributedTo = decodeOptionalValue(
    ual,
    optionalSingle('attributedTo'),
    'attributedTo',
  );
  const allowedPeers = [
    ...new Set(
      values('allowedPeer').map((raw) =>
        decodeBindingValue(ual, raw, 'allowedPeer')),
    ),
  ];

  return {
    kind: 'graph',
    metadata: {
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      scope,
      ual: scope.ual,
      assertionVersion: scope.assertionVersion,
      assertionGraph,
      metadataGraph,
      contextGraphUri,
      contextGraphId,
      subGraphName,
      publicTripleCount,
      privateTripleCount,
      privateMerkleRoot,
      accessPolicy,
      publisherPeerId,
      attributedTo,
      allowedPeers,
    },
  };
}

function pivotBindings(
  ual: string,
  rows: readonly GraphKnowledgeAssetMetadataBinding[],
): Map<ParsedField, Set<string>> {
  const result = new Map<ParsedField, Set<string>>();
  const add = (field: ParsedField, value: string): void => {
    const existing = result.get(field);
    if (existing) {
      existing.add(value);
    } else {
      result.set(field, new Set([value]));
    }
  };

  for (const row of rows) {
    if (row.g !== undefined) add('g', row.g);

    if ('predicate' in row || 'value' in row) {
      if (typeof row.predicate !== 'string' || typeof row.value !== 'string') {
        throw new Error(`Graph-scoped KA ${ual} has malformed property/value metadata`);
      }
      const field = FIELD_BY_PREDICATE.get(row.predicate);
      if (!field) {
        throw new Error(
          `Graph-scoped KA ${ual} has unexpected metadata predicate: ${row.predicate}`,
        );
      }
      add(field, row.value);
      continue;
    }

    for (const field of METADATA_FIELDS) {
      const value = row[field];
      if (value !== undefined) add(field, value);
    }
  }

  return result;
}

function decodeBindingValue(ual: string, raw: string, field: string): string {
  if (raw.length === 0) {
    throw new Error(`Graph-scoped KA ${ual} has invalid ${field}: (empty)`);
  }
  if (!raw.startsWith('"')) return raw;

  const literal = parseRdfLiteralTerm(raw);
  if (!literal) {
    throw new Error(`Graph-scoped KA ${ual} has invalid ${field}: ${raw}`);
  }
  return literal.value;
}

function parseInteger(ual: string, raw: string, field: string): bigint {
  const value = decodeBindingValue(ual, raw, field);
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Graph-scoped KA ${ual} has invalid ${field}: ${raw}`);
  }
  return BigInt(value);
}

function parseSafeCount(ual: string, raw: string, field: string): number {
  const value = parseInteger(ual, raw, field);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Graph-scoped KA ${ual} has invalid ${field}: ${value}`);
  }
  return Number(value);
}

function requireIri(ual: string, raw: string, field: string): string {
  if (!isSafeIri(raw)) {
    throw new Error(`Graph-scoped KA ${ual} has invalid ${field}: ${raw}`);
  }
  return raw;
}

function decodeHexBytes32(ual: string, raw: string): Uint8Array {
  const decoded = decodeBindingValue(ual, raw, 'privateMerkleRoot');
  const hex = decoded.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `Graph-scoped KA ${ual} privateMerkleRoot must be exactly 32 bytes of hexadecimal data`,
    );
  }
  const pairs = hex.match(/.{2}/g);
  if (!pairs || pairs.length !== 32) {
    throw new Error(
      `Graph-scoped KA ${ual} privateMerkleRoot must be exactly 32 bytes of hexadecimal data`,
    );
  }
  return Uint8Array.from(pairs.map((pair) => Number.parseInt(pair, 16)));
}

function decodeAccessPolicy(
  ual: string,
  raw: string | undefined,
): GraphKnowledgeAssetAccessPolicy | undefined {
  if (raw === undefined) return undefined;
  const value = decodeBindingValue(ual, raw, 'accessPolicy');
  if (value !== 'public' && value !== 'ownerOnly' && value !== 'allowList') {
    throw new Error(`Graph-scoped KA ${ual} has invalid accessPolicy: ${value}`);
  }
  return value;
}

function decodeOptionalValue(
  ual: string,
  raw: string | undefined,
  field: string,
): string | undefined {
  return raw === undefined ? undefined : decodeBindingValue(ual, raw, field);
}
