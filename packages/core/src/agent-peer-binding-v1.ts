// SPDX-License-Identifier: Apache-2.0

/**
 * Wallet-authorized binding between one exact libp2p peer and an EVM agent.
 *
 * The artifact is intentionally transport- and storage-neutral. A resolver
 * must obtain a complete candidate set from its trusted local view before it
 * can apply the monotonic `bindingVersion` high-water rule safely.
 */

import { peerIdFromString } from '@libp2p/peer-id';

import {
  canonicalizeJsonBytes,
  type CanonicalJsonValue,
} from './canonical-json.js';
import {
  assertCanonicalDecimalU64,
  assertCanonicalEvmAddress,
  assertCanonicalHexBytes,
  assertCanonicalTimestampMs,
  type DecimalU64V1,
  type EvmAddressV1,
  type TimestampMsV1,
} from './sync-wire-scalars.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';

export const AGENT_PEER_BINDING_KIND_V1 = 'dkg-agent-peer-binding-v1' as const;
export const AGENT_PEER_BINDING_SCHEMA_VERSION_V1 = '1' as const;
export const AGENT_PEER_BINDING_SIGNATURE_DOMAIN_V1 =
  'dkg-agent-peer-binding-signature-v1\n' as const;

const SIGNATURE_DOMAIN_BYTES = new TextEncoder().encode(
  AGENT_PEER_BINDING_SIGNATURE_DOMAIN_V1,
);
const MAX_CANONICAL_PEER_ID_LENGTH_V1 = 256;

declare const canonicalLibp2pPeerIdBrandV1: unique symbol;
export type CanonicalLibp2pPeerIdV1 = string & {
  readonly [canonicalLibp2pPeerIdBrandV1]: true;
};

export type AgentPeerBindingStateV1 = 'active' | 'revoked';

export interface AgentPeerBindingPayloadV1 {
  readonly kind: typeof AGENT_PEER_BINDING_KIND_V1;
  readonly schemaVersion: typeof AGENT_PEER_BINDING_SCHEMA_VERSION_V1;
  /** Monotonic high-water version within this wallet+peer binding history. */
  readonly bindingVersion: DecimalU64V1;
  readonly agentAddress: EvmAddressV1;
  readonly peerId: CanonicalLibp2pPeerIdV1;
  readonly validFromMs: TimestampMsV1;
  /** Required finite replay bound; validity is the half-open interval [from, expires). */
  readonly expiresAtMs: TimestampMsV1;
  /** A revoked high-water version prevents fallback to every lower active version. */
  readonly state: AgentPeerBindingStateV1;
}

export interface SignedAgentPeerBindingV1 extends AgentPeerBindingPayloadV1 {
  /** Canonical 65-byte EIP-191 signature by `agentAddress`. */
  readonly signature: string;
}

export interface VerifiedAgentPeerBindingV1 extends SignedAgentPeerBindingV1 {
  readonly peerId: CanonicalLibp2pPeerIdV1;
  readonly agentAddress: EvmAddressV1;
}

export type AgentPeerBindingWalletSignatureVerifierV1 = (
  message: Uint8Array,
  signature: string,
  expectedAgentAddress: EvmAddressV1,
) => boolean | Promise<boolean>;

/** Parse one peer ID and require its exact canonical string representation. */
export function parseCanonicalLibp2pPeerIdV1(value: unknown): CanonicalLibp2pPeerIdV1 {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_CANONICAL_PEER_ID_LENGTH_V1
  ) {
    throw new Error('peerId must be a bounded canonical libp2p peer ID string');
  }
  let canonical: string;
  try {
    canonical = peerIdFromString(value).toString();
  } catch (cause) {
    throw new Error('peerId is not a valid libp2p peer ID', { cause });
  }
  if (canonical !== value) {
    throw new Error('peerId must use its exact canonical libp2p string representation');
  }
  return value as CanonicalLibp2pPeerIdV1;
}

/** Return the exact domain-separated bytes signed with EIP-191 personal_sign. */
export function canonicalizeAgentPeerBindingSigningBytesV1(
  payload: AgentPeerBindingPayloadV1,
): Uint8Array {
  const bounded = snapshotAgentPeerBindingPayloadV1(payload);
  const canonicalPayload = canonicalizeJsonBytes(toCanonicalPayload(bounded), {
    maxBytes: 2 * 1024,
    maxDepth: 2,
  });
  const result = new Uint8Array(SIGNATURE_DOMAIN_BYTES.length + canonicalPayload.length);
  result.set(SIGNATURE_DOMAIN_BYTES, 0);
  result.set(canonicalPayload, SIGNATURE_DOMAIN_BYTES.length);
  return result;
}

/**
 * Verify the closed artifact shape and its wallet signature.
 *
 * Validity/current/high-water selection deliberately belongs to the resolver:
 * verifying an expired high-water artifact and then refusing to fall back is
 * safer than filtering it out before version selection.
 */
export async function verifySignedAgentPeerBindingV1(
  value: unknown,
  verifyWalletSignature: AgentPeerBindingWalletSignatureVerifierV1,
): Promise<Readonly<VerifiedAgentPeerBindingV1>> {
  if (typeof verifyWalletSignature !== 'function') {
    throw new TypeError('agent peer binding wallet signature verifier is required');
  }
  if (!isPlainRecord(value)) {
    throw new Error('signed agent peer binding must be a plain object');
  }
  assertExactKeys(value, [
    'agentAddress',
    'bindingVersion',
    'expiresAtMs',
    'kind',
    'peerId',
    'schemaVersion',
    'signature',
    'state',
    'validFromMs',
  ], 'signed agent peer binding');
  const payload = snapshotAgentPeerBindingPayloadV1(value);
  assertCanonicalHexBytes(value.signature, 'agent peer binding signature', 65, 65);
  const valid = await verifyWalletSignature(
    canonicalizeAgentPeerBindingSigningBytesV1(payload),
    value.signature,
    payload.agentAddress,
  );
  if (valid !== true) {
    throw new Error('agent peer binding wallet signature is invalid');
  }
  return Object.freeze({
    ...payload,
    signature: value.signature,
  });
}

function snapshotAgentPeerBindingPayloadV1(
  value: unknown,
): Readonly<AgentPeerBindingPayloadV1> {
  if (!isPlainRecord(value)) {
    throw new Error('agent peer binding payload must be a plain object');
  }
  const expectedPayloadKeys = [
    'agentAddress',
    'bindingVersion',
    'expiresAtMs',
    'kind',
    'peerId',
    'schemaVersion',
    'state',
    'validFromMs',
  ] as const;
  const hasSignature = Object.prototype.hasOwnProperty.call(value, 'signature');
  assertExactKeys(
    value,
    hasSignature ? [...expectedPayloadKeys, 'signature'] : expectedPayloadKeys,
    'agent peer binding payload',
  );
  if (value.kind !== AGENT_PEER_BINDING_KIND_V1) {
    throw new Error('unsupported agent peer binding kind');
  }
  if (value.schemaVersion !== AGENT_PEER_BINDING_SCHEMA_VERSION_V1) {
    throw new Error('unsupported agent peer binding schema version');
  }
  assertCanonicalDecimalU64(value.bindingVersion, 'bindingVersion');
  assertCanonicalEvmAddress(value.agentAddress, 'agentAddress');
  const peerId = parseCanonicalLibp2pPeerIdV1(value.peerId);
  assertCanonicalTimestampMs(value.validFromMs, 'validFromMs');
  assertCanonicalTimestampMs(value.expiresAtMs, 'expiresAtMs');
  if (BigInt(value.expiresAtMs) <= BigInt(value.validFromMs)) {
    throw new Error('expiresAtMs must be greater than validFromMs');
  }
  if (value.state !== 'active' && value.state !== 'revoked') {
    throw new Error('agent peer binding state must be active or revoked');
  }
  return Object.freeze({
    kind: AGENT_PEER_BINDING_KIND_V1,
    schemaVersion: AGENT_PEER_BINDING_SCHEMA_VERSION_V1,
    bindingVersion: value.bindingVersion,
    agentAddress: value.agentAddress,
    peerId,
    validFromMs: value.validFromMs,
    expiresAtMs: value.expiresAtMs,
    state: value.state,
  });
}

function toCanonicalPayload(
  payload: AgentPeerBindingPayloadV1,
): CanonicalJsonValue {
  return {
    kind: payload.kind,
    schemaVersion: payload.schemaVersion,
    bindingVersion: payload.bindingVersion,
    agentAddress: payload.agentAddress,
    peerId: payload.peerId,
    validFromMs: payload.validFromMs,
    expiresAtMs: payload.expiresAtMs,
    state: payload.state,
  };
}
