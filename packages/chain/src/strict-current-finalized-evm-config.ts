import { assertCanonicalChainId } from '@origintrail-official/dkg-core';

import { CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1 } from './current-finalized-evm-read-profile.js';
import { snapshotDenseDataArray } from './strict-local-data.js';
import {
  FINALIZED_CHAIN_READ_OWNERS,
  type FinalizedChainReadOwnerV1,
} from './finalized-chain-read-admission.js';
import {
  CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1,
  type StrictCurrentFinalizedEvmRpcConfigV1,
  type StrictFinalizedSnapshotConfigSnapshotV1,
  type StrictFinalizedSnapshotRpcConfigV1,
  type StrictRpcConfigSnapshotV1,
} from './strict-current-finalized-evm-types.js';

const CONFIG_REQUIRED_KEYS = Object.freeze(['chainId', 'endpoints'] as const);
const CONFIG_OPTIONAL_KEYS = Object.freeze(['blockReferenceProfile'] as const);

/**
 * Snapshot-path config: identical validation plus a REQUIRED owner.
 *
 * `owner` is peeled off before delegating rather than added to the shared
 * allowlist, because the one-shot read path has no owner concept and silently
 * accepting a field it ignores is worse than rejecting it.
 */
export function snapshotStrictFinalizedSnapshotConfigV1(
  input: StrictFinalizedSnapshotRpcConfigV1,
): StrictFinalizedSnapshotConfigSnapshotV1 {
  if (!isPlainRecord(input)) {
    throw new TypeError('Strict finalized snapshot RPC config must be a plain data record');
  }
  const { owner, ...rest } = input;
  // `@origintrail-official/dkg-chain` is PUBLISHED (npm 10.0.11, not private),
  // and this factory is part of its public surface. Requiring `owner` would
  // break every external `{ chainId, endpoints }` caller at compile time and at
  // runtime for no gain: `foreground` is a real, meaningful owner label — those
  // callers genuinely ARE foreground — not an "unknown" bucket. The attribution
  // this work exists to add is preserved, because the registry is process-wide
  // regardless of who holds it, and RFC64/W2 pass their owner explicitly rather
  // than relying on the default.
  const resolved = owner ?? 'foreground';
  if (!FINALIZED_CHAIN_READ_OWNERS.includes(resolved as FinalizedChainReadOwnerV1)) {
    throw new TypeError(
      `Strict finalized snapshot RPC config received an unknown owner "${String(owner)}"`,
    );
  }
  return Object.freeze({
    ...snapshotStrictCurrentFinalizedEvmConfigV1(rest as StrictCurrentFinalizedEvmRpcConfigV1),
    owner: resolved as FinalizedChainReadOwnerV1,
  });
}

export function snapshotStrictCurrentFinalizedEvmConfigV1(
  input: StrictCurrentFinalizedEvmRpcConfigV1,
): StrictRpcConfigSnapshotV1 {
  if (!isPlainRecord(input)) {
    throw new TypeError('Strict current-finalized RPC config must be a plain data record');
  }
  assertConfigDataProperties(input);
  try {
    assertCanonicalChainId(input.chainId, 'strict current-finalized chainId');
  } catch {
    throw new TypeError('Strict current-finalized chainId must be canonical decimal u256');
  }

  const endpoints = snapshotNormalizedEndpoints(input.endpoints);
  const blockReferenceProfile = input.blockReferenceProfile ?? 'eip1898';
  if (!CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1.includes(blockReferenceProfile)) {
    throw new TypeError('Unsupported strict current-finalized block reference profile');
  }
  return Object.freeze({
    chainId: input.chainId,
    endpoints,
    blockReferenceProfile,
  });
}

function assertConfigDataProperties(input: Record<string, unknown>): void {
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Strict current-finalized RPC config cannot contain symbol keys');
  }
  const allowed = new Set<string>([...CONFIG_REQUIRED_KEYS, ...CONFIG_OPTIONAL_KEYS]);
  if (
    !CONFIG_REQUIRED_KEYS.every((key) => keys.includes(key))
    || (keys as string[]).some((key) => !allowed.has(key))
  ) {
    throw new TypeError('Strict current-finalized RPC config has unknown or missing fields');
  }
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError('Strict current-finalized RPC config fields must be enumerable data properties');
    }
  }
}

function snapshotNormalizedEndpoints(input: unknown): readonly string[] {
  const normalized: string[] = [];
  try {
    const endpoints = snapshotDenseDataArray(input, {
      label: 'Strict current-finalized RPC endpoints',
      minLength: 1,
    });
    for (const entry of endpoints) {
      const endpoint = normalizeEndpoint(entry);
      if (!normalized.includes(endpoint)) normalized.push(endpoint);
    }
  } catch (cause) {
    if (cause instanceof TypeError) throw cause;
    throw new TypeError('Strict current-finalized endpoints must be a dense data-only array');
  }
  if (normalized.length === 0 || normalized.length > CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1) {
    throw new TypeError(
      `Strict current-finalized RPC requires 1..${CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1} distinct endpoints`,
    );
  }
  return Object.freeze(normalized);
}

function normalizeEndpoint(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new TypeError('Strict current-finalized RPC endpoint must be a nonempty URL string');
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new TypeError('Strict current-finalized RPC endpoint must be an absolute URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hash !== '') {
    throw new TypeError('Strict current-finalized RPC endpoint must use HTTP(S) without a fragment');
  }
  return url.href;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
