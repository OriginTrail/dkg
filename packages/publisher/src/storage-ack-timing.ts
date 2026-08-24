import { DEFAULT_SEND_TIMEOUT_MS } from '@origintrail-official/dkg-core';
import {
  ACK_HANDLER_DEADLINE_SAFETY_MARGIN_MS,
  DEFAULT_ACK_HANDLER_DEADLINE_MS,
} from './storage-ack-handler.js';

export interface StorageAckTiming {
  handlerDeadlineMs: number;
  sendTimeoutMs: number;
  /** Maximum ACK collection rounds that this publisher may run at once. */
  maxConcurrentCollections: number;
}

export interface StorageAckTimingInput {
  handlerDeadlineMs?: number;
  sendTimeoutMs?: number;
  maxConcurrentCollections?: number;
}

export const STORAGE_ACK_SEND_TIMEOUT_DEFAULT_MS = DEFAULT_SEND_TIMEOUT_MS;
export const STORAGE_ACK_HANDLER_DEADLINE_DEFAULT_MS = DEFAULT_ACK_HANDLER_DEADLINE_MS;
export const STORAGE_ACK_TIMING_SAFETY_MARGIN_MS = ACK_HANDLER_DEADLINE_SAFETY_MARGIN_MS;
export const STORAGE_ACK_MAX_CONCURRENT_COLLECTIONS_DEFAULT = 1;

function requirePositiveSafeIntegerMs(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer number of milliseconds`);
  }
  return value as number;
}

function requireNonNegativeSafeIntegerMs(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer number of milliseconds`);
  }
  return value as number;
}

export function resolveStorageAckTiming(
  storageAck?: StorageAckTimingInput | null,
  label = 'storageAck',
): StorageAckTiming {
  if (storageAck != null && (typeof storageAck !== 'object' || Array.isArray(storageAck))) {
    throw new Error(
      `${label} must be an object with optional handlerDeadlineMs/sendTimeoutMs/` +
      'maxConcurrentCollections fields',
    );
  }
  const handlerOverride = requireNonNegativeSafeIntegerMs(
    storageAck?.handlerDeadlineMs,
    `${label}.handlerDeadlineMs`,
  );
  const sendOverride = requirePositiveSafeIntegerMs(
    storageAck?.sendTimeoutMs,
    `${label}.sendTimeoutMs`,
  );
  const maxConcurrentCollections = requirePositiveSafeIntegerMs(
    storageAck?.maxConcurrentCollections,
    `${label}.maxConcurrentCollections`,
  ) ?? STORAGE_ACK_MAX_CONCURRENT_COLLECTIONS_DEFAULT;
  const handlerDeadlineMs = handlerOverride ?? STORAGE_ACK_HANDLER_DEADLINE_DEFAULT_MS;
  const sendTimeoutMs = sendOverride ?? Math.max(
    STORAGE_ACK_SEND_TIMEOUT_DEFAULT_MS,
    handlerDeadlineMs + STORAGE_ACK_TIMING_SAFETY_MARGIN_MS,
  );
  if (
    handlerDeadlineMs > 0 &&
    sendTimeoutMs - handlerDeadlineMs < STORAGE_ACK_TIMING_SAFETY_MARGIN_MS
  ) {
    throw new Error(
      `${label}.sendTimeoutMs must be at least ${STORAGE_ACK_TIMING_SAFETY_MARGIN_MS}ms ` +
      `greater than ${label}.handlerDeadlineMs ` +
      `(got handlerDeadlineMs=${handlerDeadlineMs}, sendTimeoutMs=${sendTimeoutMs})`,
    );
  }
  return { handlerDeadlineMs, sendTimeoutMs, maxConcurrentCollections };
}
