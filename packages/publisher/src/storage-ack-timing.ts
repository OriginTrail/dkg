import { DEFAULT_SEND_TIMEOUT_MS } from '@origintrail-official/dkg-core';
import {
  ACK_HANDLER_DEADLINE_SAFETY_MARGIN_MS,
  DEFAULT_ACK_HANDLER_DEADLINE_MS,
} from './storage-ack-handler.js';

export interface StorageAckTiming {
  handlerDeadlineMs: number;
  sendTimeoutMs: number;
}

export interface StorageAckTimingInput {
  handlerDeadlineMs?: number;
  sendTimeoutMs?: number;
}

export const STORAGE_ACK_SEND_TIMEOUT_DEFAULT_MS = DEFAULT_SEND_TIMEOUT_MS;
export const STORAGE_ACK_HANDLER_DEADLINE_DEFAULT_MS = DEFAULT_ACK_HANDLER_DEADLINE_MS;
export const STORAGE_ACK_TIMING_SAFETY_MARGIN_MS = ACK_HANDLER_DEADLINE_SAFETY_MARGIN_MS;

function requirePositiveSafeIntegerMs(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer number of milliseconds`);
  }
  return value as number;
}

export function resolveStorageAckTiming(
  storageAck?: StorageAckTimingInput | null,
  label = 'storageAck',
): StorageAckTiming {
  if (storageAck != null && (typeof storageAck !== 'object' || Array.isArray(storageAck))) {
    throw new Error(`${label} must be an object with optional handlerDeadlineMs/sendTimeoutMs fields`);
  }
  const handlerOverride = requirePositiveSafeIntegerMs(
    storageAck?.handlerDeadlineMs,
    `${label}.handlerDeadlineMs`,
  );
  const sendOverride = requirePositiveSafeIntegerMs(
    storageAck?.sendTimeoutMs,
    `${label}.sendTimeoutMs`,
  );
  const handlerDeadlineMs = handlerOverride ?? STORAGE_ACK_HANDLER_DEADLINE_DEFAULT_MS;
  const sendTimeoutMs = sendOverride ?? Math.max(
    STORAGE_ACK_SEND_TIMEOUT_DEFAULT_MS,
    handlerDeadlineMs + STORAGE_ACK_TIMING_SAFETY_MARGIN_MS,
  );
  if (sendTimeoutMs - handlerDeadlineMs < STORAGE_ACK_TIMING_SAFETY_MARGIN_MS) {
    throw new Error(
      `${label}.sendTimeoutMs must be at least ${STORAGE_ACK_TIMING_SAFETY_MARGIN_MS}ms ` +
      `greater than ${label}.handlerDeadlineMs ` +
      `(got handlerDeadlineMs=${handlerDeadlineMs}, sendTimeoutMs=${sendTimeoutMs})`,
    );
  }
  return { handlerDeadlineMs, sendTimeoutMs };
}
