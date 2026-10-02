import type { KnowledgeAssetUpdateContext } from '@origintrail-official/dkg-chain';

import { mapWithConcurrency } from './map-with-concurrency.js';
import type { VmRecoveryChainFootprint } from './vm-recovery-types.js';

export interface VmRecoveryFootprintBridgeTarget {
  readonly kaId: string;
  readonly recoveryFootprint?: VmRecoveryChainFootprint;
}

/** Canonical chain fields consumed by the classic VM recovery sizing bridge. */
export type VmRecoveryUpdateContext = Pick<
  KnowledgeAssetUpdateContext,
  'merkleRootsCount' | 'byteSize' | 'merkleLeafCount'
>;

export interface VmRecoveryFootprintSizingReader {
  readUpdateContext(
    kaId: bigint,
    options?: { signal?: AbortSignal },
  ): Promise<VmRecoveryUpdateContext>;
}

/**
 * Advisory sizing hints prepared before this pass began. A hint is single-use
 * planning evidence of exactly the same kind a live read produces
 * (`latest-bounded`); it is never authority to materialize anything.
 */
export interface VmRecoveryPreparedHints {
  /**
   * The prepared hint for `kaId`, or `undefined` when none is usable (absent,
   * stale, already taken, failed or not ready within `maxWaitMs`). The caller
   * then falls back to its own live read, so a miss is never evidence of
   * absence or permission to skip a candidate.
   */
  take(
    kaId: string,
    options: { readonly maxWaitMs: number; readonly signal?: AbortSignal },
  ): Promise<VmRecoveryChainFootprint | undefined>;
}

/** Public authority is resolved by the host; this module owns sizing only. */
export interface VmRecoveryFootprintBridge {
  readonly resolvePublicAccess: (
    contextGraphId: bigint,
    options?: { signal?: AbortSignal },
  ) => Promise<boolean>;
  readonly sizing: VmRecoveryFootprintSizingReader | null;
  /** Optional prepared hints consumed before any live read; absent keeps today's behavior. */
  readonly prepared?: VmRecoveryPreparedHints | null;
}

export interface VmRecoveryFootprintBridgeOptions {
  maxContextReads: number;
  sizingReadTimeoutMs?: number;
  signal?: AbortSignal;
  isCurrent: () => boolean;
  /** Observation only: receives the outcome counts of one enrichment call. */
  observe?: (observation: VmRecoveryFootprintObservation) => void;
  /**
   * How many live sizing reads may be in flight at once. Reads start in
   * candidate order and each read's deadline starts when that read starts, so
   * a later candidate never spends its budget queueing behind earlier ones in
   * the local RPC governor. Omitted keeps every read concurrent from the start.
   */
  readConcurrency?: number;
}

/** What one enrichment call did; never consulted by any recovery decision. */
export interface VmRecoveryFootprintObservation {
  /** Entries whose footprint was unknown and therefore needed a sizing read. */
  readonly requested: number;
  /** Reads that produced a valid public footprint. */
  readonly resolved: number;
  /** Candidates served by a prepared hint instead of a live read. */
  readonly prepared: number;
  /** Reads that outlived the sizing deadline (including governor queue wait). */
  readonly timedOut: number;
  /** Reads dropped because the operation was aborted or no longer current. */
  readonly aborted: number;
  /** Reads that returned a malformed, zero or unsafe tuple. */
  readonly invalid: number;
  /** Reads that rejected. */
  readonly failed: number;
  readonly elapsedMs: number;
}

export const VM_RECOVERY_BRIDGE_ABORTED = Symbol('vm-recovery-bridge-aborted');
export const VM_RECOVERY_BRIDGE_TIMED_OUT = Symbol('vm-recovery-bridge-timed-out');
export const VM_RECOVERY_FOOTPRINT_READ_TIMEOUT_MS = 2_500;

function vmRecoveryBridgeSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function raceVmRecoveryBridgeAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof VM_RECOVERY_BRIDGE_ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return VM_RECOVERY_BRIDGE_ABORTED;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<typeof VM_RECOVERY_BRIDGE_ABORTED>((resolve) => {
    abortListener = () => resolve(VM_RECOVERY_BRIDGE_ABORTED);
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

export async function readVmRecoveryFootprintWithDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T | typeof VM_RECOVERY_BRIDGE_ABORTED | typeof VM_RECOVERY_BRIDGE_TIMED_OUT> {
  if (callerSignal?.aborted) return VM_RECOVERY_BRIDGE_ABORTED;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortFromCaller: (() => void) | undefined;
  let callerDidAbort = false;
  let deadlineExpired = false;
  const callerAborted = new Promise<typeof VM_RECOVERY_BRIDGE_ABORTED>((resolve) => {
    if (!callerSignal) return;
    abortFromCaller = () => {
      callerDidAbort = true;
      resolve(VM_RECOVERY_BRIDGE_ABORTED);
      controller.abort(callerSignal.reason);
    };
    callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  });
  const timedOut = new Promise<typeof VM_RECOVERY_BRIDGE_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      deadlineExpired = true;
      resolve(VM_RECOVERY_BRIDGE_TIMED_OUT);
      controller.abort(new Error(`VM recovery footprint read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  let work: Promise<T>;
  try {
    work = Promise.resolve(start(controller.signal));
  } catch (error) {
    work = Promise.reject(error);
  }
  try {
    const result = await Promise.race([work, callerAborted, timedOut]);
    if (callerDidAbort) return VM_RECOVERY_BRIDGE_ABORTED;
    if (deadlineExpired) return VM_RECOVERY_BRIDGE_TIMED_OUT;
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (callerSignal && abortFromCaller) callerSignal.removeEventListener('abort', abortFromCaller);
  }
}

export type VmRecoveryFootprintEnrichedTarget<T extends VmRecoveryFootprintBridgeTarget> =
  Omit<T, 'recoveryFootprint'> & { readonly recoveryFootprint: VmRecoveryChainFootprint };

function normalizeVmRecoveryFootprint<T extends VmRecoveryFootprintBridgeTarget>(
  target: T,
): VmRecoveryFootprintEnrichedTarget<T> {
  if (target.recoveryFootprint) {
    return target as VmRecoveryFootprintEnrichedTarget<T>;
  }
  return {
    ...target,
    recoveryFootprint: { kind: 'unknown' },
  };
}

function downgradeUnverifiedPublicFootprints<T extends VmRecoveryFootprintBridgeTarget>(
  targets: readonly T[],
): VmRecoveryFootprintEnrichedTarget<T>[] {
  return targets.map((target): VmRecoveryFootprintEnrichedTarget<T> =>
    target.recoveryFootprint?.kind === 'public-v10'
      ? { ...target, recoveryFootprint: { kind: 'unknown' } }
      : normalizeVmRecoveryFootprint(target));
}

async function resolveVmRecoveryPublicAuthority(
  onChainCgId: bigint,
  resolvePublicAccess: VmRecoveryFootprintBridge['resolvePublicAccess'],
  signal: AbortSignal | undefined,
  isCurrent: () => boolean,
): Promise<boolean> {
  try {
    const allowed = await raceVmRecoveryBridgeAbort(
      resolvePublicAccess(onChainCgId, { signal }),
      signal,
    );
    return allowed !== VM_RECOVERY_BRIDGE_ABORTED
      && allowed === true
      && !vmRecoveryBridgeSignalAborted(signal)
      && isCurrent();
  } catch {
    return false;
  }
}

/**
 * The one rule that turns an observed update context into a planning hint.
 * Zero, negative or unsafe values are not hints: they stay unknown/singleton.
 */
export function vmRecoveryFootprintFromUpdateContext(
  context: VmRecoveryUpdateContext,
): VmRecoveryChainFootprint | undefined {
  if (
    context.merkleRootsCount <= 0n
    || context.byteSize <= 0n
    || !Number.isSafeInteger(context.merkleLeafCount)
    || context.merkleLeafCount <= 0
  ) return undefined;
  return {
    kind: 'public-v10',
    byteSize: context.byteSize,
    merkleLeafCount: BigInt(context.merkleLeafCount),
    assertionVersion: context.merkleRootsCount.toString(),
    anchor: { kind: 'latest-bounded' },
  };
}

function isUsablePreparedFootprint(
  footprint: VmRecoveryChainFootprint | undefined,
): footprint is Extract<VmRecoveryChainFootprint, { kind: 'public-v10' }> {
  return footprint?.kind === 'public-v10'
    && typeof footprint.byteSize === 'bigint'
    && footprint.byteSize > 0n
    && typeof footprint.merkleLeafCount === 'bigint'
    && footprint.merkleLeafCount > 0n
    && footprint.anchor.kind === 'latest-bounded';
}

/**
 * Enrich a bounded prefix with public-chain sizing hints. Latest-state reads
 * influence soft packing only; unavailable, stale, private, aborted, or
 * malformed evidence remains the conservative unknown/singleton footprint.
 */
export async function enrichVmRecoveryFootprints<T extends VmRecoveryFootprintBridgeTarget>(
  targets: readonly T[],
  onChainCgId: bigint,
  bridge: VmRecoveryFootprintBridge,
  options: Readonly<VmRecoveryFootprintBridgeOptions>,
): Promise<VmRecoveryFootprintEnrichedTarget<T>[]> {
  const original = targets.map(normalizeVmRecoveryFootprint);
  const unverified = downgradeUnverifiedPublicFootprints(targets);
  if (targets.length === 0) return original;
  if (onChainCgId <= 0n || options.signal?.aborted || !options.isCurrent()) return unverified;

  const publicAuthority = await resolveVmRecoveryPublicAuthority(
    onChainCgId, bridge.resolvePublicAccess, options.signal, options.isCurrent,
  );
  if (!publicAuthority || options.signal?.aborted || !options.isCurrent()) return unverified;

  const unknownEntries = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => !target.recoveryFootprint
      || target.recoveryFootprint.kind === 'unknown')
    .slice(0, options.maxContextReads);
  if (unknownEntries.length === 0) return original;
  const sizingReadTimeoutMs = options.sizingReadTimeoutMs ?? VM_RECOVERY_FOOTPRINT_READ_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(options.maxContextReads)
    || options.maxContextReads <= 0
    || !Number.isSafeInteger(sizingReadTimeoutMs)
    || sizingReadTimeoutMs <= 0
    || bridge.sizing === null
  ) return original;
  const sizing = bridge.sizing;

  const counts = { resolved: 0, prepared: 0, timedOut: 0, aborted: 0, invalid: 0, failed: 0 };
  const startedAt = performance.now();
  const configuredConcurrency = options.readConcurrency;
  const readConcurrency = configuredConcurrency !== undefined
    && Number.isSafeInteger(configuredConcurrency)
    && configuredConcurrency > 0
    ? configuredConcurrency
    : unknownEntries.length;
  const sizeEntry = async (
    { target, index }: { target: T; index: number },
  ): Promise<{ index: number; footprint?: VmRecoveryChainFootprint }> => {
    if (options.signal?.aborted || !options.isCurrent()) {
      counts.aborted += 1;
      return { index };
    }
    try {
      if (bridge.prepared) {
        // A prepared hint is the same advisory evidence a live read yields. Any
        // problem with it (absent, stale, failed, late, malformed) is a plain
        // miss: the live read below runs exactly as it would without hints.
        const hinted = await bridge.prepared
          .take(target.kaId, { maxWaitMs: sizingReadTimeoutMs, signal: options.signal })
          .catch(() => undefined);
        if (options.signal?.aborted || !options.isCurrent()) {
          counts.aborted += 1;
          return { index };
        }
        if (isUsablePreparedFootprint(hinted)) {
          counts.prepared += 1;
          return { index, footprint: hinted };
        }
      }
      const observedContext = await readVmRecoveryFootprintWithDeadline(
        (readSignal) => sizing.readUpdateContext(BigInt(target.kaId), { signal: readSignal }),
        options.signal,
        sizingReadTimeoutMs,
      );
      if (observedContext === VM_RECOVERY_BRIDGE_ABORTED) {
        counts.aborted += 1;
        return { index };
      }
      if (observedContext === VM_RECOVERY_BRIDGE_TIMED_OUT) {
        counts.timedOut += 1;
        return { index };
      }
      if (options.signal?.aborted || !options.isCurrent()) {
        counts.aborted += 1;
        return { index };
      }
      const footprint = vmRecoveryFootprintFromUpdateContext(observedContext);
      if (!footprint) {
        counts.invalid += 1;
        return { index };
      }
      counts.resolved += 1;
      return { index, footprint };
    } catch {
      counts.failed += 1;
      return { index };
    }
  };
  const observed = await mapWithConcurrency(unknownEntries, readConcurrency, sizeEntry);
  if (options.observe) {
    try {
      options.observe({
        requested: unknownEntries.length,
        ...counts,
        elapsedMs: performance.now() - startedAt,
      });
    } catch { /* observation only */ }
  }

  if (options.signal?.aborted || !options.isCurrent()) return unverified;
  const enriched: VmRecoveryFootprintEnrichedTarget<T>[] = [...original];
  for (const { index, footprint } of observed) {
    if (footprint) enriched[index] = { ...targets[index]!, recoveryFootprint: footprint };
  }
  return enriched;
}
