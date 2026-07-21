import { blake3 } from '@noble/hashes/blake3.js';
import { encodeCanonicalCbor } from './canonical-cbor.js';
import { decodeProtocolTuple, encodeProtocolTuple, validateUnsignedProtocolTuple } from './codec.js';
import { protocolError } from './errors.js';
import {
  PROTOCOL_TUPLES,
  WAL_V1_DOMAINS,
  type CborProtocolValue,
  type ProtocolTuple,
  type ProtocolTupleSchema,
  type SignedProtocolTupleName,
  type WalV1DomainName,
} from './schema.js';

const textEncoder = new TextEncoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function hashWalV1Domain(domain: WalV1DomainName, ...values: readonly Uint8Array[]): Uint8Array {
  const prefix = WAL_V1_DOMAINS[domain];
  if (prefix === undefined) protocolError('WAL_ID_DOMAIN', `unknown WAL v1 hash domain ${domain}`);
  return blake3(concat([textEncoder.encode(prefix), ...values]));
}

export function protocolSignatureDigest<Name extends SignedProtocolTupleName>(
  name: Name,
  unsignedTuple: readonly CborProtocolValue[],
): Uint8Array {
  const schema: ProtocolTupleSchema | undefined = PROTOCOL_TUPLES[name];
  if (!schema?.signatureDomain) protocolError('WAL_SIGNATURE_DOMAIN', `${name} has no signature domain`);
  validateUnsignedProtocolTuple(name, unsignedTuple);
  return hashWalV1Domain(schema.signatureDomain, encodeCanonicalCbor(unsignedTuple));
}

export function protocolTupleId<Name extends SignedProtocolTupleName>(
  name: Name,
  value: ProtocolTuple<Name>,
): Uint8Array {
  const schema: ProtocolTupleSchema | undefined = PROTOCOL_TUPLES[name];
  if (!schema?.identityDomain) protocolError('WAL_ID_DOMAIN', `${name} has no identity domain`);
  return hashWalV1Domain(schema.identityDomain, encodeProtocolTuple(name, value));
}

export function protocolTupleIdFromBytes<Name extends SignedProtocolTupleName>(
  name: Name,
  bytes: Uint8Array,
): Uint8Array {
  const schema: ProtocolTupleSchema | undefined = PROTOCOL_TUPLES[name];
  if (!schema?.identityDomain) protocolError('WAL_ID_DOMAIN', `${name} has no identity domain`);
  decodeProtocolTuple(name, bytes);
  return hashWalV1Domain(schema.identityDomain, bytes);
}

export function namespaceIdV1(value: ProtocolTuple<'ReplicationViewKeyV1'>): Uint8Array {
  return hashWalV1Domain('namespaceId', encodeProtocolTuple('ReplicationViewKeyV1', value));
}

export function collectionIdV1(value: ProtocolTuple<'ReplicationCollectionKeyV1'>): Uint8Array {
  return hashWalV1Domain('collectionId', encodeProtocolTuple('ReplicationCollectionKeyV1', value));
}

export function hashCanonicalTupleV1(
  domain: Extract<WalV1DomainName, 'payloadAssociatedData' | 'logicalKey' | 'touchedKey'>,
  value: readonly CborProtocolValue[],
): Uint8Array {
  return hashWalV1Domain(domain, encodeCanonicalCbor(value));
}
