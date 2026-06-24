/**
 * dRAG verifiable-citation PRODUCER + VERIFIER (OT-RFC-55 §5.3 / OT-RFC-54 Phase 1).
 *
 * The pure wire type and the Merkle/content-binding check live in
 * `@origintrail-official/dkg-core` ({@link VerifiableCitation},
 * {@link verifyCitationProof}). THIS module is the half that needs a triple
 * store, a chain adapter, and `ethers`:
 *
 *   - {@link buildVerifiableCitation} — given a cited triple in a locally-held
 *     KA, extract the KA's canonical V10 leaf set, build a Merkle inclusion
 *     proof that re-anchors to the on-chain `getLatestMerkleRoot(kaId)`, and
 *     attach the EIP-712 author seal. The proof uses the SAME structured V10
 *     tree the Random Sampling prover + on-chain `submitProof` use, so a
 *     citation that builds here verifies on-chain by construction.
 *
 *   - {@link verifyVerifiableCitation} — re-check a citation: Merkle (pure,
 *     via core) + on-chain re-anchor (optional chain adapter) + EIP-712 author
 *     recovery (ethers).
 *
 * AUTHOR semantics: `getLatestMerkleRootAuthor(kaId)` IS the EIP-712 author the
 * chain recovered at publish time, so it is authoritative. The off-chain seal
 * recovery is a TRUSTLESS enhancement: when the `_meta` seal resolves we recover
 * the signer locally and confirm it matches the on-chain author (so a verifier
 * need not trust the chain read). When the seal is absent we fall back to the
 * on-chain author and mark `authorSig: null` (still chain-verified, just not
 * independently re-derived).
 */

import { ethers } from 'ethers';
import {
  buildV10ProofMaterial,
  structuredKARootV10,
  tripleContentV10,
  keccak256,
  buildAuthorAttestationTypedData,
  contextGraphMetaUri,
  parseAssertionSealQuads,
  bytesToHex0x,
  type AssertionSeal,
  type VerifiableCitation,
  type CitationTriple,
  type CitationChecks,
  type CitationSeal,
} from '@origintrail-official/dkg-core';
import { verifyCitationProof } from '@origintrail-official/dkg-core';
import { extractV10KCFromStore } from '@origintrail-official/dkg-random-sampling';
import type { TripleStore } from '@origintrail-official/dkg-storage';

/** Chain reads a citation producer/verifier needs (subset of the EVM adapter). */
export interface CitationChainReads {
  getLatestMerkleRoot(kaId: bigint): Promise<Uint8Array>;
  getMerkleLeafCount(kaId: bigint): Promise<number>;
  getLatestMerkleRootAuthor(kaId: bigint): Promise<string>;
}

export interface BuildCitationDeps {
  store: TripleStore;
  chain: CitationChainReads;
  /** This node's libp2p peerId (or `"local"`) — stamped as the serving node. */
  servingNode: string;
  /** Chain id stamped onto the citation (for display / EIP-712 domain when no seal). */
  chainId: bigint;
}

/** Thrown when the cited triple is not a public leaf of the named KA. */
export class CitedTripleNotInKAError extends Error {
  readonly name = 'CitedTripleNotInKAError';
  constructor(readonly kaId: bigint, readonly triple: CitationTriple) {
    super(
      `cited triple <${triple.subject}> <${triple.predicate}> ${triple.object} ` +
        `is not a public leaf of KA ${kaId}`,
    );
  }
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function isNonZeroAddress(addr: string): boolean {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr) && addr.toLowerCase() !== ZERO_ADDR;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function eqHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function stripAngle(iri: string): string {
  const m = iri.match(/^<(.+)>$/);
  return m ? m[1] : iri;
}

/**
 * Index of `citedContent`'s keccak leaf in the KA's post sort+dedupe public tree
 * (the on-chain `chunkId` space), or -1 if the cited triple is not a public leaf.
 */
function findLeafIndex(
  contents: Uint8Array[],
  privateRoots: Uint8Array[],
  citedContent: Uint8Array,
): number {
  const leaves = contents.map((c) => keccak256(c));
  const { publicTree } = structuredKARootV10(leaves, privateRoots);
  const citedLeaf = keccak256(citedContent);
  for (let i = 0; i < publicTree.leafCount; i++) {
    if (bytesEqual(publicTree.leafAt(i), citedLeaf)) return i;
  }
  return -1;
}

// ── author seal ───────────────────────────────────────────────────────────────

function sealToWire(s: AssertionSeal): CitationSeal {
  return {
    merkleRoot: bytesToHex0x(s.merkleRoot),
    authorAddress: s.authorAddress,
    r: bytesToHex0x(s.authorAttestationR),
    vs: bytesToHex0x(s.authorAttestationVS),
    schemeVersion: s.authorSchemeVersion,
    chainId: s.chainId.toString(),
    kav10Address: s.kav10Address,
    reservedKaId: (s.reservedKaId ?? 0n).toString(),
  };
}

/** Recover the EIP-712 author EOA from a wire seal. Throws on malformed sig/typed data. */
export function recoverCitationAuthor(seal: CitationSeal): string {
  const typed = buildAuthorAttestationTypedData({
    chainId: BigInt(seal.chainId),
    kav10Address: seal.kav10Address,
    merkleRoot: ethers.getBytes(seal.merkleRoot),
    authorAddress: seal.authorAddress,
    reservedKaId: BigInt(seal.reservedKaId),
    schemeVersion: seal.schemeVersion,
  });
  const sig = ethers.Signature.from({ r: seal.r, yParityAndS: seal.vs }).serialized;
  return ethers.verifyTypedData(typed.domain, typed.types, typed.message, sig);
}

/**
 * Best-effort: load the `_meta` author seal whose `assertionMerkleRoot` equals the
 * on-chain root. Matching by root (not by assertion URI) makes this robust to how
 * the seal subject is keyed (assertion URI vs UAL vs remapped graph).
 */
async function loadSealByMerkleRoot(
  store: TripleStore,
  contextGraphName: string,
  contextGraphIdStr: string,
  merkleRoot: Uint8Array,
): Promise<AssertionSeal | undefined> {
  const rootLexical = bytesToHex0x(merkleRoot).slice(2).toLowerCase(); // xsd:hexBinary lexical (no 0x)
  // The seal is written by finalize to the NAME-only `_meta` graph
  // (`contextGraphMetaUri(name)`); the cgId-scoped meta is checked as a
  // fallback in case a future remap relocates it.
  const metaGraphs = Array.from(
    new Set([contextGraphMetaUri(contextGraphName), contextGraphMetaUri(contextGraphName, contextGraphIdStr)]),
  );
  for (const metaGraph of metaGraphs) {
    const sel = await store.query(
      `SELECT DISTINCT ?s WHERE {
         GRAPH <${metaGraph}> {
           ?s <http://dkg.io/ontology/assertionMerkleRoot> ?r .
           FILTER(LCASE(STR(?r)) = "${rootLexical}")
         }
       } LIMIT 8`,
    );
    const subjects =
      sel.type === 'bindings'
        ? sel.bindings.map((b) => stripAngle(b['s'] ?? '')).filter((s) => s.length > 0)
        : [];
    for (const subj of subjects) {
      const c = await store.query(
        `CONSTRUCT { <${subj}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${subj}> ?p ?o } }`,
      );
      const quads = c.type === 'quads' ? c.quads : [];
      let seal: AssertionSeal | undefined;
      try {
        seal = parseAssertionSealQuads(quads, subj);
      } catch {
        seal = undefined; // partial/corrupt seal — skip, fall back to on-chain author
      }
      if (seal && eqHex(bytesToHex0x(seal.merkleRoot), bytesToHex0x(merkleRoot))) return seal;
    }
  }
  return undefined;
}

// ── producer ──────────────────────────────────────────────────────────────────

/**
 * The per-KA work that does NOT depend on the specific cited triple: extract the
 * canonical leaf set, read the on-chain commitment + author, load + recover the
 * author seal. Prepared once per KA, then reused to cite many triples of that KA
 * via {@link citeTriple} — avoiding redundant store extraction + chain reads.
 *
 * `triples` are the KA's canonical public triples (the exact forms the Merkle
 * leaves are built from); cite only triples drawn from this set so the leaf
 * always matches.
 */
export interface PreparedKaCitation {
  ual: string;
  contextGraphIdStr: string;
  kaIdStr: string;
  servingNode: string;
  /** Canonical N-Triple content bytes of each public triple (unsorted). */
  contents: Uint8Array[];
  privateRoots: Uint8Array[];
  /** The KA's canonical public triples (cite only from this set). */
  triples: CitationTriple[];
  merkleRoot: Uint8Array;
  merkleLeafCount: number;
  author: string;
  chainId: bigint;
  seal?: CitationSeal;
  /** Per-KA author verdict (same for every triple of the KA). */
  authorSig: boolean | null;
}

/**
 * Resolve everything a citation needs for ALL triples of one KA: extract the
 * canonical leaf set, read the on-chain commitment + author, and recover the
 * author seal once.
 */
export async function prepareKaCitation(
  deps: BuildCitationDeps,
  args: { contextGraphId: bigint; kaId: bigint },
): Promise<PreparedKaCitation> {
  const { store, chain, servingNode } = deps;
  const { contextGraphId, kaId } = args;

  const kc = await extractV10KCFromStore(store, contextGraphId, kaId);
  const contents = kc.triples.map((t) => tripleContentV10(t.subject, t.predicate, t.object));

  const [merkleRoot, merkleLeafCount, author] = await Promise.all([
    chain.getLatestMerkleRoot(kaId),
    chain.getMerkleLeafCount(kaId),
    chain.getLatestMerkleRootAuthor(kaId),
  ]);

  let seal: CitationSeal | undefined;
  let authorSig: boolean | null;
  const loaded = await loadSealByMerkleRoot(
    store,
    kc.contextGraphName,
    contextGraphId.toString(),
    merkleRoot,
  ).catch(() => undefined);
  if (loaded) {
    seal = sealToWire(loaded);
    let recovered = '';
    try {
      recovered = recoverCitationAuthor(seal);
    } catch {
      recovered = '';
    }
    authorSig =
      isNonZeroAddress(recovered) && eqHex(recovered, author) && eqHex(seal.merkleRoot, bytesToHex0x(merkleRoot));
  } else {
    authorSig = isNonZeroAddress(author) ? null : false;
  }

  return {
    ual: kc.ual,
    contextGraphIdStr: contextGraphId.toString(),
    kaIdStr: kaId.toString(),
    servingNode,
    contents,
    privateRoots: kc.privateRoots,
    triples: kc.triples.map((t) => ({ subject: t.subject, predicate: t.predicate, object: t.object })),
    merkleRoot,
    merkleLeafCount,
    author,
    chainId: seal ? BigInt(seal.chainId) : deps.chainId,
    seal,
    authorSig,
  };
}

/**
 * Build a {@link VerifiableCitation} for one triple of an already-{@link prepareKaCitation prepared}
 * KA. Pure (no async): builds the V10 Merkle proof and asserts it re-anchors to
 * the prepared on-chain root. Throws {@link CitedTripleNotInKAError} if the
 * triple is not a public leaf of the KA.
 */
export function citeTriple(prepared: PreparedKaCitation, triple: CitationTriple): VerifiableCitation {
  const citedContent = tripleContentV10(triple.subject, triple.predicate, triple.object);
  const chunkId = findLeafIndex(prepared.contents, prepared.privateRoots, citedContent);
  if (chunkId < 0) throw new CitedTripleNotInKAError(BigInt(prepared.kaIdStr), triple);

  const material = buildV10ProofMaterial(prepared.contents, prepared.privateRoots, chunkId, {
    merkleRoot: prepared.merkleRoot,
    merkleLeafCount: prepared.merkleLeafCount,
  });
  const onChainOk = bytesEqual(material.merkleRoot, prepared.merkleRoot);

  return {
    ual: prepared.ual,
    kaId: prepared.kaIdStr,
    contextGraphId: prepared.contextGraphIdStr,
    servingNode: prepared.servingNode,
    triple,
    proof: {
      content: bytesToHex0x(material.content),
      leaf: bytesToHex0x(material.leaf),
      siblings: material.proof.map(bytesToHex0x),
      chunkId,
      leafCount: material.leafCount,
    },
    onChain: {
      merkleRoot: bytesToHex0x(prepared.merkleRoot),
      author: prepared.author,
      chainId: prepared.chainId.toString(),
    },
    seal: prepared.seal,
    checks: {
      merkle: true,
      onChain: onChainOk,
      authorSig: prepared.authorSig,
      verified: onChainOk && prepared.authorSig !== false,
    },
  };
}

/**
 * Build a {@link VerifiableCitation} for one cited triple of a locally-held KA
 * (convenience: {@link prepareKaCitation} + {@link citeTriple} for a single fact).
 */
export async function buildVerifiableCitation(
  deps: BuildCitationDeps,
  args: { contextGraphId: bigint; kaId: bigint; triple: CitationTriple },
): Promise<VerifiableCitation> {
  const prepared = await prepareKaCitation(deps, args);
  return citeTriple(prepared, args.triple);
}

// ── verifier ────────────────────────────────────────────────────────────────

/**
 * Re-verify a {@link VerifiableCitation}. Merkle + content-binding is pure (core).
 * Pass `opts.chain` to re-anchor the root and author against the LIVE chain
 * (fully trustless); omit it to verify against the carried on-chain values
 * (offline / self-consistent).
 */
export async function verifyVerifiableCitation(
  citation: VerifiableCitation,
  opts?: { chain?: CitationChainReads },
): Promise<CitationChecks> {
  const merkle = verifyCitationProof(citation);

  let onChain: boolean | null = citation.checks.onChain;
  let expectedAuthor = citation.onChain.author;
  if (opts?.chain) {
    const [liveRoot, liveAuthor] = await Promise.all([
      opts.chain.getLatestMerkleRoot(BigInt(citation.kaId)),
      opts.chain.getLatestMerkleRootAuthor(BigInt(citation.kaId)),
    ]);
    onChain = eqHex(bytesToHex0x(liveRoot), citation.onChain.merkleRoot);
    expectedAuthor = liveAuthor;
  }

  let authorSig: boolean | null;
  if (citation.seal) {
    let recovered = '';
    try {
      recovered = recoverCitationAuthor(citation.seal);
    } catch {
      recovered = '';
    }
    authorSig =
      isNonZeroAddress(recovered) &&
      eqHex(recovered, expectedAuthor) &&
      eqHex(citation.seal.merkleRoot, citation.onChain.merkleRoot);
  } else {
    authorSig = isNonZeroAddress(expectedAuthor) ? null : false;
  }

  return {
    merkle,
    onChain,
    authorSig,
    verified: merkle && onChain !== false && authorSig !== false,
  };
}
