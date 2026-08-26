import { appendFile } from 'node:fs/promises';
import type { CanonicalLogRecord } from '@origintrail-official/dkg-core';
import { formatDaemonDebugLog } from './log-sink.js';

export interface DaemonDebugLogWriter {
  push(record: CanonicalLogRecord): boolean;
  shutdown(): Promise<void>;
  pending(): number;
  dropped(): number;
}

/**
 * Owns the debug-only daemon.log path. At most one append is active, queued
 * records are bounded with drop-oldest overflow, and shutdown drains every
 * record that remains accepted after overflow handling.
 */
export function startDaemonDebugLogWriter(opts: {
  logFile: string;
  maxQueuedEntries?: number;
  maxBatchEntries?: number;
  append?: (data: string) => Promise<void>;
  onError?: (message: string) => void;
  onDrop?: (dropped: number) => void;
}): DaemonDebugLogWriter {
  const maxQueuedEntries = Math.max(1, Math.floor(opts.maxQueuedEntries ?? 2_048));
  const maxBatchEntries = Math.max(1, Math.floor(opts.maxBatchEntries ?? 128));
  const append = opts.append ?? ((data: string) => appendFile(opts.logFile, data));
  const queue: string[] = [];
  let accepting = true;
  let inFlightEntries = 0;
  let droppedEntries = 0;
  let errorReported = false;
  let drainPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const report = (callback: (() => void) | undefined): void => {
    try {
      callback?.();
    } catch {
      // Diagnostics about logging must never break the logging path itself.
    }
  };

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const batch = queue.splice(0, maxBatchEntries);
      inFlightEntries = batch.length;
      try {
        await append(batch.join(''));
        errorReported = false;
      } catch (error) {
        if (!errorReported) {
          errorReported = true;
          report(() => opts.onError?.(
            error instanceof Error ? error.message : String(error),
          ));
        }
      } finally {
        inFlightEntries = 0;
      }
    }
  };

  const ensureDrain = (): void => {
    if (drainPromise) return;
    drainPromise = drain().finally(() => {
      drainPromise = null;
      if (queue.length > 0) ensureDrain();
    });
  };

  return {
    push(record) {
      if (!accepting) return false;
      if (queue.length >= maxQueuedEntries) {
        queue.shift();
        droppedEntries += 1;
        // Report at powers of two so sustained overflow is visible without
        // turning the fallback diagnostic itself into a new log storm.
        if ((droppedEntries & (droppedEntries - 1)) === 0) {
          report(() => opts.onDrop?.(droppedEntries));
        }
      }
      queue.push(formatDaemonDebugLog(record));
      ensureDrain();
      return true;
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      accepting = false;
      shutdownPromise = (async () => {
        while (drainPromise || queue.length > 0) {
          ensureDrain();
          const activeDrain = drainPromise;
          if (activeDrain) await activeDrain;
        }
      })();
      return shutdownPromise;
    },
    pending: () => inFlightEntries + queue.length,
    dropped: () => droppedEntries,
  };
}
