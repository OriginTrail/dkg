/**
 * OT-RFC-38 LU-11 / OT-RFC-39 — wire format + signing for the
 * `/dkg/10.0.2/get-ciphertext-chunk` libp2p verb.
 *
 * Late-joining hosting cores (and any sharding-table-member that
 * missed a chunked SWM gossip envelope) backfill missing
 * ciphertext chunks via a signed point-to-point request against
 * any peer known to host the curated CG. The responder loads the
 * requested `(cgId, batchId, chunkIndex)` chunk from its local
 * triple-store under
 *   urn:dkg:swm:v10-publish-ciphertext-chunk/<batchId>/<i>
 * and returns the base64-encoded bytes (or a typed `denied` reason
 * — CG unknown, requester unauthorized, signature invalid, chunk
 * not present).
 *
 * Authorization (PR-A baseline): for Phase A.5 / B, the responder
 * accepts requests from the CG's agent allowlist OR from peers
 * the local agent recognises as core nodes (sharding-table cores
 * for curated CGs are bound to the CG's host roster — same set
 * the publisher's V2 ACK collector dials). PR-B promotes this to
 * an explicit `chain.isPeerInShardingTableForCg` chain read once
 * the V10 adapter exposes the getter; until then the dual-check
 * is the conservative gate (member-side or host-side, both
 * legitimate use cases).
 *
 * Wire layout for the signed digest (packed binary, 196 bytes):
 *
 *   version             : uint256              (32)
 *   contextGraphIdHash  : keccak256(utf8 id)   (32)   — binds to CG
 *   batchId             : bytes32              (32)   — V10 KC merkleRoot
 *   chunkIndex          : uint256              (32)
 *   requesterEoa        : address              (20)
 *   issuedAtMs          : uint256              (32)
 *   nonce               : bytes16              (16)
 *
 * Sign via EIP-191 personal-sign over `keccak256(packed)`. Freshness
 * window + replay LRU are shared with `host-catchup-sign.ts`
 * (`CATCHUP_REQUEST_MAX_AGE_MS` + a separately-instantiated
 * `CatchupReplayGuard`).
 *
 * Wire JSON shape stays small (one request per chunk pull) — pages
 * of multiple chunks are explicitly out of scope here. A late-joining
 * core that needs N chunks pipelines N requests; the substrate's
 * envelope-versioned dedup + libp2p multiplexing keeps overhead
 * bounded. Pipelining smarts live in the requester-side helper, not
 * on this wire.
 */

import { keccak256 } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import {
  CATCHUP_REQUEST_MAX_AGE_MS,
  CatchupReplayGuard,
} from './host-catchup-sign.js';

export const CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION = 1;

export { CatchupReplayGuard } from './host-catchup-sign.js';

export interface CiphertextChunkCatchupRequestFields {
  version: number;
  /** Wire `contextGraphId` (cleartext, hash, or numeric form — keccak'd into the digest). */
  contextGraphId: string;
  /** V10 KC merkleRoot (32 bytes) used as the batch identifier. */
  batchId: Uint8Array;
  /** Zero-based chunk index inside the batch. */
  chunkIndex: number;
  /** 0x-prefixed lowercase 20-byte hex — requester's chain EOA. */
  requesterEoa: string;
  /** Unix epoch ms when the request was minted. */
  issuedAtMs: number;
  /** 0x-prefixed lowercase 16-byte hex — replay nonce. */
  nonce: string;
}

export interface CiphertextChunkCatchupRequest extends CiphertextChunkCatchupRequestFields {
  /** 65-byte EIP-191 personal-sign signature, 0x-prefixed hex. */
  sig: string;
}

export interface CiphertextChunkCatchupResponse {
  version: number;
  /** Echoed from the request for wire-layer audit. */
  contextGraphId: string;
  /** Echoed from the request for wire-layer audit. */
  batchIdHex: string;
  /** Echoed from the request. */
  chunkIndex: number;
  /** Human-readable denial reason; mutually exclusive with `ciphertextB64`. */
  denied?: string;
  /** Base64-encoded ciphertext bytes. */
  ciphertextB64?: string;
}

export interface VerifyChunkCatchupRequestResult {
  ok: boolean;
  /** Recovered EVM address. Lowercase when ok=true. */
  recoveredSigner?: string;
  reason?: string;
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

function addressToBytes(addr: string): Uint8Array {
  validateAddress(addr, 'address');
  return hexToBytes(addr, 20);
}

function hexTo16Bytes(hex: string): Uint8Array {
  validateNonce16(hex);
  return hexToBytes(hex, 16);
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

function randomNonceHex(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let out = '0x';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

function hexToBatchId(hex: string): Uint8Array {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(stripped) || stripped.length !== 64) {
    throw new Error(`batchIdHex must be 0x + 64 hex chars (32 bytes), got "${hex}"`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function computeCiphertextChunkCatchupDigest(
  req: CiphertextChunkCatchupRequestFields,
): Uint8Array {
  if (typeof req.contextGraphId !== 'string' || req.contextGraphId.length === 0) {
    throw new Error('contextGraphId must be a non-empty string');
  }
  if (!(req.batchId instanceof Uint8Array) || req.batchId.length !== 32) {
    throw new Error('batchId must be a 32-byte Uint8Array');
  }
  if (!Number.isInteger(req.chunkIndex) || req.chunkIndex < 0) {
    throw new Error(`chunkIndex must be a non-negative integer; got ${req.chunkIndex}`);
  }
  validateAddress(req.requesterEoa, 'requesterEoa');
  validateNonce16(req.nonce);

  const contextGraphIdHash = keccak256(new TextEncoder().encode(req.contextGraphId));

  // 32 (version) + 32 (cgIdHash) + 32 (batchId) + 32 (chunkIndex)
  // + 20 (requesterEoa) + 32 (issuedAtMs) + 16 (nonce) = 196 bytes
  const packed = new Uint8Array(196);
  let off = 0;
  packed.set(uint256ToBytes(req.version), off); off += 32;
  packed.set(contextGraphIdHash, off); off += 32;
  packed.set(req.batchId, off); off += 32;
  packed.set(uint256ToBytes(req.chunkIndex), off); off += 32;
  packed.set(addressToBytes(req.requesterEoa), off); off += 20;
  packed.set(uint256ToBytes(req.issuedAtMs), off); off += 32;
  packed.set(hexTo16Bytes(req.nonce), off); off += 16;
  return keccak256(packed);
}

export interface MintCiphertextChunkCatchupRequestInput {
  contextGraphId: string;
  batchId: Uint8Array;
  chunkIndex: number;
  requesterEoa?: string;
  issuedAtMs?: number;
  nonce?: string;
  sign: (digest: Uint8Array) => Promise<string>;
  version?: number;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export async function mintSignedCiphertextChunkCatchupRequest(
  input: MintCiphertextChunkCatchupRequestInput,
): Promise<CiphertextChunkCatchupRequest> {
  const version = input.version ?? CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION;
  const issuedAtMs = input.issuedAtMs ?? Date.now();
  const nonce = (input.nonce ?? randomNonceHex()).toLowerCase();
  const claimedEoa = input.requesterEoa?.toLowerCase();

  const probeFields: CiphertextChunkCatchupRequestFields = {
    version,
    contextGraphId: input.contextGraphId,
    batchId: input.batchId,
    chunkIndex: input.chunkIndex,
    requesterEoa: claimedEoa ?? ZERO_ADDRESS,
    issuedAtMs,
    nonce,
  };

  if (claimedEoa) {
    const digest = computeCiphertextChunkCatchupDigest(probeFields);
    const sig = await input.sign(digest);
    const recovered = ethers.verifyMessage(digest, sig).toLowerCase();
    if (recovered !== claimedEoa) {
      throw new Error(
        `mintSignedCiphertextChunkCatchupRequest: requesterEoa=${claimedEoa} does not match signature signer ${recovered}.`,
      );
    }
    return { ...probeFields, sig };
  }

  const probeDigest = computeCiphertextChunkCatchupDigest(probeFields);
  const probeSig = await input.sign(probeDigest);
  const recovered = ethers.verifyMessage(probeDigest, probeSig).toLowerCase();
  const finalFields: CiphertextChunkCatchupRequestFields = { ...probeFields, requesterEoa: recovered };
  const finalDigest = computeCiphertextChunkCatchupDigest(finalFields);
  const finalSig = await input.sign(finalDigest);
  return { ...finalFields, sig: finalSig };
}

export function verifySignedCiphertextChunkCatchupRequest(
  req: CiphertextChunkCatchupRequest,
  nowMs: number,
): VerifyChunkCatchupRequestResult {
  if (!Number.isFinite(req.issuedAtMs) || req.issuedAtMs < 0) {
    return { ok: false, reason: `issuedAtMs must be a non-negative number, got ${req.issuedAtMs}` };
  }
  const ageMs = Math.abs(nowMs - req.issuedAtMs);
  if (ageMs > CATCHUP_REQUEST_MAX_AGE_MS) {
    return { ok: false, reason: `request age ${ageMs}ms > ${CATCHUP_REQUEST_MAX_AGE_MS}ms max` };
  }

  let digest: Uint8Array;
  try {
    digest = computeCiphertextChunkCatchupDigest(req);
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

export function encodeCiphertextChunkCatchupRequest(req: CiphertextChunkCatchupRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: req.version,
    contextGraphId: req.contextGraphId,
    batchIdHex: bytesToHex(req.batchId),
    chunkIndex: req.chunkIndex,
    requesterEoa: req.requesterEoa,
    issuedAtMs: req.issuedAtMs,
    nonce: req.nonce,
    sig: req.sig,
  }));
}

export function decodeCiphertextChunkCatchupRequest(bytes: Uint8Array): CiphertextChunkCatchupRequest {
  const text = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text) as Partial<{
    version: number;
    contextGraphId: string;
    batchIdHex: string;
    chunkIndex: number;
    requesterEoa: string;
    issuedAtMs: number;
    nonce: string;
    sig: string;
  }>;
  if (parsed.version !== CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION) {
    throw new Error(`Unsupported CiphertextChunkCatchup request version: ${parsed.version}`);
  }
  if (typeof parsed.contextGraphId !== 'string' || parsed.contextGraphId.length === 0) {
    throw new Error('CiphertextChunkCatchup request missing contextGraphId');
  }
  if (typeof parsed.batchIdHex !== 'string') {
    throw new Error('CiphertextChunkCatchup request missing batchIdHex');
  }
  if (typeof parsed.chunkIndex !== 'number' || !Number.isInteger(parsed.chunkIndex) || parsed.chunkIndex < 0) {
    throw new Error(`CiphertextChunkCatchup request has invalid chunkIndex: ${parsed.chunkIndex}`);
  }
  if (typeof parsed.requesterEoa !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(parsed.requesterEoa)) {
    throw new Error('CiphertextChunkCatchup request missing or malformed requesterEoa');
  }
  if (typeof parsed.issuedAtMs !== 'number' || !Number.isFinite(parsed.issuedAtMs) || parsed.issuedAtMs < 0) {
    throw new Error('CiphertextChunkCatchup request has invalid issuedAtMs');
  }
  if (typeof parsed.nonce !== 'string' || !/^0x[0-9a-fA-F]{32}$/.test(parsed.nonce)) {
    throw new Error('CiphertextChunkCatchup request missing or malformed nonce');
  }
  if (typeof parsed.sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(parsed.sig)) {
    throw new Error('CiphertextChunkCatchup request missing or malformed sig');
  }
  return {
    version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
    contextGraphId: parsed.contextGraphId,
    batchId: hexToBatchId(parsed.batchIdHex),
    chunkIndex: parsed.chunkIndex,
    requesterEoa: parsed.requesterEoa.toLowerCase(),
    issuedAtMs: parsed.issuedAtMs,
    nonce: parsed.nonce.toLowerCase(),
    sig: parsed.sig,
  };
}

export function encodeCiphertextChunkCatchupResponse(resp: CiphertextChunkCatchupResponse): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(resp));
}

export function decodeCiphertextChunkCatchupResponse(bytes: Uint8Array): CiphertextChunkCatchupResponse {
  const text = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text) as Partial<CiphertextChunkCatchupResponse>;
  if (parsed.version !== CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION) {
    throw new Error(`Unsupported CiphertextChunkCatchup response version: ${parsed.version}`);
  }
  if (typeof parsed.contextGraphId !== 'string') {
    throw new Error('CiphertextChunkCatchup response missing contextGraphId');
  }
  if (typeof parsed.batchIdHex !== 'string') {
    throw new Error('CiphertextChunkCatchup response missing batchIdHex');
  }
  if (typeof parsed.chunkIndex !== 'number') {
    throw new Error('CiphertextChunkCatchup response missing chunkIndex');
  }
  if (parsed.denied !== undefined && parsed.ciphertextB64 !== undefined) {
    throw new Error('CiphertextChunkCatchup response sets both denied and ciphertextB64');
  }
  return {
    version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
    contextGraphId: parsed.contextGraphId,
    batchIdHex: parsed.batchIdHex,
    chunkIndex: parsed.chunkIndex,
    ...(typeof parsed.denied === 'string' ? { denied: parsed.denied } : {}),
    ...(typeof parsed.ciphertextB64 === 'string' ? { ciphertextB64: parsed.ciphertextB64 } : {}),
  };
}

/**
 * Re-export for module-internal users; importing both
 * `CatchupReplayGuard` and our own typed surface from this single
 * module keeps the agent wiring tight.
 */
export type { VerifyCatchupRequestResult } from './host-catchup-sign.js';

/** Sentinel for the chunked-catchup nonce replay set, dimensionally similar to host-catchup. */
export const CIPHERTEXT_CHUNK_CATCHUP_REPLAY_LRU_MAX = 8 * 1024;

export function createCiphertextChunkCatchupReplayGuard(): CatchupReplayGuard {
  return new CatchupReplayGuard(CIPHERTEXT_CHUNK_CATCHUP_REPLAY_LRU_MAX);
}
