/**
 * OT-RFC-38 LU-6 — Signed `swm-host-catchup` request authentication.
 *
 * Closes the metadata-leak vector flagged by Codex on PR #610: pre-fix,
 * any peer that knew or guessed a `contextGraphId` could pull stored
 * envelopes from a host-only core. Ciphertext is useless without the
 * curator-issued chain key, but the activity metadata (existence,
 * timing, volume per peer) still leaked. The local `allowedPeers`
 * mitigation only covers member-side nodes that have the CG's peer
 * allowlist persisted — host-only cores never have that list and
 * fell through to unauthenticated serving.
 *
 * This module adds an EIP-191 signature on every catchup request,
 * letting the responder verify the requester's chain-EOA identity
 * regardless of transport peer-id. The agent then cross-references
 * the recovered EOA against the on-chain participant set (or, for
 * pre-registration CGs, the beacon-pinned curator EOA) — the same
 * authority sources the SWM ingest path already uses.
 *
 * Wire layout for the signed digest (packed binary, 228 bytes):
 *
 *   version             : uint256              (32)   — wire version
 *   contextGraphIdHash  : keccak256(utf8 id)   (32)   — binds to CG
 *   sinceSeqno          : uint256              (32)
 *   maxEntries          : uint256              (32)   — 0 means unset
 *   maxBytes            : uint256              (32)
 *   requesterEoa        : address              (20)
 *   issuedAtMs          : uint256              (32)   — wall clock
 *   nonce               : bytes16              (16)   — replay-defence
 *
 * The digest is `keccak256(packed)`, signed via EIP-191 personal-sign
 * so the same chain adapter that signs beacons + attestations works
 * verbatim. We use packed bytes rather than JSON to avoid canonical-
 * isation surprises across runtimes — the verifier hand-computes the
 * same buffer and recovers the signer.
 *
 * Freshness: the responder enforces `|now - issuedAtMs| <=
 * CATCHUP_REQUEST_MAX_AGE_MS` (5 min). Combined with the per-server
 * nonce LRU, this bounds replay to a small wall-clock window even if
 * an attacker exfiltrates a valid request from the wire.
 */

import { keccak256 } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

/**
 * Maximum wall-clock skew between the client's `issuedAtMs` and the
 * responder's local time. 5 minutes matches the SWM envelope freshness
 * window (`workspace-handler.ts`) so operators tune one knob.
 */
export const CATCHUP_REQUEST_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Soft cap on the per-responder nonce-replay set. Tuned for 1 req/peer/sec
 * sustained across ~16 concurrent peers over the freshness window
 * (16 * 60 * 5 ≈ 5K). Going above this evicts oldest-first; freshness
 * still bounds replay once a nonce drops out, so the cap is a memory
 * guard, not a security guarantee.
 */
export const CATCHUP_REPLAY_NONCE_LRU_MAX = 8 * 1024;

export interface SignedCatchupRequestFields {
  version: number;
  contextGraphId: string;
  sinceSeqno: number;
  maxEntries: number;
  maxBytes: number;
  requesterEoa: string;
  issuedAtMs: number;
  /** 0x-prefixed lowercase 32-hex-char string (16 bytes). */
  nonce: string;
}

export interface SignedCatchupRequest extends SignedCatchupRequestFields {
  /** 65-byte EIP-191 personal-sign signature, 0x-prefixed hex. */
  sig: string;
}

export interface VerifyCatchupRequestResult {
  ok: boolean;
  /** Recovered EVM address. Lowercase when ok=true. */
  recoveredSigner?: string;
  reason?: string;
}

/**
 * Compute the digest the requester signs. Layout matches the doc-
 * comment at the top of this file. Verifier MUST hand-compute the
 * same buffer — JSON canonicalisation is deliberately out of scope.
 *
 * `req.contextGraphId` is hashed (`keccak256(utf8(...))`) on both
 * sides so the digest binds to a canonical 32-byte identifier
 * regardless of whether the wire form is cleartext, hash, or numeric.
 * This keeps the wire `contextGraphId` field compatible with the
 * existing host-mode store keying (sha256 over whatever string the
 * member passed) — the wire id and the signed id need not be the
 * same shape, only the latter needs to be canonical.
 */
export function computeCatchupRequestDigest(req: SignedCatchupRequestFields): Uint8Array {
  if (typeof req.contextGraphId !== 'string' || req.contextGraphId.length === 0) {
    throw new Error('contextGraphId must be a non-empty string');
  }
  validateAddress(req.requesterEoa, 'requesterEoa');
  validateNonce16(req.nonce);

  const contextGraphIdHash = keccak256(new TextEncoder().encode(req.contextGraphId));

  // 32 (version) + 32 (cgIdHash) + 32 (sinceSeqno) + 32 (maxEntries)
  // + 32 (maxBytes) + 20 (requesterEoa) + 32 (issuedAtMs) + 16 (nonce)
  // = 228 bytes
  const packed = new Uint8Array(228);
  let off = 0;
  packed.set(uint256ToBytes(req.version), off); off += 32;
  packed.set(contextGraphIdHash, off); off += 32;
  packed.set(uint256ToBytes(req.sinceSeqno), off); off += 32;
  packed.set(uint256ToBytes(req.maxEntries), off); off += 32;
  packed.set(uint256ToBytes(req.maxBytes), off); off += 32;
  packed.set(addressToBytes(req.requesterEoa), off); off += 20;
  packed.set(uint256ToBytes(req.issuedAtMs), off); off += 32;
  packed.set(hexTo16Bytes(req.nonce), off); off += 16;
  return keccak256(packed);
}

export interface MintSignedCatchupRequestInput {
  /** Wire `contextGraphId` (cleartext, hash, or numeric form — keccak'd into the digest). */
  contextGraphId: string;
  sinceSeqno: number;
  maxEntries: number;
  maxBytes: number;
  /**
   * Optional. If provided, MUST match the address recovered from
   * `sign(digest)`; otherwise the mint throws. If omitted, the
   * helper computes the digest with a placeholder zero address,
   * recovers the signer from the signature, then re-computes the
   * digest binding to that recovered address.
   *
   * Codex PR #618 round-2: callers used to advertise the chain
   * tx-signer address here (`getRegistrationTxSignerAddress`), but
   * `sign` is wired to `chain.signMessage` which CAN sign with a
   * different key (per its own helper comment). The receiver's
   * verify step then rejected every request as "signer mismatch".
   * Letting the helper recover the truth from the signature itself
   * removes that whole class of mis-binding.
   */
  requesterEoa?: string;
  /** Unix epoch ms. Defaults to Date.now(). */
  issuedAtMs?: number;
  /** Hex-encoded 16-byte nonce. Auto-generated if omitted. */
  nonce?: string;
  /**
   * Wallet-agnostic signer. Returns EIP-191 personal-sign signature
   * (65-byte 0x-prefixed hex) over the supplied digest. Same shape
   * as `mintCgDiscoveryBeacon` so callers can pass the same lambda
   * (chain adapter's signMessage).
   */
  sign: (digest: Uint8Array) => Promise<string>;
  /** Wire version to mint at. Defaults to 2 (current). */
  version?: number;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export async function mintSignedCatchupRequest(
  input: MintSignedCatchupRequestInput,
): Promise<SignedCatchupRequest> {
  const version = input.version ?? 2;
  const issuedAtMs = input.issuedAtMs ?? Date.now();
  const nonce = input.nonce ?? randomNonceHex();

  // Two-pass to bind the digest to the actual signer:
  // 1. Compute digest with claimed-or-placeholder address.
  // 2. Sign it. Recover the address from the signature.
  // 3. If claim was provided: require match (fail closed).
  //    If not: re-build the request bound to the recovered
  //    address and sign that.
  const claimedEoa = input.requesterEoa?.toLowerCase();
  const probeFields: SignedCatchupRequestFields = {
    version,
    contextGraphId: input.contextGraphId,
    sinceSeqno: input.sinceSeqno,
    maxEntries: input.maxEntries,
    maxBytes: input.maxBytes,
    requesterEoa: claimedEoa ?? ZERO_ADDRESS,
    issuedAtMs,
    nonce: nonce.toLowerCase(),
  };

  if (claimedEoa) {
    // Caller asserts the signer address. Sign + verify recovery matches.
    const digest = computeCatchupRequestDigest(probeFields);
    const sig = await input.sign(digest);
    const recovered = ethers.verifyMessage(digest, sig).toLowerCase();
    if (recovered !== claimedEoa) {
      throw new Error(
        `mintSignedCatchupRequest: requesterEoa=${claimedEoa} does not match signature signer ${recovered}. ` +
          'Drop the explicit requesterEoa and let the helper bind to the actual signer, ' +
          'or pass the chain.signMessage()-paired EOA.',
      );
    }
    return { ...probeFields, sig };
  }

  // Discovery mode: sign a placeholder digest, recover the signer,
  // then sign the FINAL digest with the bound address. Two sigs, but
  // only the second one is ever sent over the wire.
  const probeDigest = computeCatchupRequestDigest(probeFields);
  const probeSig = await input.sign(probeDigest);
  const recovered = ethers.verifyMessage(probeDigest, probeSig).toLowerCase();
  const finalFields: SignedCatchupRequestFields = { ...probeFields, requesterEoa: recovered };
  const finalDigest = computeCatchupRequestDigest(finalFields);
  const finalSig = await input.sign(finalDigest);
  return { ...finalFields, sig: finalSig };
}

/**
 * Verify a received signed catchup request. Checks:
 *   1. Freshness: |nowMs - issuedAtMs| <= CATCHUP_REQUEST_MAX_AGE_MS.
 *   2. Signature: EIP-191 recovers exactly `req.requesterEoa`.
 *
 * Does NOT check authorization (participant-set membership) — that's
 * the caller's job because it depends on chain reads + local meta
 * the verifier doesn't see. Does NOT check replay-nonce uniqueness —
 * that's a separate stateful check, see {@link CatchupReplayGuard}.
 */
export function verifySignedCatchupRequest(
  req: SignedCatchupRequest,
  nowMs: number,
): VerifyCatchupRequestResult {
  if (!Number.isFinite(req.issuedAtMs) || req.issuedAtMs < 0) {
    return { ok: false, reason: `issuedAtMs must be a non-negative number, got ${req.issuedAtMs}` };
  }
  const ageMs = Math.abs(nowMs - req.issuedAtMs);
  if (ageMs > CATCHUP_REQUEST_MAX_AGE_MS) {
    return { ok: false, reason: `request age ${ageMs}ms > ${CATCHUP_REQUEST_MAX_AGE_MS}ms max` };
  }

  let digest: Uint8Array;
  try {
    digest = computeCatchupRequestDigest(req);
  } catch (err) {
    return { ok: false, reason: `digest computation failed: ${(err as Error)?.message ?? err}` };
  }

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(digest, req.sig).toLowerCase();
  } catch (err: unknown) {
    return { ok: false, reason: `signature recovery failed: ${(err as Error)?.message ?? err}` };
  }

  if (recovered !== req.requesterEoa) {
    return { ok: false, reason: `signer mismatch: recovered ${recovered}, claimed ${req.requesterEoa}` };
  }

  return { ok: true, recoveredSigner: recovered };
}

/**
 * Per-responder replay-defence cache for catchup-request nonces.
 * Reject any (requesterEoa, nonce) seen within the freshness window.
 * Once a nonce ages out (LRU eviction), the freshness check is the
 * only line of defence — that's acceptable because the issuedAtMs is
 * inside the signed digest, so the attacker can't refresh it without
 * the signer's private key.
 */
export class CatchupReplayGuard {
  private readonly seen = new Map<string, number>(); // key -> issuedAtMs
  private readonly maxEntries: number;

  constructor(maxEntries = CATCHUP_REPLAY_NONCE_LRU_MAX) {
    this.maxEntries = maxEntries;
  }

  /**
   * Returns true iff the (requesterEoa, nonce) pair is fresh — i.e.
   * not seen before. False return = the pair was a replay and the
   * caller should reject the request. Mutates internal state on
   * accept (recording the nonce).
   */
  recordIfFresh(requesterEoa: string, nonce: string, issuedAtMs: number, nowMs: number): boolean {
    this.evictStale(nowMs);
    const key = `${requesterEoa.toLowerCase()}:${nonce.toLowerCase()}`;
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.maxEntries) {
      // Map iteration order is insertion order; oldest first.
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey !== undefined) this.seen.delete(oldestKey);
    }
    this.seen.set(key, issuedAtMs);
    return true;
  }

  size(): number {
    return this.seen.size;
  }

  private evictStale(nowMs: number): void {
    const threshold = nowMs - CATCHUP_REQUEST_MAX_AGE_MS;
    for (const [key, issuedAtMs] of this.seen) {
      if (issuedAtMs < threshold) {
        this.seen.delete(key);
      } else {
        // Insertion order = ascending issuedAtMs (approximately),
        // so first non-stale entry means rest are also fresh.
        break;
      }
    }
  }
}

function randomNonceHex(): string {
  const bytes = new Uint8Array(16);
  // Node + browser both expose crypto.getRandomValues; the agent
  // ships against Node ≥18 which has it on globalThis.crypto.
  const c = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    // Fallback for legacy embeddings without crypto on globalThis.
    // Math.random is NOT cryptographically secure, but the nonce is
    // belt-and-braces (signature already binds the request); use it
    // only when no secure RNG is available.
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function uint256ToBytes(n: number): Uint8Array {
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`uint256 input must be a non-negative finite number, got ${n}`);
  }
  const out = new Uint8Array(32);
  let value = BigInt(Math.floor(n));
  for (let i = 31; i >= 0 && value > 0n; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function hexTo16Bytes(hex: string): Uint8Array {
  validateNonce16(hex);
  return hexToBytes(hex, 16);
}

function addressToBytes(addr: string): Uint8Array {
  validateAddress(addr, 'address');
  return hexToBytes(addr, 20);
}

function hexToBytes(hex: string, expectedLen: number): Uint8Array {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (stripped.length !== expectedLen * 2) {
    throw new Error(`expected ${expectedLen}-byte hex, got ${stripped.length / 2}`);
  }
  const out = new Uint8Array(expectedLen);
  for (let i = 0; i < expectedLen; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function validateAddress(hex: string, field: string): void {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(hex)) {
    throw new Error(`${field} must be 0x + 40 hex chars (20 bytes), got ${hex}`);
  }
}

function validateNonce16(hex: string): void {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`nonce must be 0x + 32 hex chars (16 bytes), got ${hex}`);
  }
}
