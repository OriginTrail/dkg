/**
 * Verifiable citation — the audit primitive behind dRAG (OT-RFC-55 §5.3 /
 * OT-RFC-54 Phase 1 "verify-on-read").
 *
 * A {@link VerifiableCitation} binds a single cited triple `(s, p, o)` to its
 * source Knowledge Asset's **on-chain Merkle root**, so a consumer can confirm —
 * without trusting the serving node — that the fact really is part of the sealed,
 * anchored KA the citation claims, authored by the address the chain recorded.
 *
 * Three independent checks (see {@link CitationChecks}):
 *   - **merkle**   — the cited triple's `keccak256(content)` leaf walks its V10
 *                    Merkle proof to the KA's structured root (content-binding:
 *                    the leaf MUST equal `keccak256(content)` and the content MUST
 *                    equal the cited triple's canonical N-Triple bytes, so a node
 *                    cannot echo the root or swap a different triple's content).
 *   - **onChain**  — that recomputed root equals the live on-chain
 *                    `getLatestMerkleRoot(kaId)` (re-anchor; done where a chain
 *                    adapter is available — see `@origintrail-official/dkg-agent`).
 *   - **authorSig**— the EIP-712 author seal recovers to the on-chain author
 *                    (`getLatestMerkleRootAuthor(kaId)`); needs secp256k1 recovery
 *                    (ethers), so it is performed in the agent layer.
 *
 * This module is the PURE, dependency-light half: the wire types, the hex codecs,
 * and {@link verifyCitationProof} (the merkle + content-binding check, reusing
 * {@link verifyV10ProofMaterial}). The producer ({@link VerifiableCitation} from a
 * local triple store) and the author-seal recovery live in the agent package,
 * which has the store, the chain adapter, and `ethers`.
 *
 * The proof carries the SAME V10 structured tree the Random Sampling prover and
 * the on-chain `submitProof` verify use (keccak `hashTripleV10`, NOT the sha256
 * oracle path) — so a citation that verifies here verifies on-chain by
 * construction.
 */

import { tripleContentV10 } from './canonicalize.js';
import {
  verifyV10ProofMaterial,
  type V10ProofMaterial,
  type V10MerkleCommitment,
} from './proof-material.js';

/** A single `(subject, predicate, object)` triple cited as grounding for an answer. */
export interface CitationTriple {
  subject: string;
  predicate: string;
  object: string;
}

/**
 * Merkle inclusion proof binding a cited triple to its KA's on-chain root.
 * Bytes are hex-encoded (`0x…`) so the citation is JSON-serialisable over the wire.
 */
export interface CitationProof {
  /** `0x`-hex of the canonical N-Triple content bytes; chain derives `leaf = keccak256(content)`. */
  content: string;
  /** `0x`-hex `keccak256(content)` — the leaf at `chunkId` after V10 sort+dedupe. */
  leaf: string;
  /** `0x`-hex Merkle siblings, leaf→root; the public path ends with `privateDataHash`. */
  siblings: string[];
  /** Leaf index in the post sort+dedupe public tree (the on-chain `chunkId` space). */
  chunkId: number;
  /** Deduped public-leaf count (the on-chain `merkleLeafCount`). */
  leafCount: number;
}

/**
 * EIP-712 author seal (compact signature, EIP-2098) — lets a verifier recover the
 * author off-chain and confirm it matches the on-chain author, without trusting
 * the chain read. Mirrors {@link parseAssertionSealQuads} output (the `_meta` seal).
 */
export interface CitationSeal {
  /** `0x`-hex; MUST equal `onChain.merkleRoot`. */
  merkleRoot: string;
  authorAddress: string;
  /** `0x`-hex compact-sig `r`. */
  r: string;
  /** `0x`-hex compact-sig `vs` (`yParityAndS`). */
  vs: string;
  schemeVersion: number;
  /** decimal string. */
  chainId: string;
  kav10Address: string;
  /** decimal string — the packed `reservedKaId` bound into the EIP-712 digest. */
  reservedKaId: string;
}

export interface CitationChecks {
  /** keccak Merkle inclusion holds AND content binds to the cited triple. */
  merkle: boolean;
  /**
   * Proof root equals the live on-chain `getLatestMerkleRoot(kaId)`.
   * `null` ⇒ not re-anchored (the carried root was trusted, e.g. pure offline verify).
   */
  onChain: boolean | null;
  /**
   * EIP-712 author seal recovers to the on-chain author.
   * `null` ⇒ not checked (no seal present, or no secp256k1 recovery available).
   */
  authorSig: boolean | null;
  /** `merkle && onChain === true && authorSig !== false`. Offline proof checks are never labelled chain-verified. */
  verified: boolean;
}

/**
 * A cited fact a consumer can audit against the chain. Produced by a serving node
 * (which holds the KA + a chain adapter); verifiable by anyone.
 */
export interface VerifiableCitation {
  /** Canonical on-chain Knowledge Asset UAL (`did:dkg:{chain}/{contract}/{kaId}`). */
  ual: string;
  /** On-chain numeric KA id (packed `reservedKaId`), decimal string. */
  kaId: string;
  /** On-chain numeric Context Graph id, decimal string. */
  contextGraphId: string;
  /** The peer that served this citation (libp2p peerId), or `"local"`. */
  servingNode: string;
  /** The cited triple. */
  triple: CitationTriple;
  /** Merkle inclusion proof material (hex-encoded). */
  proof: CitationProof;
  /** The on-chain anchor this proof verifies against. */
  onChain: {
    /** `0x`-hex — `getLatestMerkleRoot(kaId)`. */
    merkleRoot: string;
    /** `getLatestMerkleRootAuthor(kaId)`. */
    author: string;
    /** decimal string. */
    chainId: string;
  };
  /** EIP-712 author seal, when the `_meta` seal was resolvable. */
  seal?: CitationSeal;
  /** Verification verdict (computed at production time; independently re-checkable). */
  checks: CitationChecks;
}

// ── hex codecs ──────────────────────────────────────────────────────────────

/** Encode bytes as a `0x`-prefixed lowercase hex string. */
export function bytesToHex0x(bytes: Uint8Array): string {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Decode a `0x`-prefixed (or bare) hex string into bytes. Throws on odd/invalid input. */
export function hex0xToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error(`hex string has odd length: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex byte in: ${hex}`);
    out[i] = byte;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── proof reconstruction + verification ───────────────────────────────────────

/**
 * Rebuild the {@link V10ProofMaterial} + {@link V10MerkleCommitment} from a wire
 * {@link CitationProof} and a root, so {@link verifyV10ProofMaterial} can re-check it.
 */
export function citationProofToMaterial(
  proof: CitationProof,
  merkleRootHex: string,
): { material: V10ProofMaterial; commitment: V10MerkleCommitment } {
  const merkleRoot = hex0xToBytes(merkleRootHex);
  const material: V10ProofMaterial = {
    content: hex0xToBytes(proof.content),
    leaf: hex0xToBytes(proof.leaf),
    proof: proof.siblings.map(hex0xToBytes),
    merkleRoot,
    leafCount: proof.leafCount,
  };
  const commitment: V10MerkleCommitment = { merkleRoot, merkleLeafCount: proof.leafCount };
  return { material, commitment };
}

/**
 * PURE Merkle + content-binding verification of a citation against its carried
 * on-chain root. Returns `true` iff:
 *   1. `proof.content` is exactly the canonical N-Triple bytes of `citation.triple`
 *      (the proof is bound to THIS triple, not some other leaf), AND
 *   2. {@link verifyV10ProofMaterial} accepts — i.e. `leaf == keccak256(content)`
 *      (content-binding), the recomputed root equals `onChain.merkleRoot`, and the
 *      leaf walks its siblings to that root at `chunkId`.
 *
 * Does NOT re-fetch the root from chain (that's the `onChain` re-anchor, performed
 * by the agent verifier) and does NOT check the author seal (needs secp256k1).
 */
export function verifyCitationProof(citation: VerifiableCitation): boolean {
  const expectedContent = tripleContentV10(
    citation.triple.subject,
    citation.triple.predicate,
    citation.triple.object,
  );
  if (!bytesEqual(expectedContent, hex0xToBytes(citation.proof.content))) return false;
  const { material, commitment } = citationProofToMaterial(citation.proof, citation.onChain.merkleRoot);
  return verifyV10ProofMaterial(material, citation.proof.chunkId, commitment);
}
