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

const ONT = 'http://dkg.io/ontology/';

/**
 * Predicates written by `/api/assertion/:name/finalize` (sealed at
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
  /** Daemon-clock dateTime when the seal was written (xsd:dateTime). */
  ASSERTION_FINALIZED_AT: `${ONT}assertionFinalizedAt`,
  /**
   * Root entity bound to the seal (multi-valued). Recorded at finalize
   * time so that `publishFromFinalizedAssertion` can scope the SWM
   * SPARQL CONSTRUCT to exactly this assertion's quads instead of
   * bundling everything currently in shared memory. The set is
   * derived from `autoPartition(filteredQuads).keys()` over the same
   * reserved-subject-filtered quads `assertionPromote` writes, so the
   * post-promote SWM lookup produces the same merkle leaves the seal
   * was signed over. IRI literal — emitted as `<rootEntity>` (object
   * IRI), not a string literal.
   */
  ASSERTION_ROOT_ENTITY: `${ONT}assertionRootEntity`,
} as const;

/**
 * Predicates written by `/api/shared-memory/publish` after a
 * successful on-chain publish. These are receipts; they don't
 * affect the seal's validity.
 */
export const ASSERTION_PUBLISH_RECEIPT_PREDICATES = {
  /** Transaction hash of the KAv10 publish (string literal). */
  PUBLISHED_AT_TX: `${ONT}publishedAtTx`,
  /** Block number (xsd:integer). */
  PUBLISHED_AT_BLOCK: `${ONT}publishedAtBlock`,
  /** Knowledge collection id assigned by `KnowledgeCollectionStorage` (xsd:integer). */
  PUBLISHED_AT_KC_ID: `${ONT}publishedAtKcId`,
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
 * Every quad is pinned to the `metaGraph` so the gossip layer
 * propagates them with the rest of `_meta`.
 */
export function buildAssertionSealQuads(args: {
  assertionUri: string;
  metaGraph: string;
  merkleRoot: Uint8Array;
  authorAddress: string;
  authorAttestationR: Uint8Array;
  authorAttestationVS: Uint8Array;
  authorSchemeVersion: number;
  chainId: bigint;
  kav10Address: string;
  finalizedAtIso: string;
  /**
   * Root entities the seal commits to (one per emitted quad). Required
   * — the SWM-publish path uses these to scope its CONSTRUCT instead
   * of bundling the entire shared-memory graph (Round 4 review §9).
   */
  rootEntities: ReadonlyArray<string>;
}): Array<{ subject: string; predicate: string; object: string; graph: string }> {
  if (args.merkleRoot.length !== 32) {
    throw new Error(`merkleRoot must be 32 bytes, got ${args.merkleRoot.length}`);
  }
  if (args.authorAttestationR.length !== 32) {
    throw new Error(`authorAttestationR must be 32 bytes, got ${args.authorAttestationR.length}`);
  }
  if (args.authorAttestationVS.length !== 32) {
    throw new Error(`authorAttestationVS must be 32 bytes, got ${args.authorAttestationVS.length}`);
  }
  if (args.rootEntities.length === 0) {
    throw new Error('rootEntities must be non-empty: the seal must commit to at least one root entity');
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

  const rootEntityQuads = args.rootEntities.map((root) => {
    if (UNSAFE_IRI_CHARS.test(root) || root.length === 0) {
      throw new Error(`Unsafe rootEntity literal: ${root}`);
    }
    return {
      subject: args.assertionUri,
      predicate: ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY,
      object: `<${root}>`,
      graph: args.metaGraph,
    };
  });

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
      ASSERTION_SEAL_PREDICATES.ASSERTION_FINALIZED_AT,
      `"${args.finalizedAtIso}"^^${xsdDateTime}`,
    ),
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
  kcId: bigint;
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
    {
      subject: args.assertionUri,
      predicate: ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_KC_ID,
      object: `"${args.kcId.toString()}"^^${xsdInteger}`,
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
  finalizedAtIso: string;
  /**
   * Root entities the seal commits to. Set at finalize time, used at
   * publish time to scope the SWM SPARQL CONSTRUCT (so a named publish
   * does not bundle other content currently sitting in shared memory).
   */
  rootEntities: string[];
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
  const seen = new Map<string, string>();
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
    seen.set(q.predicate, q.object);
  }
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
  if (rootEntities.length === 0) {
    throw new Error(
      `Partial assertion seal for <${assertionUri}>: at least one ` +
        `<${ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY}> is required ` +
        `(seal predates the per-assertion-rootEntities binding — re-finalize the assertion).`,
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
    finalizedAtIso: dateTimeLiteralToValue(
      seen.get(ASSERTION_SEAL_PREDICATES.ASSERTION_FINALIZED_AT)!,
    ),
    rootEntities,
  };
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
