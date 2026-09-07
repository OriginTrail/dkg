import { normalizeEndpointOrigin } from '@origintrail-official/dkg-core';
import { CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1 } from './current-finalized-evm-read-profile.js';
import { snapshotDenseDataArray } from './strict-local-data.js';

const SLOTS = 2;
type AssertPolicyMatchesCeiling =
  [typeof CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1] extends [typeof SLOTS] ? true : never;
const _assertPolicyMatchesCeiling: AssertPolicyMatchesCeiling = true;
void _assertPolicyMatchesCeiling;

interface NormalizedEndpoint {
  readonly href: string;
  readonly origin: string;
}

/**
 * Snapshot a configured RPC pool into a frozen two-attempt session. Validate
 * every raw entry and deduplicate normalized URLs before selecting providers.
 * The first distinct origin is preferred; a same-origin second URL preserves
 * failover when the pool contains only one provider.
 */
export function snapshotStrictFinalizedEndpointSessionV1(input: unknown): readonly string[] {
  const normalized: NormalizedEndpoint[] = [];
  const seen = new Set<string>();
  try {
    // Raw duplicates are permitted without a count cap. Only the selected
    // session is bounded, preserving configurations with large duplicate pools.
    const endpoints = snapshotDenseDataArray(input, {
      label: 'Strict current-finalized RPC endpoints', minLength: 1,
    });
    for (const entry of endpoints) {
      const endpoint = normalizeEndpoint(entry);
      if (seen.has(endpoint.href)) continue;
      seen.add(endpoint.href);
      normalized.push(endpoint);
    }
  } catch (cause) {
    if (cause instanceof TypeError) throw cause;
    throw new TypeError('Strict current-finalized endpoints must be a dense data-only array', { cause });
  }
  // minLength and full validation guarantee at least one normalized entry.
  // The fixed two-slot result and compile-time assertion keep the attempt
  // ceiling owned by this boundary, without a second module's postcondition.
  const first = normalized[0]!;
  const second = normalized.find((endpoint) => endpoint.origin !== first.origin) ?? normalized[1];
  return Object.freeze(second === undefined ? [first.href] : [first.href, second.href]);
}

function normalizeEndpoint(input: unknown): NormalizedEndpoint {
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
  if (url.username !== '' || url.password !== '') {
    throw new TypeError(
      'Strict current-finalized RPC endpoint must not contain username or password credentials',
    );
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
