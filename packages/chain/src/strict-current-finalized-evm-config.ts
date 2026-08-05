import { assertCanonicalChainId } from '@origintrail-official/dkg-core';

import { CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1 } from './current-finalized-evm-read-profile.js';
import { normalizeEndpointOrigin } from '@origintrail-official/dkg-core';

import { snapshotDenseDataArray } from './strict-local-data.js';
import {
  selectStrictFinalizedEndpointSessionV1,
  type StrictFinalizedEndpointV1,
} from './strict-finalized-endpoint-session.js';
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
const SNAPSHOT_CONFIG_OPTIONAL_KEYS = Object.freeze([...CONFIG_OPTIONAL_KEYS, 'owner'] as const);

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
  // DESCRIPTORS FIRST — before `owner`, before object rest, before any read.
  // An earlier revision destructured `{ owner, ...rest }` up front. That both
  // executed enumerable getters on the caller's object AND converted them into
  // plain data properties, so the descriptor check downstream saw a clean object
  // and ACCEPTED a config the base validator rejects untouched. Object rest is a
  // read; it cannot precede the check that decides whether reading is allowed.
  assertConfigDataProperties(input, SNAPSHOT_CONFIG_OPTIONAL_KEYS);

  // `@origintrail-official/dkg-chain` is PUBLISHED (npm 10.0.11, not private),
  // and this factory is part of its public surface. Requiring `owner` would
  // break every external `{ chainId, endpoints }` caller at compile time and at
  // runtime for no gain: `foreground` is a real, meaningful owner label — those
  // callers genuinely ARE foreground — not an "unknown" bucket. The attribution
  // this work exists to add is preserved, because the registry is process-wide
  // regardless of who holds it, and RFC64/W2 pass their owner explicitly rather
  // than relying on the default.
  // OMITTED means foreground. An explicitly PRESENT `owner` must be a known
  // value — including `null`/`undefined`, which are rejected rather than
  // silently treated as omission. `??` would have let the API contract for an
  // explicit null be decided by accident.
  const ownerPresent = Object.prototype.hasOwnProperty.call(input, 'owner');
  const owner = ownerPresent ? input.owner : 'foreground';
  if (!FINALIZED_CHAIN_READ_OWNERS.includes(owner as FinalizedChainReadOwnerV1)) {
    throw new TypeError(
      `Strict finalized snapshot RPC config received an unknown owner "${String(input.owner)}"`,
    );
  }

  // Rebuild explicitly from the now-proven data properties rather than spreading
  // the caller's object: the base validator must receive exactly the keys it
  // declares, and `blockReferenceProfile` is only present when the caller set it
  // (its allowlist rejects an explicit `undefined` key).
  const base: Record<string, unknown> = {
    chainId: input.chainId,
    endpoints: input.endpoints,
  };
  if (Object.prototype.hasOwnProperty.call(input, 'blockReferenceProfile')) {
    base.blockReferenceProfile = input.blockReferenceProfile;
  }

  return Object.freeze({
    ...snapshotStrictCurrentFinalizedEvmConfigV1(
      base as unknown as StrictCurrentFinalizedEvmRpcConfigV1,
    ),
    owner: owner as FinalizedChainReadOwnerV1,
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

/**
 * Prove an input is data-only BEFORE any field is read.
 *
 * The ordering is the contract, not an implementation detail: an accessor-backed
 * config must be rejected without its getter ever running. Reading a field first
 * — including implicitly, via object rest/spread — executes attacker-supplied
 * code and then hands the validator a plain object that trivially passes.
 */
function assertConfigDataProperties(
  input: Record<string, unknown>,
  optionalKeys: readonly string[] = CONFIG_OPTIONAL_KEYS,
): void {
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Strict current-finalized RPC config cannot contain symbol keys');
  }
  const allowed = new Set<string>([...CONFIG_REQUIRED_KEYS, ...optionalKeys]);
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
  const normalized: StrictFinalizedEndpointV1[] = [];
  const seen = new Set<string>();
  try {
    const endpoints = snapshotDenseDataArray(input, {
      label: 'Strict current-finalized RPC endpoints',
      minLength: 1,
      // Deliberately NOT bounded on the raw array. Base deduplicated by href
      // BEFORE applying its count check, so a config of 33 identical URLs — or
      // 40 entries collapsing to two — normalized to a valid pool and
      // constructed. A cap on the raw array turns those into a construction
      // failure and silently narrows the published contract from "at most two
      // distinct normalized endpoints" to "at most N raw entries". The dedup
      // below is O(n) via a Set and selection is a fixed two-slot scan, so an
      // oversized array costs a linear pass, not quadratic work; the attempt
      // count is bounded by selection and the postcondition regardless.
    });
    for (const entry of endpoints) {
      const endpoint = normalizeEndpoint(entry);
      if (seen.has(endpoint.href)) continue;
      seen.add(endpoint.href);
      normalized.push(endpoint);
    }
  } catch (cause) {
    if (cause instanceof TypeError) throw cause;
    // `cause` preserved: this catch flattens whatever `snapshotDenseDataArray`
    // reports into a single shape complaint, so the specific detail is otherwise
    // unrecoverable by a caller. The message is left alone because tests pin it.
    throw new TypeError(
      'Strict current-finalized endpoints must be a dense data-only array',
      { cause },
    );
  }
  // No emptiness check here: `snapshotDenseDataArray(..., { minLength: 1 })`
  // above already rejects an empty pool, and a non-empty pool either throws in
  // `normalizeEndpoint` or yields at least one entry. A second check would be
  // unreachable, and its old message advertised the `1..2` contract this change
  // deliberately replaced.

  // Session selection. Every endpoint above has already been validated and
  // deduplicated by URL, so an invalid entry anywhere in the pool still fails
  // closed — selection only decides which of the VALID ones this session uses.
  //
  // Before this, a pool larger than the attempt ceiling was fatal:
  // `resolveRpcUrls(chain.rpcUrl, chain.rpcUrls)` is three URLs on testnet,
  // mainnet-base and mainnet-gnosis, so RFC64's finalized-VM precommit could not
  // construct a snapshot scope on any shipped EVM network. Selecting at most two
  // distinct provider ORIGINS satisfies the ceiling by construction, which is
  // why the ceiling itself is left untouched.
  const selected = selectStrictFinalizedEndpointSessionV1(normalized);

  // Postcondition, not paranoia. The attempt ceiling used to be enforced HERE by
  // rejecting oversized pools; that rejection is what this change removes. But
  // the runner does not read `maxAttempts` — it attempts one endpoint per entry
  // of this list (`strict-current-finalized-evm-lifecycle.ts:104`) — so the
  // value attested as `CONTROL_EIP1271_MAX_ATTEMPTS_V1` and verified at
  // `current-finalized-evm-call.ts:182` is truthful ONLY while this list is
  // bounded. Leaving that to a `>=` inside another module would make an attested
  // claim depend on a remote implementation detail; a caller passing a bad bound
  // there would silently widen the attempt count instead of failing closed.
  //
  // This guards the GENERIC constant, not the attested one, and that is the
  // correct layering: `current-finalized-evm-read-profile.ts` states these limits
  // belong to the generic finalized-read boundary and that EIP-1271 is one
  // specialization which must not implicitly redefine unrelated finalized reads.
  // Importing the control constant here would invert that dependency. The guard
  // therefore protects the attested value via the alias at
  // `control-object-signature-verifier.ts:56`, and that alias is already pinned
  // by `strict-current-finalized-evm-rpc.unit.test.ts` ("keeps the EIP-1271
  // specialization pinned to the generic finalized-read profile"), so it cannot
  // be broken silently — verified by mutating the alias to its own literal,
  // which that test kills.
  if (selected.length > CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1) {
    throw new TypeError(
      'Strict current-finalized endpoint selection exceeded the attested attempt ceiling',
    );
  }
  return Object.freeze([...selected]);
}

/**
 * The canonical endpoint boundary: one pass that yields BOTH the dial URL and
 * the provider-origin identity selection needs.
 *
 * Deriving the origin here rather than in the selector means the URL is parsed
 * once, and the selector becomes a policy over an already-valid model instead of
 * a second validator defending against states this function has already made
 * impossible.
 *
 * The origin comes from core's `normalizeEndpointOrigin` — the same predicate
 * `canonicalPageProof` uses to decide `dual-origin-corroborated`, so the two
 * layers cannot drift. It is handed `url.origin`, never the full dial URL: core
 * bounds its input at the canonical scalar limit, and applying that to the whole
 * URL would impose a length limit RPC endpoints never had.
 */
function normalizeEndpoint(input: unknown): StrictFinalizedEndpointV1 {
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
  let origin: string;
  try {
    origin = normalizeEndpointOrigin(url.origin, 'strict current-finalized RPC endpoint origin');
  } catch (cause) {
    // Core throws `VmUpdateConvergenceError`, which extends `Error`, while every
    // rejection in this module is a `TypeError`. http(s) URLs always have a
    // tuple origin so this is not reachable from the scheme check above, but the
    // conversion keeps the module's error contract total rather than resting on
    // that argument.
    throw new TypeError(
      'Strict current-finalized RPC endpoint has no usable provider origin',
      { cause },
    );
  }
  return Object.freeze({ href: url.href, origin });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
