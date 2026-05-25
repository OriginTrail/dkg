/**
 * OT-RFC-38 LU-6 Phase B — Curated CG Discovery Beacon.
 *
 * Solves the **pre-registration auto-host gap**: cores need to start
 * hosting opaque ciphertext for a curated CG BEFORE the curator pays
 * gas to register it on chain (freemium-tier intent — see RFC §1.2).
 * Without this, the only auto-host path is the `ContextGraphCreated`
 * chain event, which fires only after registration; an unregistered
 * CG's SWM gossip would arrive on a topic no core is subscribed to,
 * and every share would fail the publisher's ack-quorum.
 *
 * **Protocol** (`topic = DKG_CG_DISCOVERY_TOPIC = "dkg/cg-discovery"`):
 *
 *   - Curator broadcasts a signed beacon at CG-create time AND
 *     periodically re-announces (default every 5 min) so cores joining
 *     late still pick it up.
 *
 *   - Beacon payload commits to the wire-form id (`nameHash`, i.e.
 *     `keccak256(bytes(cleartextId))`) + accessPolicy + curator EOA +
 *     wall-clock timestamp + EIP-191 signature by the curator EOA.
 *
 *   - Cores verify the signature, apply rate limits (see
 *     `discovery-rate-limit.ts`), and on accept call
 *     `reconcileSwmHostModeSubscription(nameHash)` — same path the
 *     `ContextGraphCreated` event takes, so post-registration cores
 *     converge on the same hosting state regardless of which signal
 *     triggered the subscription.
 *
 * **Wire encoding**: JSON. Beacons are small (~250 bytes) and human-
 * debuggable matters more here than wire-density — the per-CG byte
 * budget (and abuse vector) is dominated by SWM ciphertext, not
 * beacons. We deliberately avoid protobuf framing to keep the cross-
 * agent dependency surface tiny.
 *
 * **Replay protection**: cores reject any beacon whose `ts` is more
 * than `BEACON_MAX_AGE_SECONDS` away from local wall clock. Curators
 * MUST re-broadcast on their re-announce timer to keep timestamps
 * fresh; the protocol explicitly forbids long-lived caching at the
 * curator side.
 *
 * **Privacy**: the beacon broadcasts the curator's EOA and the
 * cleartext-hash, BUT NOT the cleartext name. Cores hosting the CG
 * never see the cleartext (just like the chain-event path). The
 * curator's EOA on-chain visibility is already public when they
 * eventually register, so there is no new leak. Pre-registration
 * curators who haven't paid gas yet do leak their EOA earlier than
 * they otherwise would — a deliberate trade-off for the freemium
 * tier (see RFC §1.2).
 */

import { keccak256 } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

/** GossipSub topic for curator-broadcast CG discovery beacons. Global, not per-CG. */
export const DKG_CG_DISCOVERY_TOPIC = 'dkg/cg-discovery';

/** Beacon protocol version. Bump on incompatible wire changes. */
export const BEACON_VERSION = 1;

/**
 * Maximum wall-clock skew (seconds) between the beacon's `ts` and
 * the verifier's local time. Beacons outside this window are rejected
 * to bound replay attacks. Generous default (10 min) accommodates
 * NTP drift on consumer hardware AND the periodic re-announce
 * cadence (5 min), so a beacon that races a single re-announce tick
 * is still inside the window.
 */
export const BEACON_MAX_AGE_SECONDS = 10 * 60;

/**
 * Recommended re-announce interval. Curators SHOULD re-broadcast each
 * pre-registration beacon at this cadence so cores joining late can
 * still discover the CG before the curator pays gas to register.
 */
export const BEACON_REANNOUNCE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * On-chain access policy enum mirrored on the wire so cores can decide
 * whether to host before any chain read. Values match
 * `ContextGraphAccessPolicy` in `evm-module/contracts/storage/`.
 */
export const BEACON_ACCESS_POLICY_PUBLIC = 0;
export const BEACON_ACCESS_POLICY_CURATED = 1;

export interface CgDiscoveryBeacon {
  /** Beacon protocol version. */
  v: number;
  /**
   * 0x-prefixed lowercase 32-byte hex — `keccak256(bytes(cleartextId))`.
   * The curator-committed wire id; used as the SWM gossip topic key
   * once a core auto-subscribes.
   */
  nameHash: string;
  /** 0 (public) or 1 (curated). Cores only auto-host curated CGs. */
  accessPolicy: number;
  /** 0x-prefixed lowercase 20-byte hex — the EOA that signed `sig`. */
  curatorEoa: string;
  /** Unix epoch seconds. Used by the BEACON_MAX_AGE_SECONDS check. */
  ts: number;
  /** EIP-191 personal-sign signature over `computeBeaconDigest(this)`. */
  sig: string;
}

/**
 * Compute the digest the curator signs. Layout matches
 * `member-attestation.ts` — packed binary so verifiers can hand-
 * compute without JSON canonicalisation surprises:
 *
 *   version       : uint256 (32)
 *   nameHash      : bytes32 (32)
 *   accessPolicy  : uint256 (32)
 *   curatorEoa    : address (20)
 *   ts            : uint256 (32)
 *
 * Total: 148 bytes. keccak256 over the packed buffer.
 */
export function computeBeaconDigest(beacon: Omit<CgDiscoveryBeacon, 'sig'>): Uint8Array {
  const packed = new Uint8Array(148);
  let off = 0;
  packed.set(uint256ToBytes(beacon.v), off); off += 32;
  packed.set(hexTo32Bytes(beacon.nameHash), off); off += 32;
  packed.set(uint256ToBytes(beacon.accessPolicy), off); off += 32;
  packed.set(addressToBytes(beacon.curatorEoa), off); off += 20;
  packed.set(uint256ToBytes(beacon.ts), off); off += 32;
  return keccak256(packed);
}

export interface MintBeaconInput {
  nameHash: string;
  accessPolicy: number;
  curatorEoa: string;
  /** Unix epoch seconds. Defaults to `Math.floor(Date.now() / 1000)`. */
  ts?: number;
  /**
   * Wallet-agnostic signer. Hands back an EIP-191 personal-sign
   * signature (65-byte 0x-prefixed hex) over the supplied digest.
   * The agent wires this to either an in-process ethers Wallet
   * (when a curator private key is configured) or to the chain
   * adapter's `signMessage` (for hardware-/keychain-backed signers).
   */
  sign: (digest: Uint8Array) => Promise<string>;
}

export async function mintCgDiscoveryBeacon(input: MintBeaconInput): Promise<CgDiscoveryBeacon> {
  validateNameHash(input.nameHash);
  validateAddress(input.curatorEoa, 'curatorEoa');
  if (input.accessPolicy !== BEACON_ACCESS_POLICY_PUBLIC && input.accessPolicy !== BEACON_ACCESS_POLICY_CURATED) {
    throw new Error(`accessPolicy must be 0 or 1, got ${input.accessPolicy}`);
  }

  const ts = input.ts ?? Math.floor(Date.now() / 1000);
  const unsigned: Omit<CgDiscoveryBeacon, 'sig'> = {
    v: BEACON_VERSION,
    nameHash: input.nameHash.toLowerCase(),
    accessPolicy: input.accessPolicy,
    curatorEoa: input.curatorEoa.toLowerCase(),
    ts,
  };
  const digest = computeBeaconDigest(unsigned);
  const sig = await input.sign(digest);
  return { ...unsigned, sig };
}

export interface VerifyBeaconResult {
  ok: boolean;
  /** Recovered EVM address. Always lowercase when ok=true. */
  recoveredSigner?: string;
  /** Human-readable rejection reason when ok=false. */
  reason?: string;
}

/**
 * Verify a received beacon. Three checks:
 *   1. Schema: required fields present + nameHash/eoa well-formed.
 *   2. Freshness: |ts - nowSeconds| <= BEACON_MAX_AGE_SECONDS.
 *   3. Signature: EIP-191 recovers exactly `beacon.curatorEoa`.
 *
 * Does NOT consult chain state — that's the caller's job (e.g. the
 * core may also verify that `curatorEoa` is the on-chain curator
 * once the CG is registered, but the pre-registration path has no
 * on-chain reference to compare against, so this module deliberately
 * stays chain-free).
 */
export function verifyCgDiscoveryBeacon(beacon: unknown, nowSeconds: number): VerifyBeaconResult {
  if (!isBeaconShape(beacon)) {
    return { ok: false, reason: 'malformed beacon: missing required fields' };
  }

  if (beacon.v !== BEACON_VERSION) {
    return { ok: false, reason: `unsupported beacon version ${beacon.v}` };
  }

  if (!/^0x[0-9a-f]{64}$/.test(beacon.nameHash)) {
    return { ok: false, reason: 'nameHash must be 0x + 64 lowercase hex chars' };
  }
  if (!/^0x[0-9a-f]{40}$/.test(beacon.curatorEoa)) {
    return { ok: false, reason: 'curatorEoa must be 0x + 40 lowercase hex chars' };
  }
  if (beacon.accessPolicy !== BEACON_ACCESS_POLICY_PUBLIC && beacon.accessPolicy !== BEACON_ACCESS_POLICY_CURATED) {
    return { ok: false, reason: `accessPolicy must be 0 or 1, got ${beacon.accessPolicy}` };
  }
  if (!Number.isFinite(beacon.ts) || beacon.ts < 0) {
    return { ok: false, reason: `ts must be a non-negative unix epoch (seconds), got ${beacon.ts}` };
  }

  const ageSeconds = Math.abs(nowSeconds - beacon.ts);
  if (ageSeconds > BEACON_MAX_AGE_SECONDS) {
    return { ok: false, reason: `beacon ts skew ${ageSeconds}s > ${BEACON_MAX_AGE_SECONDS}s max` };
  }

  const digest = computeBeaconDigest({
    v: beacon.v,
    nameHash: beacon.nameHash,
    accessPolicy: beacon.accessPolicy,
    curatorEoa: beacon.curatorEoa,
    ts: beacon.ts,
  });

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(digest, beacon.sig).toLowerCase();
  } catch (err: unknown) {
    return { ok: false, reason: `signature recovery failed: ${(err as Error)?.message ?? err}` };
  }

  if (recovered !== beacon.curatorEoa) {
    return { ok: false, reason: `signer mismatch: recovered ${recovered}, claimed ${beacon.curatorEoa}` };
  }

  return { ok: true, recoveredSigner: recovered };
}

/** JSON wire envelope. Use these on the GossipSub layer. */
export function encodeCgDiscoveryBeacon(beacon: CgDiscoveryBeacon): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(beacon));
}

export function decodeCgDiscoveryBeacon(bytes: Uint8Array): CgDiscoveryBeacon | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text);
    if (!isBeaconShape(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isBeaconShape(x: unknown): x is CgDiscoveryBeacon {
  if (!x || typeof x !== 'object') return false;
  const b = x as Record<string, unknown>;
  return (
    typeof b.v === 'number' &&
    typeof b.nameHash === 'string' &&
    typeof b.accessPolicy === 'number' &&
    typeof b.curatorEoa === 'string' &&
    typeof b.ts === 'number' &&
    typeof b.sig === 'string'
  );
}

function validateNameHash(hash: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(`nameHash must be 0x + 64 hex chars, got ${hash}`);
  }
}

function validateAddress(addr: string, field: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(`${field} must be 0x + 40 hex chars, got ${addr}`);
  }
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

function hexTo32Bytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length !== 64) throw new Error(`expected 32-byte hex, got ${clean.length / 2} bytes`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function addressToBytes(addr: string): Uint8Array {
  const clean = addr.toLowerCase().replace(/^0x/, '');
  if (clean.length !== 40) throw new Error(`invalid address: ${addr}`);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
