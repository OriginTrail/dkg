import { validateSubGraphName } from '@origintrail-official/dkg-core';
import {
  workspacePublicQuadsDigest, SWM_PREDICATES as P,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { admitSharedMemoryMetadata } from './shared-memory-metadata-admission.js';
import {
  projectStrictSwmRecovery,
  type GraphScopedSwmRecoveryDescriptor,
} from './shared-memory-metadata-projections.js';
import { swmRecoveryLiteralValue as stripLiteral } from './shared-memory-metadata-records.js';
import {
  formatCanonicalRdfLiteralTerm,
  parseRdfLiteralTerm,
} from '@origintrail-official/dkg-rdf-utils';

export type { GraphScopedSwmRecoveryDescriptor } from './shared-memory-metadata-projections.js';

const CONTENT_SCOPE_VERSION = P.contentScopeVersion;
const KA_UAL = P.kaUal;
const ASSERTION_VERSION = P.assertionVersion;
const SHARE_OPERATION_ID = P.shareOperationId;
const CONTEXT_GRAPH_ID = P.contextGraphId;
const PUBLIC_QUADS_DIGEST = P.publicQuadsDigest;
const PUBLIC_QUADS_COUNT = P.publicQuadsCount;
const PRIVATE_TRIPLE_COUNT = P.privateTripleCount;
const PRIVATE_MERKLE_ROOT = P.privateMerkleRoot;
const ACCESS_POLICY = P.accessPolicy;
const ALLOWED_PEER = P.allowedPeer;
const SUB_GRAPH_NAME = P.subGraphName;

export interface MaterializedGraphScopedSwmRecoveryAsset
  extends GraphScopedSwmRecoveryDescriptor {
  readonly quads: readonly Quad[];
}

/**
 * Recoveries run immediately after admission, before the durable subgraph
 * registration projection is guaranteed to have landed locally. The
 * authenticated responder has already filtered SWM lanes to its registered
 * subgraphs, so bootstrap syntactically valid lane names from the response and
 * retain the local known-child exclusion as the final collision guard.
 */
export function discoverSwmRecoverySubGraphNames(params: {
  readonly contextGraphId: string;
  readonly metaQuads: readonly Quad[];
  readonly excludedSubGraphNames?: readonly string[];
}): string[] {
  const prefix = `did:dkg:context-graph:${params.contextGraphId}/`;
  const suffix = '/_shared_memory_meta';
  const excluded = new Set(params.excludedSubGraphNames ?? []);
  const names = new Set<string>();
  for (const quad of params.metaQuads) {
    const graph = quad.graph;
    if (!graph.startsWith(prefix) || !graph.endsWith(suffix)) continue;
    const name = graph.slice(prefix.length, -suffix.length);
    if (!name || excluded.has(name) || !validateSubGraphName(name).valid) continue;
    names.add(name);
  }
  return [...names].sort();
}

/**
 * Parse and validate the active graph-scoped SWM heads in a complete recovery
 * metadata snapshot. Every accepted descriptor is bound to one deterministic
 * UAL/version graph and one same-graph WorkspaceOperation commitment.
 */
export function parseGraphScopedSwmRecoveryDescriptors(params: {
  readonly contextGraphId: string;
  readonly metaQuads: readonly Quad[];
  readonly registeredSubGraphNames?: readonly string[];
  readonly excludedSubGraphNames?: readonly string[];
}): GraphScopedSwmRecoveryDescriptor[] {
  const excluded = new Set(params.excludedSubGraphNames ?? []);
  return projectStrictSwmRecovery(admitSharedMemoryMetadata(params.metaQuads, {
    kind: 'context', contextGraphId: params.contextGraphId,
    registeredSubGraphNames: new Set((params.registeredSubGraphNames ?? []).filter(name => !excluded.has(name))),
  }));
}

/**
 * Collapse only the current-head pointer rows covered by parsed descriptors.
 * Superseded operation subjects may remain as immutable history, but a head
 * itself must name exactly one operation or LIMIT-1 readers become arbitrary.
 */
export function canonicalizeGraphScopedSwmHeadRows(params: {
  readonly metaQuads: readonly Quad[];
  readonly descriptors: readonly GraphScopedSwmRecoveryDescriptor[];
}): Quad[] {
  const selectedByHead = new Map(
    params.descriptors.map((descriptor) => [
      `${descriptor.metaGraph}\u0000${descriptor.headSubject}`,
      descriptor.shareOperationId,
    ]),
  );
  return params.metaQuads.filter((row) => {
    if (row.predicate !== SHARE_OPERATION_ID) return true;
    const selected = selectedByHead.get(`${row.graph}\u0000${row.subject}`);
    return selected === undefined || stripLiteral(row.object).trim() === selected;
  });
}

const PROV_WAS_ATTRIBUTED_TO = P.wasAttributedTo;
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

/**
 * GH#2273 — the predicates over which two share operations for the same KA are
 * compared for IDENTITY-preserving decisions ("is this the same share under a
 * different operation id?"). An explicit ALLOW-LIST, not a deny-list: several
 * operation rows embed the operation id in their VALUE (`publicSnapshotGraph`
 * is `did:…/_shared_memory_snapshots/…/<shareOperationId>/ka`), and others are
 * legitimately per-node (`publisherPeerId` names whichever node persisted the
 * operation, `publishedAt` its clock) — a deny-list that misses any of those
 * makes byte-identical shares compare unequal and silently disables every
 * prefer-local decision built on it.
 *
 * `required` rows must be present on BOTH sides or the key is null (callers
 * treat null as NOT equivalent — fail toward remote authority, never toward
 * preserving unprovable equivalence). `compared` rows participate whenever
 * present; a row present on one side only makes the keys differ, which is the
 * correct outcome (e.g. an added accessPolicy or allowedPeer IS a change the
 * stale-intent machinery must see).
 *
 * CROSS-STORE IDENTITY policy — deliberately NOT the same model as the
 * parser's `samePayloadByteEquivalenceKey` (see the resolver above): that
 * key byte-compares candidates from ONE payload and throws on ambiguity;
 * this one compares wire rows against store read-backs and therefore
 * normalizes lexical forms over an explicit allow-list. A new operation
 * predicate is classified per policy: byte-safe rows join the parser key
 * automatically (it is predicate-agnostic); it joins THIS key only if it is
 * part of share identity under the allow-list rationale above. Unification
 * into one policy module = follow-up F3.
 */
export const OPERATION_IDENTITY_PREDICATES = {
  required: [
    CONTEXT_GRAPH_ID,
    CONTENT_SCOPE_VERSION,
    KA_UAL,
    ASSERTION_VERSION,
    PUBLIC_QUADS_COUNT,
    PUBLIC_QUADS_DIGEST,
    PRIVATE_TRIPLE_COUNT,
  ],
  compared: [
    PRIVATE_MERKLE_ROOT,
    ACCESS_POLICY,
    ALLOWED_PEER,
    SUB_GRAPH_NAME,
    PROV_WAS_ATTRIBUTED_TO,
  ],
} as const;

/**
 * One side of the comparison is WIRE quads (descriptor metadata) and the other
 * is rows READ BACK from the triple store, so object terms are canonicalized
 * before keying. Term semantics (plain ≡ xsd:string, escaping, language tags,
 * datatype brackets) are delegated to the shared RDF literal parser/formatter
 * — the same rules the storage and hash paths recognize — with ONE narrower
 * identity-specific rule layered on top: `^^xsd:integer` values compare by
 * numeric value, so a store that canonicalizes the lexical form cannot break
 * key equality. An unparseable literal keys on its raw form (both sides would
 * have to be byte-identical to match — fail toward inequality).
 */
function normalizeIdentityObject(object: string): string {
  if (!object.startsWith('"')) return `iri\u0000${object}`;
  const literal = parseRdfLiteralTerm(object);
  if (literal === null) return `raw\u0000${object}`;
  if (literal.kind === 'typed' && literal.datatype === XSD_INTEGER) {
    try {
      return `lit\u0000${formatCanonicalRdfLiteralTerm({
        kind: 'typed',
        value: BigInt(literal.value).toString(),
        datatype: XSD_INTEGER,
      })}`;
    } catch {
      // Non-numeric lexical form: fall through to the shared canonical form.
    }
  }
  return `lit\u0000${formatCanonicalRdfLiteralTerm(literal)}`;
}

/**
 * Subject- and graph-independent identity key for one share operation's rows,
 * or null when any required identity row is absent. Two operations with equal
 * keys are the SAME share (same content commitment, same access envelope, same
 * author) under different operation ids — the residue storage-ACK persistence
 * and originator persistence legitimately produce for one share.
 */
export function operationIdentityKey(rows: readonly Quad[]): string | null {
  const parts = new Set<string>();
  const seenPredicates = new Set<string>();
  const allowed = new Set<string>([
    ...OPERATION_IDENTITY_PREDICATES.required,
    ...OPERATION_IDENTITY_PREDICATES.compared,
  ]);
  for (const row of rows) {
    if (!allowed.has(row.predicate)) continue;
    // accessPolicy is keyed by its EFFECTIVE value below, not raw presence.
    if (row.predicate === ACCESS_POLICY) continue;
    seenPredicates.add(row.predicate);
    parts.add(`${row.predicate}\u0000${normalizeIdentityObject(row.object)}`);
  }
  for (const predicate of OPERATION_IDENTITY_PREDICATES.required) {
    if (!seenPredicates.has(predicate)) return null;
  }
  // EFFECTIVE access policy: an absent row and an explicit default row are
  // the SAME policy under the publisher's own rule
  // (`accessPolicy ?? (privateTripleCount > 0 ? 'ownerOnly' : 'public')` —
  // async-lift-publish-options / dkg-publisher), and older stored operations
  // legitimately omit the row. Keying raw presence made such pairs compare
  // unequal, refusing preservation for a semantically identical share —
  // reintroducing the stale-intent rotation for exactly the old-metadata
  // interop case. Non-default and allowList changes still differ (the
  // explicit value participates verbatim), and allowedPeer rows are keyed
  // separately as before.
  const explicitPolicies = new Set(rows
    .filter((row) => row.predicate === ACCESS_POLICY)
    .map((row) => stripLiteral(row.object).trim()));
  let effectivePolicy: string;
  if (explicitPolicies.size > 1) {
    // Multi-valued policy rows: equivalence is unprovable — fail toward
    // remote authority.
    return null;
  }
  if (explicitPolicies.size === 1) {
    effectivePolicy = [...explicitPolicies][0]!;
  } else {
    // Compare count VALUES, not lexical forms ("0" vs "00" is one count).
    const privateCountValues = new Set<string>();
    for (const row of rows) {
      if (row.predicate !== PRIVATE_TRIPLE_COUNT) continue;
      try {
        privateCountValues.add(BigInt(stripLiteral(row.object).trim()).toString());
      } catch {
        return null;
      }
    }
    if (privateCountValues.size !== 1) return null;
    effectivePolicy = BigInt([...privateCountValues][0]!) > 0n ? 'ownerOnly' : 'public';
  }
  parts.add(`${ACCESS_POLICY}\u0000${effectivePolicy}`);
  return [...parts].sort().join('\u0001');
}

/** Load and re-verify one immutable snapshot, then stamp its exact SWM graph. */
export async function materializeGraphScopedSwmRecoveryAsset(params: {
  readonly descriptor: GraphScopedSwmRecoveryDescriptor;
  readonly fetchedDataQuads: readonly Quad[];
  readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
}): Promise<MaterializedGraphScopedSwmRecoveryAsset> {
  const descriptor = params.descriptor;
  let raw: Quad[] | null;
  if (descriptor.publicSnapshotGraph) {
    raw = params.fetchedDataQuads
      .filter((quad) => quad.graph === descriptor.publicSnapshotGraph)
      .map((quad) => ({ ...quad, graph: '' }));
  } else {
    if (!params.publicSnapshotStore || !descriptor.publicSnapshotRef) {
      throw new Error(`Graph-scoped SWM recovery requires a public snapshot store for ${descriptor.kaUal}`);
    }
    raw = await params.publicSnapshotStore.getSnapshot(descriptor.publicSnapshotRef);
  }
  if (!raw) {
    throw new Error(`Graph-scoped SWM snapshot is missing for ${descriptor.kaUal}`);
  }
  const normalized = raw.map((quad) => ({ ...quad, graph: '' }));
  const actualDigest = workspacePublicQuadsDigest(normalized);
  if (
    normalized.length !== descriptor.publicQuadsCount
    || actualDigest !== descriptor.publicQuadsDigest
  ) {
    throw new Error(
      `Graph-scoped SWM snapshot failed integrity for ${descriptor.kaUal}: ` +
      `expected ${descriptor.publicQuadsDigest}/${descriptor.publicQuadsCount}, ` +
      `got ${actualDigest}/${normalized.length}`,
    );
  }
  return {
    ...descriptor,
    quads: normalized.map((quad) => ({ ...quad, graph: descriptor.assertionGraph })),
  };
}
