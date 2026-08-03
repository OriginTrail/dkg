/**
 * Process-wide per-chain admission for heavyweight pinned finalized reads.
 *
 * `CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CONCURRENT_PER_CHAIN_V1 = 1` has always
 * documented "one heavyweight pinned scan per chain", but it was enforced by a
 * gate constructed **inside** `createStrictFinalizedEndpointRunnerV1`, i.e. one
 * gate per transport instance. Callers that build their own transport therefore
 * never contended with each other — and RFC64 builds its snapshot scope inside
 * the precommit handler, so it constructs a fresh one **per invocation**
 * (`packages/agent/src/rfc64/finalized-vm-agent-precommit-v1.ts:94`). Two
 * concurrent precommits on one chain both admitted.
 *
 * W2 makes that visible rather than merely worse: the update-page scanner is a
 * second independent caller on the same chain, and the plan requires combined
 * RFC64 + W2 concurrency to never exceed one. So the permit state moves here,
 * to module scope, where "per chain" actually means per chain.
 *
 * **The key is the canonical chain id ALONE.** Adding the owner to the key
 * would produce one lane per owner, which is the precise bug this module
 * exists to remove; `owner` is carried for attribution only — it labels who is
 * holding the lane when another caller is refused, and it is what the W2
 * metrics' `owner` dimension reports.
 *
 * Admission is **non-queueing**, exactly as before: a saturated caller is
 * refused immediately and decides its own backoff. Queueing here would turn a
 * refusal that callers already handle into an unbounded wait inside a
 * transport that has no deadline of its own until after admission.
 */
import { parseCanonicalDecimalU256, type ChainIdV1 } from '@origintrail-official/dkg-core';

/**
 * Closed owner vocabulary. Exported as a value tuple so callers can iterate it
 * and a test can prove every owner shares the one lane; a bare type union is
 * invisible at runtime and cannot be checked.
 */
export const FINALIZED_CHAIN_READ_OWNERS = Object.freeze([
  'foreground',
  'rfc64',
  'w2-page',
  'w2-target',
] as const);
export type FinalizedChainReadOwnerV1 = (typeof FINALIZED_CHAIN_READ_OWNERS)[number];

/**
 * Derived from the frozen tuple. It was previously a `Set` captured at module
 * initialization while config validation read the (then-mutable) array — two
 * sources of truth that could disagree. The tuple is frozen now, so the snapshot
 * is safe, and this comment records why it must stay that way.
 */
const OWNER_SET: ReadonlySet<string> = new Set(FINALIZED_CHAIN_READ_OWNERS);

/** One heavyweight pinned finalized read per chain, across every owner. */
export const FINALIZED_CHAIN_READ_MAX_CONCURRENT_PER_CHAIN_V1 = 1;

export interface FinalizedChainReadAdmissionRequestV1 {
  readonly chainId: ChainIdV1 | string;
  readonly owner: FinalizedChainReadOwnerV1;
}

interface LaneStateV1 {
  active: number;
  /** The owner that took the lane, for attribution in the refusal. */
  holder: FinalizedChainReadOwnerV1;
}

/**
 * Module-scoped on purpose. A registry handed out per construction site is the
 * defect described in this file's header.
 */
const lanes = new Map<string, LaneStateV1>();

function canonicalChainKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Finalized chain-read admission requires a chain id');
  }
  // Canonicalize rather than trust the caller's spelling: '084532' and '84532'
  // are one chain, and accepting both would make the guarantee hold per
  // spelling instead of per chain.
  try {
    return parseCanonicalDecimalU256(value, 'finalized chain-read chain id').toString();
  } catch (cause) {
    throw new TypeError(
      `Finalized chain-read admission requires a canonical decimal chain id, got "${value}"`,
      { cause },
    );
  }
}

/**
 * Run `operation` holding this chain's sole finalized-read permit.
 *
 * `saturated` builds the refusal; it receives the active count and the owner
 * currently holding the lane so the error can say who to look at.
 */
export async function acquireFinalizedChainRead<T>(
  request: FinalizedChainReadAdmissionRequestV1,
  operation: () => Promise<T>,
  saturated: (active: number, holder: FinalizedChainReadOwnerV1) => Error,
): Promise<T> {
  if (!OWNER_SET.has(request.owner)) {
    throw new TypeError(
      `Finalized chain-read admission received an unknown owner "${request.owner}"`,
    );
  }
  const key = canonicalChainKey(request.chainId);

  const lane = lanes.get(key);
  if (lane !== undefined && lane.active >= FINALIZED_CHAIN_READ_MAX_CONCURRENT_PER_CHAIN_V1) {
    throw saturated(lane.active, lane.holder);
  }
  lanes.set(key, { active: (lane?.active ?? 0) + 1, holder: request.owner });
  try {
    return await operation();
  } finally {
    const current = lanes.get(key);
    const remaining = (current?.active ?? 1) - 1;
    // Delete rather than leave a zero row, so `lanes` does not grow one entry
    // per chain id ever seen and a stale holder label cannot outlive its holder.
    if (remaining <= 0) lanes.delete(key);
    else lanes.set(key, { active: remaining, holder: current?.holder ?? request.owner });
  }
}

/**
 * An admission policy the endpoint runner can execute without knowing what kind
 * of policy it is.
 *
 * The runner used to own endpoint lifecycle only. Giving it a `sharedOwner` mode
 * flag made it also understand a snapshot-specific owner vocabulary — a boundary
 * leak that would grow an enum in the generic lifecycle every time another
 * shared caller appeared. It now runs whatever policy its factory supplies.
 */
export interface FinalizedReadAdmissionV1 {
  run<T>(
    chainId: ChainIdV1,
    operation: () => Promise<T>,
    saturated: (active: number, holder?: string) => Error,
  ): Promise<T>;
}

/** The process-wide single-permit policy, bound to one owner label. */
export function createSharedFinalizedReadAdmissionV1(
  owner: FinalizedChainReadOwnerV1,
): FinalizedReadAdmissionV1 {
  return Object.freeze({
    run: <T>(
      chainId: ChainIdV1,
      operation: () => Promise<T>,
      saturated: (active: number, holder?: string) => Error,
    ) => acquireFinalizedChainRead({ chainId, owner }, operation, saturated),
  });
}

/** Active permit count for one chain. Diagnostics and tests only. */
export function finalizedChainReadRegistryDepth(chainId: ChainIdV1 | string): number {
  return lanes.get(canonicalChainKey(chainId))?.active ?? 0;
}

/**
 * Drop all lane state.
 *
 * Module-scoped state is shared by every test in a worker, so a test that
 * leaves a permit held would make the NEXT test's admission fail for a reason
 * it never caused. Tests call this first.
 */
export function resetFinalizedChainReadRegistryForTests(): void {
  lanes.clear();
}
