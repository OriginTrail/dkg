import { createHash } from 'node:crypto';
import { decode, encode } from 'cborg';
import { RuntimeCapabilityMetadata } from './effect-broker.js';

export function encodeCapabilityMetadata(metadata: RuntimeCapabilityMetadata): Uint8Array {
  if (
    !metadata.subject
    || !metadata.audience
    || !metadata.executionId
    || metadata.delegationDepth < 0
    || !Number.isInteger(metadata.delegationDepth)
    || metadata.budgetMicros < 0n
  ) {
    throw new Error('invalid runtime capability metadata');
  }
  const verbs = [...new Set(metadata.verbs)].sort();
  const resources = [...new Set(metadata.resources)].sort();
  return encode([
    1,
    metadata.subject,
    metadata.audience,
    metadata.executionId,
    verbs,
    resources,
    metadata.delegationDepth,
    metadata.oneShot,
    metadata.budgetMicros,
    metadata.parentCapabilityId ?? null,
  ]);
}

export function computeEffectRequestDigest(
  adapterId: string,
  adapterVersion: string,
  verb: string,
  resource: string,
  normalizedInput: unknown,
): Uint8Array {
  return digest(
    'DKG-SEMANTIC-RUNTIME-EFFECT-REQUEST-V1\0',
    adapterId,
    adapterVersion,
    verb,
    resource,
    encodeCanonical(normalizedInput),
  );
}

export function decodeCapabilityMetadata(bytes: Uint8Array): RuntimeCapabilityMetadata {
  const value = decode(bytes);
  if (!Array.isArray(value) || value.length !== 10 || value[0] !== 1) {
    throw new Error('invalid runtime capability metadata envelope');
  }
  const [,
    subject,
    audience,
    executionId,
    verbs,
    resources,
    delegationDepth,
    oneShot,
    budgetMicros,
    parentCapabilityId,
  ] = value;
  if (
    typeof subject !== 'string'
    || typeof audience !== 'string'
    || typeof executionId !== 'string'
    || !Array.isArray(verbs)
    || !verbs.every((item) => typeof item === 'string')
    || !Array.isArray(resources)
    || !resources.every((item) => typeof item === 'string')
    || typeof delegationDepth !== 'number'
    || !Number.isInteger(delegationDepth)
    || typeof oneShot !== 'boolean'
    || (typeof budgetMicros !== 'bigint' && typeof budgetMicros !== 'number')
    || (parentCapabilityId !== null && typeof parentCapabilityId !== 'string')
  ) {
    throw new Error('invalid runtime capability metadata fields');
  }
  return {
    subject,
    audience,
    executionId,
    verbs: verbs as string[],
    resources: resources as string[],
    delegationDepth,
    oneShot,
    budgetMicros: BigInt(budgetMicros),
    parentCapabilityId: parentCapabilityId ?? undefined,
  };
}

export function resourceContains(scope: string, requested: string): boolean {
  if (scope === requested) return true;
  return scope.endsWith('/*') && requested.startsWith(scope.slice(0, -1));
}

export function encodeCanonical(value: unknown): Uint8Array {
  assertCborSafe(value, 0, new Set());
  return encode(value);
}

export function assertCborSafe(value: unknown, depth: number, seen: Set<object>): void {
  if (depth > 32) throw new Error('adapter input exceeds maximum CBOR nesting');
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
    || (typeof value === 'number' && Number.isSafeInteger(value))
    || value instanceof Uint8Array
  ) return;
  if (typeof value !== 'object') throw new Error('adapter input contains an unsupported CBOR value');
  if (seen.has(value)) throw new Error('adapter input contains a cycle');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) assertCborSafe(child, depth + 1, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('adapter input must use plain objects');
    }
    for (const [key, child] of Object.entries(value)) {
      if (key.length > 256) throw new Error('adapter input map key is too long');
      assertCborSafe(child, depth + 1, seen);
    }
  }
  seen.delete(value);
}

export function digest(domain: string, ...parts: Array<string | Uint8Array>): Uint8Array {
  const hash = createHash('sha256');
  hash.update(domain);
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  }
  return Uint8Array.from(hash.digest());
}

export function digestHex(domain: string, ...parts: Array<string | Uint8Array>): string {
  return Buffer.from(digest(domain, ...parts)).toString('hex');
}

export function assertDigest(value: Uint8Array, name: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error(`${name} must be exactly 32 bytes`);
  }
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

export function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_:-]{1,128}$/.test(error.message)) return error.message;
  return 'ADAPTER_DISPATCH_FAILED';
}
