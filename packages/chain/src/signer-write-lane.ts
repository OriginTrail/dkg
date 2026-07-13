// SPDX-License-Identifier: Apache-2.0

import { KeyedSerializer } from './keyed-mutex.js';

/**
 * Queue admission is intentionally a coarse operation-wide bound rather than
 * a second model of every RPC read, retry and backoff nested below the adapter.
 * The concrete helpers still own and enforce their individual deadlines; this
 * value only decides how long a successor may wait for the nonce lane.
 *
 * Thirty minutes is conservative enough for the supported V10
 * approve/re-approve, populate/sign, WAL and receipt-recovery path while still
 * bounding abandoned queued work. Because every executable phase is covered
 * by the same operation envelope, adding a nested retry cannot silently make a
 * hand-maintained admission formula stale.
 */
export const SIGNER_WRITE_OPERATION_ADMISSION_BUDGET_MS = 30 * 60 * 1000;

/**
 * A queued signer write exceeded the cumulative advertised budgets of every
 * predecessor already occupying its wallet lane. Its callback is never run.
 */
export class SignerWriteLaneAdmissionTimeoutError extends Error {
  readonly code = 'SIGNER_WRITE_LANE_ADMISSION_TIMEOUT';

  constructor(
    readonly signerAddress: string,
    readonly waitMs: number,
    readonly queueDepth: number,
    readonly label: string,
  ) {
    super(
      `Timed out after ${waitMs}ms waiting for signer transaction lane ` +
      `${signerAddress} (queue depth ${queueDepth}, operation ${label})`,
    );
    this.name = 'SignerWriteLaneAdmissionTimeoutError';
  }
}

export interface SignerWriteLaneQueuedEvent {
  readonly signerAddress: string;
  readonly label: string;
  readonly queueDepth: number;
  readonly waitMs: number;
  readonly deadlineAt: number;
}

/**
 * Domain facade for nonce-critical EVM writes.
 *
 * KeyedSerializer is the sole queue and admission-state owner. This facade
 * supplies the signer-specific budget and diagnostics without maintaining a
 * second tail, entry set, timeout graph or active-state model.
 */
export class SignerWriteLane {
  private readonly serializer = new KeyedSerializer();

  constructor(
    private readonly admissionBudgetMs: number,
    private readonly onQueued?: (event: SignerWriteLaneQueuedEvent) => void,
  ) {
    if (!Number.isFinite(admissionBudgetMs) || admissionBudgetMs <= 0) {
      throw new Error('Signer write lane must define a positive admission budget');
    }
  }

  run<T>(
    signerAddress: string,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!label.trim()) throw new Error('Signer write lane operation must define a label');
    return this.serializer.runWithAdmission(
      signerAddress,
      {
        operationBudgetMs: this.admissionBudgetMs,
        timeoutError: (waitMs, queueDepth) => new SignerWriteLaneAdmissionTimeoutError(
          signerAddress,
          waitMs,
          queueDepth,
          label,
        ),
        onQueued: (waitMs, queueDepth) => this.onQueued?.({
          signerAddress,
          label,
          queueDepth,
          waitMs,
          deadlineAt: Date.now() + waitMs,
        }),
      },
      fn,
    );
  }

  isActive(signerAddress: string): boolean {
    return this.serializer.isActive(signerAddress);
  }

  get activeSignerCount(): number {
    return this.serializer.activeKeyCount;
  }
}
