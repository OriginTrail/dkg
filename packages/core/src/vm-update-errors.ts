/**
 * W2 update-convergence error plumbing plus the shared scalar-bound primitive,
 * extracted from `vm-update-convergence.ts` (PR #2436 review r16) so the
 * exact-event-position model and the convergence module can share them without
 * an import cycle. Public names stay re-exported from
 * `vm-update-convergence.ts`, so the core index surface is unchanged;
 * `fail`/`adapt`/`boundedString`/`MAX_SCALAR_BYTES` are package-internal.
 */

const UTF8 = new TextEncoder();

export const VM_UPDATE_ERROR_CODES = Object.freeze([
  'scope-drift',
  'noncanonical-scalar',
  'foreign-chain',
  'noncanonical-ual',
  'ka-number-overflow',
  'ual-round-trip-failed',
  'ambiguous-w2-identity',
  'page-malformed',
  'page-oversized',
  'assurance-insufficient',
  'origin-not-distinct',
  'commitment-mismatch',
  'cursor-regression',
  'resume-identity-conflict',
  'coverage-invalid',
] as const);
export type VmUpdateErrorCodeV1 = (typeof VM_UPDATE_ERROR_CODES)[number];

/**
 * A bounded, redactable failure.
 *
 * `detail` is capped and carries only values this module itself canonicalized —
 * never raw RPC payloads, endpoint URLs, or peer identifiers. W2's structured
 * logs emit `code` and `detail`; anything unbounded belongs in neither.
 */
export class VmUpdateConvergenceError extends Error {
  readonly code: VmUpdateErrorCodeV1;
  readonly detail: string;

  constructor(code: VmUpdateErrorCodeV1, detail: string, options?: { cause?: unknown }) {
    const bounded = detail.length > 200 ? `${detail.slice(0, 197)}...` : detail;
    super(`vm-update: ${code}: ${bounded}`, options);
    this.name = 'VmUpdateConvergenceError';
    this.code = code;
    this.detail = bounded;
  }
}

export function fail(code: VmUpdateErrorCodeV1, detail: string, cause?: unknown): never {
  throw new VmUpdateConvergenceError(code, detail, cause === undefined ? undefined : { cause });
}

/** Run a shipped canonical-scalar assertion, re-raised as a W2 error code. */
export function adapt<T>(label: string, assertion: () => T, code: VmUpdateErrorCodeV1 = 'noncanonical-scalar'): T {
  try {
    return assertion();
  } catch (cause) {
    fail(code, `${label} is not canonical: ${(cause as Error)?.message ?? String(cause)}`, cause);
  }
}

/**
 * Bound on an IDENTITY scalar — chain id, deployment id, UAL, origin.
 *
 * Deliberately NOT applied to raw event data. `log.data` for a legal
 * `KnowledgeAssetMerkleRootsUpdated` is `64 + n * 96` bytes: 21 MerkleRoot
 * entries is 2,080 bytes, i.e. 4,162 hex characters, which this cap would
 * reject. That event is a BLOCKING mutation, so rejecting it would stop W2
 * before it can persist the unsupported-mutation latch that is supposed to fail
 * closed — a legal on-chain event turned into a wedge. Raw log bytes are bounded
 * by {@link MAX_ENCODED_UPDATE_LOG_BYTES_PER_PAGE} instead, per page, as the
 * plan specifies.
 */
export const MAX_SCALAR_BYTES = 4_096;

export function boundedString(value: unknown, label: string): string {
  if (typeof value !== 'string') fail('noncanonical-scalar', `${label} must be a string`);
  if (value.length > MAX_SCALAR_BYTES || UTF8.encode(value).byteLength > MAX_SCALAR_BYTES) {
    fail('noncanonical-scalar', `${label} exceeds ${MAX_SCALAR_BYTES} bytes`);
  }
  return value;
}
