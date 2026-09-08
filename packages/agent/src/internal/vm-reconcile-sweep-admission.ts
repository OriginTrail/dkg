import type { VmReconcileDispatcher } from '../chain-reconciler.js';

/** Internal sweep capability; deliberately absent from the package-root API. */
export interface VmReconcileSweepAdmission<T = unknown> {
  readonly tryAdmit: (key: string) => Promise<T> | undefined;
  readonly waitForChange: (signal?: AbortSignal) => Promise<void>;
  readonly isClosed: () => boolean;
}

const admissions = new WeakMap<object, VmReconcileSweepAdmission>();

export function registerVmReconcileSweepAdmission<T>(
  owner: VmReconcileDispatcher<T>,
  admission: VmReconcileSweepAdmission<T>,
): void {
  admissions.set(owner, admission);
}

export function vmReconcileSweepAdmission<T>(
  owner: VmReconcileDispatcher<T>,
): VmReconcileSweepAdmission<T> {
  const admission = admissions.get(owner);
  if (!admission) throw new Error('VM dispatcher has no sweep admission capability');
  // Registration binds these callbacks to this exact generic dispatcher instance.
  return admission as VmReconcileSweepAdmission<T>;
}
