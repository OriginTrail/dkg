// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-service boundary for VM reconciliation.
 *
 * The pure ordinal/watermark engine and its low-level keyed scheduler live in
 * `chain-reconciler.ts`. This module owns the agent/API result model and the
 * route-consumed error taxonomy constructed by the DKGAgent service layer.
 */

export type VmReconcileTriggerSource = 'live' | 'periodic';
export type VmReconcileSource = VmReconcileTriggerSource | 'manual';
export type ContextGraphReconcileStatus = 'current' | 'progress' | 'pending' | 'watermark-ahead';

export interface ContextGraphReconcileResult {
  contextGraphId: string;
  onChainId: string;
  source: VmReconcileSource;
  status: ContextGraphReconcileStatus;
  attempted: boolean;
  headOrdinal: number;
  watermarkBefore: number;
  watermarkAfter: number;
  reconciledOrdinals: number;
  unresolvedOrdinals: number;
}

export class ContextGraphOnChainIdUnresolvedError extends Error {
  readonly code = 'ContextGraphOnChainIdUnresolved';

  constructor(contextGraphId: string) {
    super(`Context graph "${contextGraphId}" has no resolved on-chain id`);
    this.name = 'ContextGraphOnChainIdUnresolvedError';
  }
}

export class VmReconcileUnavailableError extends Error {
  readonly code = 'VmReconcileUnavailable';

  constructor() {
    super('Chain-driven VM reconciliation is unavailable on this node');
    this.name = 'VmReconcileUnavailableError';
  }
}

export class VmReconcileQueueFullError extends Error {
  readonly code = 'VmReconcileQueueFull';

  constructor(readonly maxPending: number) {
    super(`VM reconcile queue is full (${maxPending} pending context graphs)`);
    this.name = 'VmReconcileQueueFullError';
  }
}

export class VmReconcileQueueClosedError extends Error {
  readonly code = 'VmReconcileQueueClosed';

  constructor() {
    super('VM reconcile queue is closed for node shutdown');
    this.name = 'VmReconcileQueueClosedError';
  }
}

export class VmReconcileShutdownTimeoutError extends Error {
  readonly code = 'VmReconcileShutdownTimeout';

  constructor(readonly timeoutMs: number) {
    super(`Graph-scoped sync/reconciliation work did not retire within the ${timeoutMs}ms shutdown bound`);
    this.name = 'VmReconcileShutdownTimeoutError';
  }
}
