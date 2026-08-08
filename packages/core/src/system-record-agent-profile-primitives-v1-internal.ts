import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id';

import { canonicalizeJsonBytes, type CanonicalJsonValue } from './canonical-json.js';
import { matchAgentProfileRootAddressV1 } from './agent-profile-schema-model-v1.js';
import { assertNetworkIdV1, type NetworkIdV1 } from './sync-wire-identifiers.js';
import { snapshotDataArray, snapshotDataRecord } from './sync-wire-objects.js';
import {
  assertCanonicalChainId,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  parseCanonicalDecimalU64,
  type ChainIdV1,
  type Digest32V1,
  type EvmAddressV1,
} from './sync-wire-scalars.js';
import {
  assertCanonicalSystemRecordPeerIdV1,
  copyBoundedSystemRecordBytesV1,
  decodeUnpaddedBase64UrlV1,
  digestSystemRecordBytesV1,
  failSystemRecordObjectV1 as fail,
  SystemRecordObjectErrorV1,
  type SystemRecordObjectErrorCodeV1,
  type SystemRecordPeerPublicKeyV1,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_ED25519_PUBLIC_KEY_BYTES,
  SYSTEM_RECORD_MAX_PEER_ID_BYTES,
} from './system-record-limits-v1.js';

const UTF8 = new TextEncoder();
const RFC3339_SECONDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

export type CanonicalRfc3339SecondsV1 = string & {
  readonly __rfc3339SecondsV1: true;
};

export {
  assertCanonicalSystemRecordPeerIdV1,
  copyBoundedSystemRecordBytesV1,
  decodeUnpaddedBase64UrlV1,
  digestSystemRecordBytesV1,
  SystemRecordObjectErrorV1,
};
export type { SystemRecordObjectErrorCodeV1, SystemRecordPeerPublicKeyV1 };

export function assertCanonicalRfc3339SecondsV1(
  value: unknown,
  label = 'timestamp',
): asserts value is CanonicalRfc3339SecondsV1 {
  if (typeof value !== 'string')
    fail('system-record-scalar', `${label} must be an RFC3339 UTC second`);
  const match = RFC3339_SECONDS.exec(value);
  if (match === null || match[1] === '0000' || match[6] === '60') {
    fail('system-record-scalar', `${label} must be YYYY-MM-DDTHH:mm:ssZ without leap seconds`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== `${value.slice(0, -1)}.000Z`) {
    fail('system-record-scalar', `${label} must be a calendar-valid RFC3339 UTC second`);
  }
}

export function parseCanonicalRfc3339SecondsV1(value: CanonicalRfc3339SecondsV1): number {
  assertCanonicalRfc3339SecondsV1(value);
  return Date.parse(value);
}

export function assertSystemRecordPeerBindingV1(
  peerId: unknown,
  peerPublicKey: unknown,
): asserts peerPublicKey is SystemRecordPeerPublicKeyV1 {
  if (
    typeof peerId !== 'string' ||
    peerId.length > SYSTEM_RECORD_MAX_PEER_ID_BYTES ||
    UTF8.encode(peerId).byteLength > SYSTEM_RECORD_MAX_PEER_ID_BYTES
  ) {
    fail('system-record-scalar', 'peerId is outside its byte bound');
  }
  try {
    if (peerIdFromString(peerId).toString() !== peerId) throw new Error('noncanonical peer ID');
    const keyBytes = decodeUnpaddedBase64UrlV1(
      peerPublicKey,
      SYSTEM_RECORD_ED25519_PUBLIC_KEY_BYTES,
      'peerPublicKey',
    );
    const derived = peerIdFromPublicKey(publicKeyFromRaw(keyBytes)).toString();
    if (derived !== peerId) fail('system-record-binding', 'peerPublicKey does not derive peerId');
  } catch (cause) {
    if (cause instanceof SystemRecordObjectErrorV1) throw cause;
    fail('system-record-binding', 'peerId/public-key binding is invalid', cause);
  }
}

export function agentRootAddressV1(value: unknown): EvmAddressV1 | undefined {
  const address = matchAgentProfileRootAddressV1(value);
  if (address === null) return undefined;
  try {
    assertCanonicalEvmAddress(address, 'agent root address');
    return address as EvmAddressV1;
  } catch {
    return undefined;
  }
}

export function assertAgentRootV1(value: unknown, issuer?: string): asserts value is string {
  const rootAddress = agentRootAddressV1(value);
  if (rootAddress === undefined) {
    fail('system-record-scalar', 'agent root must be a canonical did:dkg:agent address');
  }
  if (issuer !== undefined && value !== `did:dkg:agent:${issuer}`) {
    fail('system-record-binding', 'agent root does not match its EVM issuer');
  }
}

export function digestSystemRecordJsonV1(
  domain: string,
  value: CanonicalJsonValue,
  maxBytes: number,
): Digest32V1 {
  return digestSystemRecordBytesV1(domain, canonicalizeJsonBytes(value, { maxBytes }));
}

export function snapshotSystemRecordDataRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    return snapshotDataRecord(value, label, { rejectNullValues: true });
  } catch (cause) {
    fail(
      'system-record-schema',
      cause instanceof Error ? cause.message : `${label} is invalid`,
      cause,
    );
  }
}

export function numericChainIdForNetworkV1(networkId: NetworkIdV1): ChainIdV1 {
  const separator = networkId.lastIndexOf(':');
  const chainId = separator <= 0 ? '' : networkId.slice(separator + 1);
  try {
    assertCanonicalChainId(chainId, 'network chainId');
  } catch (cause) {
    fail('system-record-binding', 'record requires a numeric chain-bound networkId', cause);
  }
  return chainId as ChainIdV1;
}

export function assertSystemRecordNetworkV1(value: unknown): asserts value is NetworkIdV1 {
  try {
    assertNetworkIdV1(value);
  } catch (cause) {
    fail('system-record-scalar', 'networkId is invalid', cause);
  }
}

export function assertSystemRecordAddressV1(
  value: unknown,
  label: string,
): asserts value is EvmAddressV1 {
  try {
    assertCanonicalEvmAddress(value, label);
  } catch (cause) {
    fail('system-record-scalar', `${label} is invalid`, cause);
  }
}

export function digest(value: unknown, label: string): asserts value is Digest32V1 {
  try {
    assertCanonicalDigest(value, label);
  } catch (cause) {
    fail('system-record-scalar', `${label} is invalid`, cause);
  }
}

export function u64(value: unknown, label: string): bigint {
  try {
    return parseCanonicalDecimalU64(value, label);
  } catch (cause) {
    fail('system-record-scalar', `${label} is invalid`, cause);
  }
}

export function digestArray(
  value: unknown,
  label: string,
  min: number,
  max: number,
): readonly Digest32V1[] {
  let snapshot: readonly unknown[];
  try {
    snapshot = snapshotDataArray(value, label, { minLength: min, maxLength: max });
  } catch (cause) {
    fail('system-record-limit', `${label} must contain ${min}-${max} closed digests`, cause);
  }
  for (let index = 0; index < snapshot.length; index += 1) {
    digest(snapshot[index], `${label}[${index}]`);
    if (index > 0 && (snapshot[index - 1] as string) >= (snapshot[index] as string)) {
      fail('system-record-order', `${label} must be sorted and duplicate-free`);
    }
  }
  return snapshot as readonly Digest32V1[];
}

export function compareSystemRecordBytesV1(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.byteLength - right.byteLength;
}
