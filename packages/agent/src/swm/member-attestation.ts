/**
 * OT-RFC-38 LU-9 — Member-attested verification token.
 *
 * SPEC_CG_HOSTING_MEMBERSHIP §5.3.2 ("Outsider verification via member
 * attestation"):
 *
 *   "If a third party later sees a single fact ... a member can give
 *    them a small attestation that proves the fact's inclusion in the
 *    on-chain anchor."
 *
 * This module provides the round-trip:
 *
 *   - `mintMemberAttestation` — a member (post-decrypt) signs a
 *     structured envelope binding `(chainId, kavAddress,
 *     contextGraphId, batchId, merkleRoot, plaintextLeafHash,
 *     attestedAt)` with their wallet. The output is a self-contained
 *     token an outsider can verify without ever holding the chain key.
 *
 *   - `verifyMemberAttestation` — an outsider (no key, no membership)
 *     does three checks:
 *       1. Recover the EIP-191 signer from the signature.
 *       2. Confirm the signer matches `attesterAddress`.
 *       3. Compare the supplied `plaintextLeafHash` against a locally-
 *          recomputed `hashTripleV10(quad)` if the outsider already
 *          has a candidate triple in hand — otherwise return the
 *          attestation as "structurally valid" so the caller can
 *          decide whether to also chain-verify membership (a
 *          membership-at-epoch SPARQL lookup is deferred to an
 *          adapter-side hook, not bundled in this module to keep the
 *          file zero-I/O).
 *
 * Design choices:
 *
 *   - **Single-leaf attestation** is the unit. A member can mint many
 *     per batch (one per quoted/leaked fact). Aggregating into batch-
 *     wide attestations is a Phase-B size optimisation, not a Phase-A
 *     correctness concern.
 *
 *   - **No chain query inside this module.** The membership lookup is
 *     external (caller passes in a `membershipResolver` async hook).
 *     Keeps the unit-testable surface tiny and avoids pulling chain
 *     adapters into a crypto-only helper.
 *
 *   - **Digest layout is keccak256 over an `abi.encodePacked`-style
 *     concatenation.** Same shape as `computePublishACKDigest` so
 *     anyone already comfortable with V10 chain-side signature layout
 *     can hand-verify the token.
 */

import { keccak256 } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

export interface MemberAttestationPayload {
  /** Format version — currently 1. */
  version: 1;
  /** EVM chain id (e.g. 1, 31337). */
  chainId: string;
  /** Deployed KAV10 contract address (binds the attestation to one chain+deployment). */
  kavAddress: string;
  /** On-chain context-graph ID (numeric, as a string for JSON portability). */
  contextGraphId: string;
  /** Identifier for the batch the attestation covers — typically the KC id as a string. */
  batchId: string;
  /** 0x-prefixed 32-byte merkle root anchored on chain. */
  merkleRoot: string;
  /** 0x-prefixed 32-byte hash of the specific plaintext leaf being attested. */
  plaintextLeafHash: string;
  /** Attester EVM address (must match signature recovery). */
  attesterAddress: string;
  /** Unix epoch seconds when the attestation was minted. */
  attestedAt: number;
}

export interface MemberAttestation {
  payload: MemberAttestationPayload;
  /** EIP-191 signature over `computeAttestationDigest(payload)`. */
  signature: string;
}

function bytes32ToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexTo32Bytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length !== 64) throw new Error(`expected 32-byte hex, got ${clean.length / 2} bytes`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function uint256ToBytes(value: bigint | string | number): Uint8Array {
  const big = typeof value === 'bigint' ? value : BigInt(value);
  const out = new Uint8Array(32);
  let v = big;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function addressToBytes(addr: string): Uint8Array {
  const clean = addr.toLowerCase().replace(/^0x/, '');
  if (clean.length !== 40) throw new Error(`invalid address: ${addr}`);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Compute the keccak256 digest the attester signs (EIP-191-wrapped).
 *
 * Layout (276 bytes packed):
 *   chainId           : uint256 (32)
 *   kavAddress        : address (20)
 *   contextGraphId    : uint256 (32)
 *   batchId-hash      : bytes32 (32) — keccak256(utf8(batchId)) (batchId is a
 *                       string identifier — hashing makes the length fixed)
 *   merkleRoot        : bytes32 (32)
 *   plaintextLeafHash : bytes32 (32)
 *   attesterAddress   : address (20)
 *   attestedAt        : uint256 (32)
 *   version           : uint256 (32)
 *   reserved          : 12 zero bytes — padding so the total
 *                       packed width is divisible by 4 and stays
 *                       fixed-width for any future version bump.
 *
 * 32+20+32+32+32+32+20+32+32+12 = 276 bytes.
 */
export function computeAttestationDigest(payload: MemberAttestationPayload): Uint8Array {
  const batchIdHash = keccak256(new TextEncoder().encode(payload.batchId));
  const packed = new Uint8Array(276);
  let off = 0;
  packed.set(uint256ToBytes(payload.chainId), off); off += 32;
  packed.set(addressToBytes(payload.kavAddress), off); off += 20;
  packed.set(uint256ToBytes(payload.contextGraphId), off); off += 32;
  packed.set(batchIdHash, off); off += 32;
  packed.set(hexTo32Bytes(payload.merkleRoot), off); off += 32;
  packed.set(hexTo32Bytes(payload.plaintextLeafHash), off); off += 32;
  packed.set(addressToBytes(payload.attesterAddress), off); off += 20;
  packed.set(uint256ToBytes(payload.attestedAt), off); off += 32;
  packed.set(uint256ToBytes(payload.version), off); off += 32;
  // remaining 12 bytes are zero (allocated by Uint8Array)
  return keccak256(packed);
}

export interface MintMemberAttestationInput {
  payload: Omit<MemberAttestationPayload, 'version'> & { version?: 1 };
  /**
   * Async signer hook. The function is handed the digest bytes (raw
   * keccak256) and must return an EIP-191 signature (a hex string with
   * the standard 65-byte r|s|v shape). The agent's chain adapter's
   * `signMessage(...)` returns r/vs; callers can re-serialise.
   *
   * Why a callback instead of a wallet: this module is wallet-
   * agnostic (some adapters use hardware wallets, some use OS
   * keychains); accepting a `(digest) => Promise<sig>` keeps the
   * adapter boundary clean.
   */
  sign: (digest: Uint8Array) => Promise<string>;
}

/**
 * Codex PR #609 R2 — structural payload validator. Used by BOTH the
 * mint and verify paths so malformed input fails the same way in both
 * directions (mint throws; verify returns a structured failure rather
 * than 500-crashing the HTTP route). Returns `null` on success or a
 * human-readable reason string on the first validation miss.
 *
 * Specifically catches: non-numeric chainId / contextGraphId /
 * attestedAt, malformed hex in merkleRoot / plaintextLeafHash /
 * attesterAddress / kavAddress, and missing batchId. Before this,
 * `computeAttestationDigest` would either throw out of the parsing
 * helpers (non-numeric / wrong-length hex) OR coerce malformed hex to
 * zero bytes (the parser is permissive on shorter input), letting bad
 * payloads slip through into the recover path.
 */
export function validateAttestationPayload(
  payload: Partial<MemberAttestationPayload>,
): string | null {
  if (typeof payload.batchId !== 'string' || payload.batchId.length === 0) {
    return 'batchId must be a non-empty string';
  }
  if (typeof payload.chainId !== 'string' || payload.chainId.length === 0) {
    return 'chainId must be a non-empty string';
  }
  try { BigInt(payload.chainId); } catch { return `chainId must be a numeric string (got "${payload.chainId}")`; }
  if (typeof payload.contextGraphId !== 'string' || payload.contextGraphId.length === 0) {
    return 'contextGraphId must be a non-empty string';
  }
  try { BigInt(payload.contextGraphId); } catch { return `contextGraphId must be a numeric string (got "${payload.contextGraphId}")`; }
  if (typeof payload.merkleRoot !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(payload.merkleRoot)) {
    return 'merkleRoot must be 0x + 64 hex chars';
  }
  if (typeof payload.plaintextLeafHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(payload.plaintextLeafHash)) {
    return 'plaintextLeafHash must be 0x + 64 hex chars';
  }
  if (typeof payload.attesterAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(payload.attesterAddress)) {
    return 'attesterAddress must be 0x + 40 hex chars';
  }
  if (typeof payload.kavAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(payload.kavAddress)) {
    return 'kavAddress must be 0x + 40 hex chars';
  }
  if (typeof payload.attestedAt !== 'number' || !Number.isFinite(payload.attestedAt) || payload.attestedAt < 0 || !Number.isInteger(payload.attestedAt)) {
    return 'attestedAt must be a non-negative integer (unix epoch seconds)';
  }
  return null;
}

export async function mintMemberAttestation(
  input: MintMemberAttestationInput,
): Promise<MemberAttestation> {
  const payload: MemberAttestationPayload = { ...input.payload, version: 1 };
  const invalid = validateAttestationPayload(payload);
  if (invalid) throw new Error(invalid);

  const digest = computeAttestationDigest(payload);
  const signature = await input.sign(digest);
  return { payload, signature };
}

export interface VerifyMemberAttestationInput {
  attestation: MemberAttestation;
  /**
   * Optional candidate plaintext leaf bytes. When supplied, the verifier
   * recomputes `keccak256(candidateLeaf)` and confirms it equals
   * `payload.plaintextLeafHash` — this is the "I have the quoted fact,
   * does the attestation say it's in the batch?" check (RFC §5.3.2
   * point 2). When omitted, the verifier only validates structure +
   * signer recovery.
   */
  candidateLeaf?: Uint8Array;
  /**
   * Optional async hook to confirm the attester was a member of the
   * CG at attestation time. Resolves to:
   *   true  — chain shows membership at-or-before `attestedAt`
   *   false — chain shows non-membership
   *   undefined — caller cannot determine (no chain, no adapter); the
   *               verifier surfaces this as `membership: 'unknown'` so
   *               consumers can decide whether to trust based on the
   *               attester identity alone.
   */
  membershipResolver?: (input: {
    chainId: string;
    contextGraphId: string;
    attesterAddress: string;
    attestedAt: number;
  }) => Promise<boolean | undefined>;
}

export interface VerifyMemberAttestationResult {
  ok: boolean;
  /** EVM address recovered from the signature. */
  recoveredSigner: string;
  /** True iff `recoveredSigner === payload.attesterAddress` (case-insensitive). */
  signerMatchesAttester: boolean;
  /**
   * Leaf-hash comparison:
   *   'match'    — caller-supplied candidateLeaf hashes to
   *                payload.plaintextLeafHash
   *   'mismatch' — supplied candidate does NOT match
   *   'skipped'  — caller did not pass a candidateLeaf
   */
  leafCheck: 'match' | 'mismatch' | 'skipped';
  /** Membership-at-epoch outcome from the resolver, if supplied. */
  membership: 'confirmed' | 'denied' | 'unknown' | 'skipped';
  /** Human-readable reason when ok=false. */
  reason?: string;
}

export async function verifyMemberAttestation(
  input: VerifyMemberAttestationInput,
): Promise<VerifyMemberAttestationResult> {
  const { attestation, candidateLeaf, membershipResolver } = input;

  // Codex PR #609 R2 — validate payload BEFORE digesting. Without this,
  // non-numeric chainId/contextGraphId/attestedAt throws out of the
  // parsing helpers inside `computeAttestationDigest`, turning the
  // HTTP verifier into a 500; malformed hex in roots/addresses gets
  // coerced to zero bytes by the permissive parser, letting false
  // positives slip through. Surface both as structured `ok: false`.
  const invalid = validateAttestationPayload(attestation.payload);
  if (invalid) {
    return {
      ok: false,
      recoveredSigner: '',
      signerMatchesAttester: false,
      leafCheck: 'skipped',
      membership: 'skipped',
      reason: `malformed attestation payload: ${invalid}`,
    };
  }

  let digest: Uint8Array;
  try {
    digest = computeAttestationDigest(attestation.payload);
  } catch (err: any) {
    return {
      ok: false,
      recoveredSigner: '',
      signerMatchesAttester: false,
      leafCheck: 'skipped',
      membership: 'skipped',
      reason: `digest construction failed: ${err?.message ?? err}`,
    };
  }

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(digest, attestation.signature);
  } catch (err: any) {
    return {
      ok: false,
      recoveredSigner: '',
      signerMatchesAttester: false,
      leafCheck: 'skipped',
      membership: 'skipped',
      reason: `signature recovery failed: ${err?.message ?? err}`,
    };
  }

  const signerMatchesAttester =
    recovered.toLowerCase() === attestation.payload.attesterAddress.toLowerCase();
  if (!signerMatchesAttester) {
    return {
      ok: false,
      recoveredSigner: recovered,
      signerMatchesAttester: false,
      leafCheck: 'skipped',
      membership: 'skipped',
      reason: `recovered signer ${recovered} does not match attesterAddress ${attestation.payload.attesterAddress}`,
    };
  }

  let leafCheck: VerifyMemberAttestationResult['leafCheck'] = 'skipped';
  if (candidateLeaf) {
    const actual = bytes32ToHex(keccak256(candidateLeaf));
    leafCheck =
      actual.toLowerCase() === attestation.payload.plaintextLeafHash.toLowerCase()
        ? 'match'
        : 'mismatch';
    if (leafCheck === 'mismatch') {
      return {
        ok: false,
        recoveredSigner: recovered,
        signerMatchesAttester: true,
        leafCheck,
        membership: 'skipped',
        reason: 'candidateLeaf does not hash to plaintextLeafHash — the leaf supplied is not the one attested',
      };
    }
  }

  let membership: VerifyMemberAttestationResult['membership'] = 'skipped';
  if (membershipResolver) {
    try {
      const m = await membershipResolver({
        chainId: attestation.payload.chainId,
        contextGraphId: attestation.payload.contextGraphId,
        attesterAddress: attestation.payload.attesterAddress,
        attestedAt: attestation.payload.attestedAt,
      });
      membership = m === true ? 'confirmed' : m === false ? 'denied' : 'unknown';
      if (membership === 'denied') {
        return {
          ok: false,
          recoveredSigner: recovered,
          signerMatchesAttester: true,
          leafCheck,
          membership,
          reason: 'attester was not a CG member at attestation time',
        };
      }
    } catch (err: any) {
      membership = 'unknown';
    }
  }

  return {
    ok: true,
    recoveredSigner: recovered,
    signerMatchesAttester: true,
    leafCheck,
    membership,
  };
}
