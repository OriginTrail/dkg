import { peerIdFromString } from '@libp2p/peer-id';
import { sha256 } from '@noble/hashes/sha2.js';

import { SYSTEM_RECORD_MAX_PEER_ID_BYTES } from './system-record-limits-v1.js';
import type { Digest32V1 } from './sync-wire-scalars.js';

const UTF8 = new TextEncoder();
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type SystemRecordPeerPublicKeyV1 = string & { readonly __peerPublicKeyV1: true };

export type SystemRecordObjectErrorCodeV1 =
  | 'system-record-schema'
  | 'system-record-scalar'
  | 'system-record-binding'
  | 'system-record-history'
  | 'system-record-signature'
  | 'system-record-order'
  | 'system-record-limit'
  | 'system-record-closure';

export class SystemRecordObjectErrorV1 extends Error {
  constructor(
    readonly code: SystemRecordObjectErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'SystemRecordObjectErrorV1';
  }
}

export function failSystemRecordObjectV1(
  code: SystemRecordObjectErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new SystemRecordObjectErrorV1(code, message, cause === undefined ? {} : { cause });
}

export function decodeUnpaddedBase64UrlV1(
  value: unknown,
  expectedBytes: number,
  label: string,
): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.includes('=') || !BASE64URL.test(value)) {
    failSystemRecordObjectV1('system-record-scalar', `${label} must be unpadded base64url`);
  }
  const bytes = Uint8Array.from(Buffer.from(value, 'base64url'));
  if (bytes.byteLength !== expectedBytes || Buffer.from(bytes).toString('base64url') !== value) {
    failSystemRecordObjectV1(
      'system-record-scalar',
      `${label} must canonically encode exactly ${expectedBytes} bytes`,
    );
  }
  return bytes;
}

export function assertCanonicalSystemRecordPeerIdV1(value: unknown): asserts value is string {
  if (typeof value !== 'string' || UTF8.encode(value).byteLength > SYSTEM_RECORD_MAX_PEER_ID_BYTES) {
    failSystemRecordObjectV1('system-record-scalar', 'peerId is outside its byte bound');
  }
  try {
    if (peerIdFromString(value).toString() !== value) throw new Error('noncanonical');
  } catch (cause) {
    failSystemRecordObjectV1('system-record-scalar', 'peerId is not canonical', cause);
  }
}

export function digestSystemRecordBytesV1(domain: string, bytes: Uint8Array): Digest32V1 {
  const domainBytes = UTF8.encode(domain);
  const input = new Uint8Array(domainBytes.byteLength + bytes.byteLength);
  input.set(domainBytes);
  input.set(bytes, domainBytes.byteLength);
  return (`0x${Buffer.from(sha256(input)).toString('hex')}`) as Digest32V1;
}
