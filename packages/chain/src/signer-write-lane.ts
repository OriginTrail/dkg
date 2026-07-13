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

type SignerWriteLaneEntryState = 'queued' | 'running' | 'timed-out' | 'skipped' | 'settled';

interface SignerWriteLaneEntry {
  admissionBudgetMs: number;
  label: string;
  state: SignerWriteLaneEntryState;
}

const SKIPPED_SIGNER_WRITE = Symbol('skipped-signer-write');

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

/**
 * Per-wallet admission queue for nonce-critical EVM writes.
 *
 * Entries under one signer address execute in FIFO order. A caller whose
 * cumulative predecessor budget expires is rejected and its abandoned
 * callback is skipped when it reaches the front. The lane itself remains held
 * until every real predecessor settles, so an admission timeout can never
 * permit overlapping nonce windows.
 */
export class SignerWriteLane {
  private readonly serializer = new KeyedSerializer();

  /** Admission metadata only; KeyedSerializer remains the canonical queue. */
  private readonly entries = new Map<string, Set<SignerWriteLaneEntry>>();

  constructor(private readonly admissionBudgetMs: number) {
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
    const entries = this.entries.get(signerAddress) ?? new Set<SignerWriteLaneEntry>();
    if (!this.entries.has(signerAddress)) this.entries.set(signerAddress, entries);
    const queueDepth = entries.size + 1;
    const waitMs = [...entries]
      .filter((predecessor) => predecessor.state === 'queued' || predecessor.state === 'running')
      .reduce((total, predecessor) => total + predecessor.admissionBudgetMs, 0);
    const laneEntry: SignerWriteLaneEntry = {
      admissionBudgetMs: this.admissionBudgetMs,
      label,
      state: 'queued',
    };
    entries.add(laneEntry);

    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const timeout = waitMs > 0
      ? setTimeout(() => {
        if (laneEntry.state !== 'queued') return;
        // Stop charging this abandoned entry to callers admitted after its
        // deadline. Its serializer entry remains queued, preserving the FIFO
        // barrier until the real predecessor releases the lane.
        laneEntry.state = 'timed-out';
        rejectResult(new SignerWriteLaneAdmissionTimeoutError(
          signerAddress,
          waitMs,
          queueDepth,
          laneEntry.label,
        ));
      }, waitMs)
      : undefined;
    timeout?.unref?.();

    const execution = this.serializer.run<T | typeof SKIPPED_SIGNER_WRITE>(
      signerAddress,
      async () => {
        if (laneEntry.state === 'timed-out') {
          laneEntry.state = 'skipped';
          return SKIPPED_SIGNER_WRITE;
        }
        laneEntry.state = 'running';
        if (timeout) clearTimeout(timeout);
        try {
          return await fn();
        } finally {
          laneEntry.state = 'settled';
        }
      },
    );
    const cleanup = () => {
      entries.delete(laneEntry);
      if (entries.size === 0 && this.entries.get(signerAddress) === entries) {
        this.entries.delete(signerAddress);
      }
    };
    void execution.then(
      (value) => {
        cleanup();
        if (value !== SKIPPED_SIGNER_WRITE) resolveResult(value);
      },
      (error) => {
        cleanup();
        rejectResult(error);
      },
    );
    return result;
  }

  isActive(signerAddress: string): boolean {
    return this.serializer.isActive(signerAddress);
  }

  get activeSignerCount(): number {
    return this.serializer.activeKeyCount;
  }
}
