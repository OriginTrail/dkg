// SPDX-License-Identifier: Apache-2.0

import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import {
  isStoreOperationTimeoutError,
  isStoreReadTransportFailure,
  isStoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';
import type { ContextGraphJoinPolicyStore } from './dkg-agent-types.js';

export interface ContextGraphJoinAdmissionOptions {
  readonly keyReadTiming?: JoinAdmissionKeyReadTiming;
  readonly log?: Pick<Logger, 'warn'>;
}

/** The log of join admissions built without one. */
export const JOIN_ADMISSION_LOG: Pick<Logger, 'warn'> = new Logger('ContextGraphJoinAdmission');

/** Waits before each repeat of an automatic admission's key read that the store did not serve. */
export const JOIN_ADMISSION_KEY_READ_RETRY_DELAYS_MS: readonly number[] = Object.freeze([200, 600, 1_200]);

/**
 * No repeat starts later than this after the first read began. The repeats run
 * under the graph's admission lock, so the bound is short; a read that ran
 * into the store's own deadline is not repeated at all.
 */
export const JOIN_ADMISSION_KEY_READ_RETRY_BUDGET_MS = 2_000;

/** The clock and sleep of the key read repeat, replaceable in tests. */
export interface JoinAdmissionKeyReadTiming {
  now(): number;
  sleep(delayMs: number): Promise<void>;
}

const REAL_TIMING: JoinAdmissionKeyReadTiming = Object.freeze({
  now: () => performance.now(),
  sleep: (delayMs: number) => new Promise<void>((resolve) => { setTimeout(resolve, delayMs); }),
});

const MAX_CAUSE_DEPTH = 8;

/**
 * Whether a failed key read says nothing about the key: the store refused the
 * read while busy, could not be reached, or did not answer in time. Only a key
 * the read resolved (missing, unverifiable, revoked or over the candidate
 * limit) is a verdict.
 */
export function isStoreUnavailableForKeyRead(error: unknown): boolean {
  try {
    let current: unknown = error;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth += 1) {
      if (isStoreSchedulerBusyError(current) || isStoreOperationTimeoutError(current)
        || isStoreReadTransportFailure(current)) return true;
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // An unreadable error is no proof that the store was unavailable.
  }
  return false;
}

export type JoinAdmissionKeyCheck =
  | { readonly kind: 'active' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'store-unavailable'; readonly error: unknown };

/**
 * An automatic admission deferred because the store could not read the
 * requester's key. Its name is the one the join request handler rethrows, so
 * the requester's messenger keeps the request in its outbox and sends it again.
 */
export class JoinAdmissionDeferredError extends Error {
  constructor(contextGraphId: string, agentAddress: string, cause: unknown) {
    super(
      `Automatic join admission for "${contextGraphId}" deferred: the store could not read the encryption key of `
        + `${agentAddress} (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = 'RetryableJoinAdmissionError';
  }
}

/**
 * Give back a reservation that no membership mutation used, so the hourly
 * caps count admissions, not attempts. A store that cannot release it lets it
 * leave the window by age, as before.
 */
export async function releaseUnusedApprovalReservation(
  policyStore: ContextGraphJoinPolicyStore,
  input: { contextGraphId: string; requestDigest: string; policyEpoch: number; reason: string },
  log: Pick<Logger, 'warn'>,
): Promise<void> {
  try {
    await policyStore.releaseAutomaticApproval?.({ ...input, timestamp: Date.now() });
  } catch (error) {
    log.warn(createOperationContext('system'),
      `Automatic join admission for "${input.contextGraphId}" could not release its approval reservation: `
        + `${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check a requester's encryption key, repeating a read the store did not
 * serve while the bound allows. The check only reads, so a repeat is safe.
 */
export async function checkJoinAdmissionEncryptionKey(
  read: () => Promise<void>,
  timing: JoinAdmissionKeyReadTiming = REAL_TIMING,
): Promise<JoinAdmissionKeyCheck> {
  const startedAt = timing.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await read();
      return { kind: 'active' };
    } catch (error) {
      if (!isStoreUnavailableForKeyRead(error)) return { kind: 'invalid' };
      const delayMs = JOIN_ADMISSION_KEY_READ_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || timing.now() - startedAt + delayMs > JOIN_ADMISSION_KEY_READ_RETRY_BUDGET_MS) {
        return { kind: 'store-unavailable', error };
      }
      await timing.sleep(delayMs);
    }
  }
}
