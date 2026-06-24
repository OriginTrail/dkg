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
  const metaGraph = contextGraphMetaUri(contextGraphName, contextGraphIdStr);
  const rootLexical = bytesToHex0x(merkleRoot).slice(2).toLowerCase(); // xsd:hexBinary lexical (no 0x)
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
  return undefined;
}

// ── producer ──────────────────────────────────────────────────────────────────

/**
 * Build a {@link VerifiableCitation} for one cited triple of a locally-held KA.
 * The returned citation re-anchors to the live on-chain Merkle root and carries
 * the author seal when resolvable.
 */
export async function buildVerifiableCitation(
  deps: BuildCitationDeps,
  args: { contextGraphId: bigint; kaId: bigint; triple: CitationTriple },
): Promise<VerifiableCitation> {
  const { store, chain, servingNode } = deps;
  const { contextGraphId, kaId, triple } = args;

  // 1. Resolve the KA's canonical V10 public leaf set + private sub-roots.
  const kc = await extractV10KCFromStore(store, contextGraphId, kaId);
  const contents = kc.triples.map((t) => tripleContentV10(t.subject, t.predicate, t.object));

  // 2. Locate the cited triple's leaf index (== on-chain chunkId).
  const citedContent = tripleContentV10(triple.subject, triple.predicate, triple.object);
  const chunkId = findLeafIndex(contents, kc.privateRoots, citedContent);
  if (chunkId < 0) throw new CitedTripleNotInKAError(kaId, triple);

  // 3. Read the on-chain commitment.
  const [merkleRoot, merkleLeafCount, author] = await Promise.all([
    chain.getLatestMerkleRoot(kaId),
    chain.getMerkleLeafCount(kaId),
    chain.getLatestMerkleRootAuthor(kaId),
  ]);

  // 4. Build proof material. buildV10ProofMaterial THROWS unless the recomputed
  //    structured root + leaf count equal the on-chain commitment — so a returned
  //    material is simultaneously Merkle-valid AND on-chain-anchored.
  const material = buildV10ProofMaterial(contents, kc.privateRoots, chunkId, {
    merkleRoot,
    merkleLeafCount,
  });

  // 5. Best-effort off-chain author seal.
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
      isNonZeroAddress(recovered) &&
      eqHex(recovered, author) &&
      eqHex(seal.merkleRoot, bytesToHex0x(merkleRoot));
  } else {
    // Chain verified the EIP-712 author sig at publish; we just can't re-derive
    // it off-chain without the seal. Authorship still rests on the on-chain author.
    authorSig = isNonZeroAddress(author) ? null : false;
  }

  const checks: CitationChecks = {
    merkle: true,
    onChain: bytesEqual(material.merkleRoot, merkleRoot),
    authorSig,
    verified: bytesEqual(material.merkleRoot, merkleRoot) && authorSig !== false,
  };

  return {
    ual: kc.ual,
    kaId: kaId.toString(),
    contextGraphId: contextGraphId.toString(),
    servingNode,
    triple,
    proof: {
      content: bytesToHex0x(material.content),
      leaf: bytesToHex0x(material.leaf),
      siblings: material.proof.map(bytesToHex0x),
      chunkId,
      leafCount: material.leafCount,
    },
    onChain: {
      merkleRoot: bytesToHex0x(merkleRoot),
      author,
      chainId: (seal ? BigInt(seal.chainId) : deps.chainId).toString(),
    },
    seal,
    checks,
  };
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
