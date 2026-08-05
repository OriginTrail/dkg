// RFC-001 Phase 5 — assertion seal vocabulary.
//
// When an agent finalizes an assertion, the daemon writes a small
// block of metadata triples to the context-graph `_meta` graph,
// keyed by the assertion URI. Those triples carry the cryptographic
// commitment (merkle root + EIP-712 author signature + chain
// binding) that on-chain `KnowledgeAssetsV10.publish(...)` later
// consumes verbatim.
//
// The seal MUST NOT be re-derived at publish-time — that's the
// architectural invariant this module preserves: shape doesn't
// change as the assertion moves WM → SWM → VM. Publishing reads the
// seal from `_meta`, validates it sanity-checks against the actual
// quads, and forwards the pre-computed `(merkleRoot, signature,
// authorAddress)` to KAv10.
//
// Predicate URIs follow the `http://dkg.io/ontology/` namespace
// already used by `_meta` rows for file-import provenance — see
// `packages/cli/src/daemon/routes/assertion.ts` rows 14-20. The
// merkle root is stored as `xsd:hexBinary` (lexical form WITHOUT a
// `0x` prefix per spec); addresses and tx hashes ride as plain
// string literals; sizes/IDs as `xsd:integer`.

import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  LEGACY_ROOT_CONTENT_SCOPE_VERSION,
  createGraphKnowledgeAssetScope,
  parseDeterministicKnowledgeAssetUal,
} from './ka-content-scope.js';
import { parseContextGraphAssertionUri } from './constants.js';

const ONT = 'http://dkg.io/ontology/';

/**
 * Predicates written by `/api/knowledge-assets/:name/wm/finalize` (sealed at
 * the moment the agent commits the assertion's content to a chain).
 */
export const ASSERTION_SEAL_PREDICATES = {
  /** Flat KC merkle root over the assertion's quads (xsd:hexBinary, no `0x` prefix). */
  ASSERTION_MERKLE_ROOT: `${ONT}assertionMerkleRoot`,
  /** Recovered EIP-712 author EOA / wallet-of-record (checksummed string literal). */
  AUTHOR_ADDRESS: `${ONT}authorAddress`,
  /** Compact-sig `r` component (xsd:hexBinary, no `0x` prefix). */
  AUTHOR_ATTESTATION_R: `${ONT}authorAttestationR`,
  /** Compact-sig `vs` component (xsd:hexBinary, no `0x` prefix). */
  AUTHOR_ATTESTATION_VS: `${ONT}authorAttestationVS`,
  /** Author scheme version literal (xsd:integer; v1 = single-key ECDSA). */
  AUTHOR_SCHEME_VERSION: `${ONT}authorSchemeVersion`,
  /** Chain id the EIP-712 domain was bound to (xsd:integer). */
  ASSERTED_AT_CHAIN_ID: `${ONT}assertedAtChainId`,
  /** `KnowledgeAssetsV10` deployment address the sig commits to (string literal, checksummed). */
  ASSERTED_AT_KAV10_ADDRESS: `${ONT}assertedAtKav10Address`,
  /**
   * OT-RFC-43 §F2 — the packed reservedKaId `(uint160(author)<<96)|uint96(number)`
   * bound into the EIP-712 AuthorAttestation digest. Persisted so the idempotent
   * re-finalize rebuild and the publish/mint reuse the SAME id the signature
   * committed to (xsd:integer; the 256-bit value rides as an arbitrary-precision
   * integer literal).
   */
  RESERVED_KA_ID: `${ONT}reservedKaId`,
  /** Daemon-clock dateTime when the seal was written (xsd:dateTime). */
  ASSERTION_FINALIZED_AT: `${ONT}assertionFinalizedAt`,
  /** Rootless content-scope discriminator. Missing means legacy v1. */
  CONTENT_SCOPE_VERSION: `${ONT}contentScopeVersion`,
  /** Canonical deterministic graph-scoped KA UAL. */
  KA_UAL: `${ONT}kaUal`,
  /** One-based assertion/Merkle-root index. */
  ASSERTION_VERSION: `${ONT}assertionVersion`,
  /** Complete public RDF triple count for the graph-scoped assertion. */
  PUBLIC_TRIPLE_COUNT: `${ONT}publicTripleCount`,
  /** Single KA-level private Merkle commitment (xsd:hexBinary). */
  PRIVATE_MERKLE_ROOT: `${ONT}privateMerkleRoot`,
  /** Number of private RDF triples committed by PRIVATE_MERKLE_ROOT. */
  PRIVATE_TRIPLE_COUNT: `${ONT}privateTripleCount`,
  /**
   * Root entity bound to the seal (multi-valued). Recorded at finalize
   * time so that `publishFromFinalizedAssertion` can scope the SWM
   * SPARQL CONSTRUCT to exactly this assertion's quads instead of
   * bundling everything currently in shared memory. The set is
   * derived from `skolemizeByEntity(filteredQuads).keys()` over the same
   * reserved-subject-filtered quads `assertionPromote` writes, so the
   * post-promote SWM lookup produces the same merkle leaves the seal
   * was signed over. IRI literal — emitted as `<rootEntity>` (object
   * IRI), not a string literal.
   */
  ASSERTION_ROOT_ENTITY: `${ONT}assertionRootEntity`,
  /**
   * OT-RFC-43 §10.1 — the honestly-named successor to ASSERTION_ROOT_ENTITY
   * (these hold graph entities, not Merkle roots). Dual-WRITTEN alongside the
   * legacy predicate during the rename migration; readers continue to read the
   * legacy name (always present) until a later release switches the dual-read
   * and drops the legacy write. Adding this `_meta` quad does NOT affect the
   * seal's integrity: the assertion merkle is over the DATA quads and the
   * EIP-712 author attestation signs a fixed struct (merkleRoot, author, chain
   * binding) — not the entity-list quads.
   */
  ASSERTION_ENTITY: `${ONT}assertionEntity`,
} as const;

/**
 * Predicates written by named VM publish lifecycle routes after a successful
 * on-chain publish. These are receipts; they don't affect the seal's validity.
 */
export const ASSERTION_PUBLISH_RECEIPT_PREDICATES = {
  /** Transaction hash of the KAv10 publish (string literal). */
  PUBLISHED_AT_TX: `${ONT}publishedAtTx`,
  /** Block number (xsd:integer). */
  PUBLISHED_AT_BLOCK: `${ONT}publishedAtBlock`,
  /**
   * Knowledge collection id assigned by `KnowledgeCollectionStorage`
   * (xsd:integer). RFC ka-metadata-trim Phase 2: NO LONGER WRITTEN — it was
   * the third resident copy of the on-chain id, which is queryable as
   * `dkg:batchId` on the UAL subject. The constant stays for read-both
   * consumers resolving rows written by older nodes (node-ui receipt hook).
   */
  PUBLISHED_AT_KA_ID: `${ONT}publishedAtKaId`,
} as const;

/**
 * Strip the optional `0x` prefix from a hex string and lowercase
 * the digits. Used to produce `xsd:hexBinary` lexical forms.
 */
function hexBinaryLexical(hex: string): string {
  const trimmed = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  return trimmed.toLowerCase();
}

/**
 * Build the full set of `_meta` quads emitted at finalize time.
 *
 * Caller supplies the resolved `assertionUri` (subject), the `_meta`
 * graph URI for the context graph (typically
 * `contextGraphMetaUri(contextGraphId)`), and the seal payload.
 * Every quad is pinned to the `metaGraph`. NOTE: the seal does NOT ride
 * SWM live gossip (that path force-rewrites quads onto the KA's data graph
 * and never carried seal fields); its peer-to-peer transport is the durable
 * `_meta` sync lane. See GH#1778.
 */
interface AssertionSealBuildBaseArgs {
  assertionUri: string;
  metaGraph: string;
  merkleRoot: Uint8Array;
  authorAddress: string;
  authorAttestationR: Uint8Array;
  authorAttestationVS: Uint8Array;
  authorSchemeVersion: number;
  chainId: bigint;
  kav10Address: string;
  /** OT-RFC-43 §F2 — the packed id bound into the AuthorAttestation digest. */
  reservedKaId: bigint;
  finalizedAtIso: string;
}

export type AssertionSealBuildArgs = AssertionSealBuildBaseArgs & (
  | {
      /** Missing/one keeps the deployed root-scoped read-only wire shape. */
      contentScopeVersion?: typeof LEGACY_ROOT_CONTENT_SCOPE_VERSION;
      rootEntities: ReadonlyArray<string>;
      kaUal?: never;
      assertionVersion?: never;
      publicTripleCount?: never;
    }
  | {
      contentScopeVersion: typeof GRAPH_KA_CONTENT_SCOPE_VERSION;
      kaUal: string;
      assertionVersion: string | number | bigint;
      publicTripleCount: number;
      privateMerkleRoot?: Uint8Array;
      privateTripleCount: number;
      rootEntities?: never;
    }
);

export function buildAssertionSealQuads(args: AssertionSealBuildArgs): Array<{ subject: string; predicate: string; object: string; graph: string }> {
  if (args.merkleRoot.length !== 32) {
    throw new Error(`merkleRoot must be 32 bytes, got ${args.merkleRoot.length}`);
  }
  if (args.authorAttestationR.length !== 32) {
    throw new Error(`authorAttestationR must be 32 bytes, got ${args.authorAttestationR.length}`);
  }
  if (args.authorAttestationVS.length !== 32) {
    throw new Error(`authorAttestationVS must be 32 bytes, got ${args.authorAttestationVS.length}`);
  }
  let graphScope: ReturnType<typeof createGraphKnowledgeAssetScope> | undefined;
  let legacyRootEntities: ReadonlyArray<string> = [];
  let graphPublicTripleCount: number | undefined;
  let graphPrivateTripleCount: number | undefined;
  let graphPrivateMerkleRoot: Uint8Array | undefined;
  if (args.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION) {
    graphScope = createGraphKnowledgeAssetScope(args.kaUal, args.assertionVersion);
    graphPublicTripleCount = args.publicTripleCount;
    graphPrivateTripleCount = args.privateTripleCount;
    graphPrivateMerkleRoot = args.privateMerkleRoot;
    if (!Number.isSafeInteger(graphPublicTripleCount) || graphPublicTripleCount < 0) {
      throw new Error(
        `Graph-scoped assertion publicTripleCount must be a non-negative safe integer, got ${graphPublicTripleCount}`,
      );
    }
    if (!Number.isSafeInteger(graphPrivateTripleCount) || graphPrivateTripleCount < 0) {
      throw new Error(
        `Graph-scoped assertion privateTripleCount must be a non-negative safe integer, got ${graphPrivateTripleCount}`,
      );
    }
    if (graphPublicTripleCount === 0 && graphPrivateTripleCount === 0) {
      throw new Error('Graph-scoped assertion must contain at least one public or private triple');
    }
    if (graphPrivateTripleCount > 0 && graphPrivateMerkleRoot?.length !== 32) {
      throw new Error(
        'Graph-scoped assertion with private triples requires one 32-byte privateMerkleRoot',
      );
    }
    if (graphPrivateTripleCount === 0 && graphPrivateMerkleRoot !== undefined) {
      throw new Error(
        'Graph-scoped assertion privateMerkleRoot requires a positive privateTripleCount',
      );
    }
  } else {
    legacyRootEntities = args.rootEntities;
    if (legacyRootEntities.length === 0) {
      throw new Error('rootEntities must be non-empty: the seal must commit to at least one root entity');
    }
  }
  const merkleRootHex = bytesToHexLower(args.merkleRoot);
  const rHex = bytesToHexLower(args.authorAttestationR);
  const vsHex = bytesToHexLower(args.authorAttestationVS);

  const xsdHexBinary = '<http://www.w3.org/2001/XMLSchema#hexBinary>';
  const xsdInteger = '<http://www.w3.org/2001/XMLSchema#integer>';
  const xsdDateTime = '<http://www.w3.org/2001/XMLSchema#dateTime>';

  const quad = (predicate: string, objectLiteral: string) => ({
    subject: args.assertionUri,
    predicate,
    object: objectLiteral,
    graph: args.metaGraph,
  });

  // OT-RFC-43 §10.1 — dual-write the entity list under BOTH the legacy
  // dkg:assertionRootEntity and the new dkg:assertionEntity so a mixed fleet
  // (and the dual-read follow-up) resolves either name.
  const rootEntityQuads = legacyRootEntities.flatMap((root) => {
    if (UNSAFE_IRI_CHARS.test(root) || root.length === 0) {
      throw new Error(`Unsafe rootEntity literal: ${root}`);
    }
    return [
      {
        subject: args.assertionUri,
        predicate: ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY,
        object: `<${root}>`,
        graph: args.metaGraph,
      },
      {
        subject: args.assertionUri,
        predicate: ASSERTION_SEAL_PREDICATES.ASSERTION_ENTITY,
        object: `<${root}>`,
        graph: args.metaGraph,
      },
    ];
  });

  const contentScopeQuads = graphScope ? [
    quad(
      ASSERTION_SEAL_PREDICATES.CONTENT_SCOPE_VERSION,
      `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^${xsdInteger}`,
    ),
    quad(ASSERTION_SEAL_PREDICATES.KA_UAL, `<${graphScope.ual}>`),
    quad(
      ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION,
      `"${graphScope.assertionVersion}"^^${xsdInteger}`,
    ),
    quad(
      ASSERTION_SEAL_PREDICATES.PUBLIC_TRIPLE_COUNT,
      `"${graphPublicTripleCount}"^^${xsdInteger}`,
    ),
    quad(
      ASSERTION_SEAL_PREDICATES.PRIVATE_TRIPLE_COUNT,
      `\"${graphPrivateTripleCount}\"^^${xsdInteger}`,
    ),
    ...(graphPrivateMerkleRoot ? [quad(
      ASSERTION_SEAL_PREDICATES.PRIVATE_MERKLE_ROOT,
      `\"${bytesToHexLower(graphPrivateMerkleRoot)}\"^^${xsdHexBinary}`,
    )] : []),
  ] : [];

  return [
    quad(ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT, `"${merkleRootHex}"^^${xsdHexBinary}`),
    quad(ASSERTION_SEAL_PREDICATES.AUTHOR_ADDRESS, JSON.stringify(args.authorAddress)),
    quad(ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_R, `"${rHex}"^^${xsdHexBinary}`),
    quad(ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_VS, `"${vsHex}"^^${xsdHexBinary}`),
    quad(
      ASSERTION_SEAL_PREDICATES.AUTHOR_SCHEME_VERSION,
      `"${args.authorSchemeVersion}"^^${xsdInteger}`,
    ),
    quad(
      ASSERTION_SEAL_PREDICATES.ASSERTED_AT_CHAIN_ID,
      `"${args.chainId.toString()}"^^${xsdInteger}`,
    ),
    quad(
      ASSERTION_SEAL_PREDICATES.ASSERTED_AT_KAV10_ADDRESS,
      JSON.stringify(args.kav10Address),
    ),
    quad(
      ASSERTION_SEAL_PREDICATES.RESERVED_KA_ID,
      `"${args.reservedKaId.toString()}"^^${xsdInteger}`,
    ),
    quad(
      ASSERTION_SEAL_PREDICATES.ASSERTION_FINALIZED_AT,
      `"${args.finalizedAtIso}"^^${xsdDateTime}`,
    ),
    ...contentScopeQuads,
    ...rootEntityQuads,
  ];
}

// Subset of `assertSafeIri`'s reject set, inlined to keep the seal
// module dependency-free. Mirrors `core/sparql-safe.ts:UNSAFE_IRI_CHARS`
// so that any rootEntity that passes here is also safe to interpolate
// into the SPARQL `VALUES` clause inside `_loadSelectedSWMQuads`.
const UNSAFE_IRI_CHARS = /[<>"{}|\\^`\x00-\x20]/;

/**
 * Build the on-chain receipt quads written after a successful
 * publish. Same subject/graph as the seal so a downstream consumer
 * can fetch one self-contained block.
 */
export function buildAssertionPublishReceiptQuads(args: {
  assertionUri: string;
  metaGraph: string;
  txHash: string;
  blockNumber: bigint;
  /**
   * @deprecated RFC ka-metadata-trim Phase 2 — accepted for caller
   * compatibility but no longer persisted: the on-chain id is queryable as
   * `dkg:batchId` on the UAL subject; readers of the legacy
   * `dkg:publishedAtKaId` row are read-both.
   */
  kaId?: bigint;
}): Array<{ subject: string; predicate: string; object: string; graph: string }> {
  const xsdInteger = '<http://www.w3.org/2001/XMLSchema#integer>';
  return [
    {
      subject: args.assertionUri,
      predicate: ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_TX,
      object: JSON.stringify(args.txHash),
      graph: args.metaGraph,
    },
    {
      subject: args.assertionUri,
      predicate: ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_BLOCK,
      object: `"${args.blockNumber.toString()}"^^${xsdInteger}`,
      graph: args.metaGraph,
    },
  ];
}

/**
 * The deserialized seal — what publish needs to forward verbatim
 * to KAv10. Returned by {@link parseAssertionSealQuads}.
 */
export interface AssertionSeal {
  merkleRoot: Uint8Array;
  authorAddress: string;
  authorAttestationR: Uint8Array;
  authorAttestationVS: Uint8Array;
  authorSchemeVersion: number;
  chainId: bigint;
  kav10Address: string;
  /**
   * OT-RFC-43 §F2 — the packed id the AuthorAttestation digest bound. Optional:
   * absent on seals that predate the binding; consumers fall back to the
   * lifecycle-URN kaId when undefined.
   */
  reservedKaId?: bigint;
  finalizedAtIso: string;
  /** Missing on disk is normalized to legacy v1 by the parser. */
  contentScopeVersion:
    | typeof LEGACY_ROOT_CONTENT_SCOPE_VERSION
    | typeof GRAPH_KA_CONTENT_SCOPE_VERSION;
  /** Present only for graph-scoped v2 seals. */
  kaUal?: string;
  /** Present only for graph-scoped v2 seals. */
  assertionVersion?: string;
  /** Present only for graph-scoped v2 seals. */
  publicTripleCount?: number;
  /** Present only for graph-scoped v2 seals with private content. */
  privateMerkleRoot?: Uint8Array;
  /** Present only for graph-scoped v2 seals. */
  privateTripleCount?: number;
  /**
   * Root entities the seal commits to. Set at finalize time, used at
   * publish time to scope the SWM SPARQL CONSTRUCT (so a named publish
   * does not bundle other content currently sitting in shared memory).
   */
  rootEntities: string[];
}

/**
 * The single low-level seal-field collector, shared by
 * {@link parseAssertionSealQuads} and {@link parseGraphScopedAssertionSealCandidate}. Filters to
 * `subject === assertionUri`, normalises/validates root-entity IRIs, and returns
 * every non-root-entity object grouped by predicate WITH MULTIPLICITY preserved
 * — so each caller applies its own cardinality policy (the full parser takes the
 * last value; durable admission requires exactly one and fails closed on
 * ambiguity). Throws only on an unsafe root-entity IRI (store corruption).
 */
function collectSealFieldObjects(
  quads: ReadonlyArray<{ subject: string; predicate: string; object: string }>,
  assertionUri: string,
): { fields: Map<string, string[]>; rootEntities: string[] } {
  const fields = new Map<string, string[]>();
  const rootEntities: string[] = [];
  for (const q of quads) {
    if (q.subject !== assertionUri) continue;
    if (q.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY) {
      // The seal builder writes the root entity in N-Triples `<X>` IRI
      // syntax (line 145), but stores like oxigraph parse the IRI on
      // insert and round-trip the bare value back out. Accept both
      // shapes so the round-trip survives any IRI-aware backend.
      // `seal.rootEntities` is always exposed to consumers as bare IRIs
      // (they re-wrap for SPARQL VALUES themselves — see
      // `_loadSelectedSWMQuads`).
      const wrapped = q.object.match(/^<([^>]+)>$/);
      const root = wrapped ? wrapped[1] : q.object;
      if (root.length === 0 || UNSAFE_IRI_CHARS.test(root)) {
        throw new Error(
          `Invalid assertionRootEntity IRI in seal for <${assertionUri}>: ${q.object} ` +
            `(failed safe-IRI check; expected a bare IRI or N-Triples <IRI> form).`,
        );
      }
      rootEntities.push(root);
      continue;
    }
    const existing = fields.get(q.predicate);
    if (existing) existing.push(q.object);
    else fields.set(q.predicate, [q.object]);
  }
  return { fields, rootEntities };
}

/**
 * Parse a `_meta` quad slice (already filtered to subject =
 * assertionUri) into a typed seal record. Returns `undefined` when
 * the assertion has not been finalized (no merkle root present).
 * Throws on partial seals — those signal store corruption.
 */
export function parseAssertionSealQuads(
  quads: ReadonlyArray<{ subject: string; predicate: string; object: string }>,
  assertionUri: string,
): AssertionSeal | undefined {
  const { fields, rootEntities } = collectSealFieldObjects(quads, assertionUri);
  // Full parse keeps last-writer-wins for a repeated predicate (historical
  // behaviour): collapse each predicate's objects to its last value.
  const seen = new Map<string, string>();
  for (const [predicate, objects] of fields) seen.set(predicate, objects[objects.length - 1]!);
  if (!seen.has(ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT)) return undefined;

  const required = [
    ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT,
    ASSERTION_SEAL_PREDICATES.AUTHOR_ADDRESS,
    ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_R,
    ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_VS,
    ASSERTION_SEAL_PREDICATES.AUTHOR_SCHEME_VERSION,
    ASSERTION_SEAL_PREDICATES.ASSERTED_AT_CHAIN_ID,
    ASSERTION_SEAL_PREDICATES.ASSERTED_AT_KAV10_ADDRESS,
    ASSERTION_SEAL_PREDICATES.ASSERTION_FINALIZED_AT,
  ];
  for (const p of required) {
    if (!seen.has(p)) {
      throw new Error(
        `Partial assertion seal for <${assertionUri}>: missing <${p}>. ` +
          `_meta is corrupt; rebuild from the source assertion.`,
      );
    }
  }
  const contentScopeVersion = seen.has(ASSERTION_SEAL_PREDICATES.CONTENT_SCOPE_VERSION)
    ? Number(integerLiteralToValue(seen.get(ASSERTION_SEAL_PREDICATES.CONTENT_SCOPE_VERSION)!))
    : LEGACY_ROOT_CONTENT_SCOPE_VERSION;
  let kaUal: string | undefined;
  let assertionVersion: string | undefined;
  let publicTripleCount: number | undefined;
  let privateMerkleRoot: Uint8Array | undefined;
  let privateTripleCount: number | undefined;
  if (contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION) {
    const graphRequired = [
      ASSERTION_SEAL_PREDICATES.KA_UAL,
      ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION,
      ASSERTION_SEAL_PREDICATES.PUBLIC_TRIPLE_COUNT,
      ASSERTION_SEAL_PREDICATES.PRIVATE_TRIPLE_COUNT,
    ];
    for (const predicate of graphRequired) {
      if (!seen.has(predicate)) {
        throw new Error(
          `Partial graph-scoped assertion seal for <${assertionUri}>: missing <${predicate}>.`,
        );
      }
    }
    if (rootEntities.length > 0) {
      throw new Error(
        `Graph-scoped assertion seal for <${assertionUri}> must not contain root entities`,
      );
    }
    const scope = createGraphKnowledgeAssetScope(
      iriObjectToValue(seen.get(ASSERTION_SEAL_PREDICATES.KA_UAL)!),
      integerLiteralToValue(seen.get(ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION)!),
    );
    const count = integerLiteralToValue(
      seen.get(ASSERTION_SEAL_PREDICATES.PUBLIC_TRIPLE_COUNT)!,
    );
    const privateCount = integerLiteralToValue(
      seen.get(ASSERTION_SEAL_PREDICATES.PRIVATE_TRIPLE_COUNT)!,
    );
    if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `Invalid graph-scoped publicTripleCount for <${assertionUri}>: ${count}`,
      );
    }
    if (privateCount < 0n || privateCount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `Invalid graph-scoped privateTripleCount for <${assertionUri}>: ${privateCount}`,
      );
    }
    if (count === 0n && privateCount === 0n) {
      throw new Error(
        `Graph-scoped assertion seal for <${assertionUri}> contains no public or private triples`,
      );
    }
    const privateRootObject = seen.get(ASSERTION_SEAL_PREDICATES.PRIVATE_MERKLE_ROOT);
    if (privateCount > 0n) {
      if (privateRootObject === undefined) {
        throw new Error(
          `Partial graph-scoped assertion seal for <${assertionUri}>: missing ` +
            `<${ASSERTION_SEAL_PREDICATES.PRIVATE_MERKLE_ROOT}>.`,
        );
      }
      privateMerkleRoot = hexBinaryLiteralToBytes(privateRootObject);
      if (privateMerkleRoot.length !== 32) {
        throw new Error(
          `Invalid graph-scoped privateMerkleRoot for <${assertionUri}>: expected 32 bytes, got ${privateMerkleRoot.length}`,
        );
      }
    } else if (privateRootObject !== undefined) {
      throw new Error(
        `Graph-scoped assertion seal for <${assertionUri}> has privateMerkleRoot with zero privateTripleCount`,
      );
    }
    kaUal = scope.ual;
    assertionVersion = scope.assertionVersion;
    publicTripleCount = Number(count);
    privateTripleCount = Number(privateCount);
  } else if (contentScopeVersion === LEGACY_ROOT_CONTENT_SCOPE_VERSION) {
    if (rootEntities.length === 0) {
      throw new Error(
        `Partial assertion seal for <${assertionUri}>: at least one ` +
          `<${ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY}> is required ` +
          `(seal predates the per-assertion-rootEntities binding — re-finalize the assertion).`,
      );
    }
  } else {
    throw new Error(
      `Unsupported assertion content scope version ${contentScopeVersion} for <${assertionUri}>`,
    );
  }
  return {
    merkleRoot: hexBinaryLiteralToBytes(
      seen.get(ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT)!,
    ),
    authorAddress: stringLiteralToValue(
      seen.get(ASSERTION_SEAL_PREDICATES.AUTHOR_ADDRESS)!,
    ),
    authorAttestationR: hexBinaryLiteralToBytes(
      seen.get(ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_R)!,
    ),
    authorAttestationVS: hexBinaryLiteralToBytes(
      seen.get(ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_VS)!,
    ),
    authorSchemeVersion: Number(
      integerLiteralToValue(seen.get(ASSERTION_SEAL_PREDICATES.AUTHOR_SCHEME_VERSION)!),
    ),
    chainId: integerLiteralToValue(
      seen.get(ASSERTION_SEAL_PREDICATES.ASSERTED_AT_CHAIN_ID)!,
    ),
    kav10Address: stringLiteralToValue(
      seen.get(ASSERTION_SEAL_PREDICATES.ASSERTED_AT_KAV10_ADDRESS)!,
    ),
    // OT-RFC-43 §F2 — optional on read: present on seals finalized after the
    // binding landed; consumers fall back to the lifecycle-URN kaId when absent.
    reservedKaId: seen.has(ASSERTION_SEAL_PREDICATES.RESERVED_KA_ID)
      ? integerLiteralToValue(seen.get(ASSERTION_SEAL_PREDICATES.RESERVED_KA_ID)!)
      : undefined,
    finalizedAtIso: dateTimeLiteralToValue(
      seen.get(ASSERTION_SEAL_PREDICATES.ASSERTION_FINALIZED_AT)!,
    ),
    contentScopeVersion,
    ...(kaUal ? { kaUal } : {}),
    ...(assertionVersion ? { assertionVersion } : {}),
    ...(publicTripleCount !== undefined ? { publicTripleCount } : {}),
    ...(privateMerkleRoot !== undefined ? { privateMerkleRoot } : {}),
    ...(privateTripleCount !== undefined ? { privateTripleCount } : {}),
    rootEntities,
  };
}

/** A validated, publishable graph-scoped author seal candidate + its coordinate. */
export interface GraphScopedAssertionSealCandidate {
  seal: AssertionSeal;
  coordinate: { scope: string; agentAddress: string; name: string };
}

/**
 * GH#1778 — the SINGLE canonical definition of a "publishable graph-scoped
 * author seal", shared by VM-publish author resolution and durable-sync
 * admission so the two never drift. Returns the parsed seal + its subject
 * coordinate iff a subject's `_meta` rows form a complete, self-consistent
 * graph-scoped v2 seal rooted at its own author coordinate; otherwise
 * `undefined` (never throws — safe on peer-supplied rows during selection).
 *
 * A row set qualifies only when ALL of the following hold:
 *  - the identity/version predicates (`assertionMerkleRoot`, `contentScopeVersion`,
 *    `kaUal`, `authorAddress`, `assertionVersion`) each have exactly ONE distinct
 *    value — fail-closed on conflicting/duplicate rows, so a peer cannot rely on
 *    the full parser's last-writer-wins to slip a tampered value through;
 *  - `parseAssertionSealQuads` accepts it as a COMPLETE seal (all required fields
 *    present — the exact check publish performs), and it is graph-scoped v2;
 *  - the subject `/assertion/<addr>/…` coordinate, the seal's `authorAddress`, and
 *    the `kaUal` author all agree (case-folded) — a seal that names a different
 *    author than its subject URI is rejected, not silently trusted.
 */
export function parseGraphScopedAssertionSealCandidate(
  rows: ReadonlyArray<{ subject: string; predicate: string; object: string }>,
  subject: string,
): GraphScopedAssertionSealCandidate | undefined {
  try {
    const { fields } = collectSealFieldObjects(rows, subject);
    // Fail closed on ambiguity BEFORE the last-writer-wins full parse: any
    // identity/version predicate present with more than one distinct value is
    // rejected outright.
    for (const predicate of [
      ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT,
      ASSERTION_SEAL_PREDICATES.CONTENT_SCOPE_VERSION,
      ASSERTION_SEAL_PREDICATES.KA_UAL,
      ASSERTION_SEAL_PREDICATES.AUTHOR_ADDRESS,
      ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION,
    ]) {
      if (new Set(fields.get(predicate) ?? []).size > 1) return undefined;
    }
    const seal = parseAssertionSealQuads(rows, subject);
    if (!seal
      || seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION
      || !seal.kaUal) {
      return undefined;
    }
    const coordinate = parseContextGraphAssertionUri(subject);
    if (!coordinate) return undefined;
    // Identity alignment: subject-coordinate author == seal author == kaUal author.
    const sealAuthor = seal.authorAddress.toLowerCase();
    const ualAuthor = parseDeterministicKnowledgeAssetUal(seal.kaUal).agentAddress.toLowerCase();
    if (coordinate.agentAddress.toLowerCase() !== sealAuthor || ualAuthor !== sealAuthor) {
      return undefined;
    }
    return { seal, coordinate };
  } catch {
    return undefined;
  }
}

// ── literal helpers ─────────────────────────────────────────────

function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function hexBinaryLiteralToBytes(literal: string): Uint8Array {
  // Accept either `"<hex>"^^<xsd:hexBinary>` or a bare hex literal.
  const m =
    literal.match(/^"([0-9a-fA-F]*)"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#hexBinary>$/) ??
    literal.match(/^"([0-9a-fA-F]*)"$/);
  if (!m) {
    throw new Error(`Invalid xsd:hexBinary literal: ${literal}`);
  }
  const hex = m[1];
  if (hex.length % 2 !== 0) {
    throw new Error(`xsd:hexBinary literal has odd length: ${literal}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function integerLiteralToValue(literal: string): bigint {
  // `"<int>"^^<xsd:integer>` or bare quoted integer.
  const m =
    literal.match(/^"(-?\d+)"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#integer>$/) ??
    literal.match(/^"(-?\d+)"$/);
  if (!m) throw new Error(`Invalid xsd:integer literal: ${literal}`);
  return BigInt(m[1]);
}

function iriObjectToValue(object: string): string {
  const wrapped = object.match(/^<([^>]+)>$/);
  const iri = wrapped ? wrapped[1] : object;
  if (!iri || iri.startsWith('"') || UNSAFE_IRI_CHARS.test(iri)) {
    throw new Error(`Invalid assertion seal IRI object: ${object}`);
  }
  return iri;
}

function dateTimeLiteralToValue(literal: string): string {
  const m =
    literal.match(/^"([^"]+)"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#dateTime>$/) ??
    literal.match(/^"([^"]+)"$/);
  if (!m) throw new Error(`Invalid xsd:dateTime literal: ${literal}`);
  return m[1];
}

function stringLiteralToValue(literal: string): string {
  // `JSON.stringify` was used to produce the literal — `JSON.parse`
  // is the inverse for the simple-string case, with a fallback for
  // bare strings without quotes (defensive).
  if (literal.startsWith('"')) {
    try {
      return JSON.parse(literal);
    } catch {
      // fallthrough
    }
  }
  return literal;
}
