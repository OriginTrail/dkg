// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '@origintrail-official/dkg-storage';
import { formatCanonicalRdfLiteralTerm, parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { stripMetadataLiteral as stripLiteral } from './metadata-literal.js';
const DKG = 'http://dkg.io/ontology/';

const CONTENT_SCOPE_VERSION = `${DKG}contentScopeVersion`;
const KA_UAL = `${DKG}kaUal`;
const ASSERTION_VERSION = `${DKG}assertionVersion`;
const CONTEXT_GRAPH_ID = `${DKG}contextGraphId`;
const PUBLIC_QUADS_DIGEST = `${DKG}publicQuadsDigest`;
const PUBLIC_QUADS_COUNT = `${DKG}publicQuadsCount`;
const PRIVATE_TRIPLE_COUNT = `${DKG}privateTripleCount`;
const PRIVATE_MERKLE_ROOT = `${DKG}privateMerkleRoot`;
const ACCESS_POLICY = `${DKG}accessPolicy`;
const ALLOWED_PEER = `${DKG}allowedPeer`;
const SUB_GRAPH_NAME = `${DKG}subGraphName`;

const PROV_WAS_ATTRIBUTED_TO = 'http://www.w3.org/ns/prov#wasAttributedTo';
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
 * parser's `samePayloadOperationEquivalenceKey` above: that key compares
 * decoded candidates from ONE payload and throws on ambiguity;
 * this one compares wire rows against store read-backs and therefore
 * normalizes lexical forms over an explicit allow-list. A new operation
 * predicate is classified per policy: byte-safe rows join the parser key
 * automatically through the decoder; it joins THIS key only if it is part of
 * share identity under the allow-list rationale above. The two policies stay
 * explicit here so cross-store normalization cannot leak into publisher code.
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
export function normalizeIdentityObject(object: string): string {
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
  const values = (predicate: string): string[] => [...new Set(rows
    .filter((row) => row.predicate === predicate)
    .map((row) => row.object))];
  const single = (predicate: string, required: boolean): string | null | undefined => {
    const found = values(predicate);
    if (found.length > 1 || (required && found.length === 0)) return null;
    return found[0];
  };
  const required = Object.fromEntries(OPERATION_IDENTITY_PREDICATES.required.map((predicate) => (
    [predicate, single(predicate, true)]
  )));
  if (Object.values(required).some((value) => value === null)) return null;
  const publicTripleCount = Number(stripLiteral(required[PUBLIC_QUADS_COUNT]!).trim());
  const privateTripleCount = Number(stripLiteral(required[PRIVATE_TRIPLE_COUNT]!).trim());
  if (
    !Number.isSafeInteger(publicTripleCount)
    || publicTripleCount < 0
    || !Number.isSafeInteger(privateTripleCount)
    || privateTripleCount < 0
  ) return null;
  const privateMerkleRoot = single(PRIVATE_MERKLE_ROOT, false);
  const subGraphName = single(SUB_GRAPH_NAME, false);
  const attributedTo = values(PROV_WAS_ATTRIBUTED_TO).map(normalizeIdentityObject);
  if (privateMerkleRoot === null || subGraphName === null) return null;
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
  // CROSS-STORE policy: own every RDF lexical normalization here. This key is
  // deliberately separate from samePayloadOperationEquivalenceKey because it
  // compares wire rows with store read-backs and excludes transport provenance.
  return JSON.stringify({
    publicQuadsDigest: stripLiteral(required[PUBLIC_QUADS_DIGEST]!).trim().toLowerCase(),
    publicTripleCount,
    ...(privateMerkleRoot === undefined
      ? {}
      : { privateMerkleRoot: stripLiteral(privateMerkleRoot).trim().toLowerCase() }),
    privateTripleCount,
    accessPolicy: effectivePolicy as 'public' | 'ownerOnly' | 'allowList',
    allowedPeers: [...new Set(values(ALLOWED_PEER)
      .map((value) => stripLiteral(value).trim()))].sort(),
    recoveryIdentity: {
      contextGraphId: normalizeIdentityObject(required[CONTEXT_GRAPH_ID]!),
      contentScopeVersion: normalizeIdentityObject(required[CONTENT_SCOPE_VERSION]!),
      kaUal: normalizeIdentityObject(required[KA_UAL]!),
      assertionVersion: normalizeIdentityObject(required[ASSERTION_VERSION]!),
      ...(subGraphName === undefined
        ? {}
        : { subGraphName: normalizeIdentityObject(subGraphName) }),
      authorIdentities: [...new Set(attributedTo)].sort(),
    },
  });
}

