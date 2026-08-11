import type { KnowledgeAssetUpdateContext } from '@origintrail-official/dkg-chain';

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

export type VmRecoveryFootprintAuthority =
  | {
      readonly kind: 'host-policy';
      resolveAccessPolicy(contextGraphId: bigint): Promise<0 | 1 | null>;
    }
  | {
      readonly kind: 'chain-reader';
      isContextGraphActive(contextGraphId: bigint): Promise<boolean>;
      readAccessPolicy(contextGraphId: bigint): Promise<number>;
    };

/** Authority is explicit; unavailable sizing is represented deliberately by null. */
export interface VmRecoveryFootprintBridge {
  readonly authority: VmRecoveryFootprintAuthority;
  readonly sizing: VmRecoveryFootprintSizingReader | null;
}

export interface VmRecoveryFootprintBridgeOptions {
  maxContextReads: number;
  sizingReadTimeoutMs?: number;
  signal?: AbortSignal;
  isCurrent: () => boolean;
}

const VM_RECOVERY_BRIDGE_ABORTED = Symbol('vm-recovery-bridge-aborted');
const VM_RECOVERY_BRIDGE_TIMED_OUT = Symbol('vm-recovery-bridge-timed-out');
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

async function readVmRecoveryFootprintWithDeadline<T>(
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
  T & { readonly recoveryFootprint?: VmRecoveryChainFootprint };

function downgradeUnverifiedPublicFootprints<T extends VmRecoveryFootprintBridgeTarget>(
  targets: readonly T[],
): VmRecoveryFootprintEnrichedTarget<T>[] {
  return targets.map((target): VmRecoveryFootprintEnrichedTarget<T> =>
    target.recoveryFootprint?.kind === 'public-v10'
      ? { ...target, recoveryFootprint: { kind: 'unknown' } }
      : target);
}

async function resolveVmRecoveryPublicAuthority(
  onChainCgId: bigint,
  authority: VmRecoveryFootprintAuthority,
  signal: AbortSignal | undefined,
  isCurrent: () => boolean,
): Promise<boolean> {
  try {
    if (authority.kind === 'host-policy') {
      const policy = await raceVmRecoveryBridgeAbort(
        authority.resolveAccessPolicy(onChainCgId), signal,
      );
      return policy !== VM_RECOVERY_BRIDGE_ABORTED
        && policy === 0
        && !vmRecoveryBridgeSignalAborted(signal)
        && isCurrent();
    }
    const active = await raceVmRecoveryBridgeAbort(
      authority.isContextGraphActive(onChainCgId), signal,
    );
    if (active !== true || vmRecoveryBridgeSignalAborted(signal) || !isCurrent()) return false;
    const policy = await raceVmRecoveryBridgeAbort(authority.readAccessPolicy(onChainCgId), signal);
    return policy !== VM_RECOVERY_BRIDGE_ABORTED
      && policy === 0
      && !vmRecoveryBridgeSignalAborted(signal)
      && isCurrent();
  } catch {
    return false;
  }
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
  const original: VmRecoveryFootprintEnrichedTarget<T>[] = [...targets];
  const unverified = downgradeUnverifiedPublicFootprints(targets);
  if (targets.length === 0) return original;
  if (onChainCgId <= 0n || options.signal?.aborted || !options.isCurrent()) return unverified;

  const publicAuthority = await resolveVmRecoveryPublicAuthority(
    onChainCgId, bridge.authority, options.signal, options.isCurrent,
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

  const observed = await Promise.all(unknownEntries.map(async ({ target, index }) => {
    if (options.signal?.aborted || !options.isCurrent()) return { index };
    try {
      const observedContext = await readVmRecoveryFootprintWithDeadline(
        (readSignal) => sizing.readUpdateContext(BigInt(target.kaId), { signal: readSignal }),
        options.signal,
        sizingReadTimeoutMs,
      );
      if (
        observedContext === VM_RECOVERY_BRIDGE_ABORTED
        || observedContext === VM_RECOVERY_BRIDGE_TIMED_OUT
      ) return { index };
      if (
        options.signal?.aborted
        || !options.isCurrent()
        || observedContext.merkleRootsCount <= 0n
        || observedContext.byteSize <= 0n
        || !Number.isSafeInteger(observedContext.merkleLeafCount)
        || observedContext.merkleLeafCount <= 0
      ) return { index };
      return {
        index,
        footprint: {
          kind: 'public-v10',
          byteSize: observedContext.byteSize,
          merkleLeafCount: BigInt(observedContext.merkleLeafCount),
          assertionVersion: observedContext.merkleRootsCount.toString(),
          anchor: { kind: 'latest-bounded' },
        } satisfies VmRecoveryChainFootprint,
      };
    } catch {
      return { index };
    }
  }));

  if (options.signal?.aborted || !options.isCurrent()) return unverified;
  const enriched: VmRecoveryFootprintEnrichedTarget<T>[] = [...targets];
  for (const { index, footprint } of observed) {
    if (footprint) enriched[index] = { ...targets[index]!, recoveryFootprint: footprint };
  }
  return enriched;
}
