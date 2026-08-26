import { appendFile } from 'node:fs/promises';
import {
  formatLogRecord,
  type CanonicalLogRecord,
} from '@origintrail-official/dkg-core';
import type { DaemonLogRotationResult } from './log-rotation.js';

export type DaemonLogWriteClass = 'standard' | 'debug';
export type DebugLogRecord = CanonicalLogRecord & { level: 'debug' };

export function isDebugLogRecord(record: CanonicalLogRecord): record is DebugLogRecord {
  return record.level === 'debug';
}

export interface DaemonLogFileWriter {
  push(data: string): boolean;
  pushDebug(record: DebugLogRecord): boolean;
  flush(): Promise<void>;
  rotate(): Promise<DaemonLogRotationResult>;
  shutdown(): Promise<void>;
  pending(): number;
  dropped(): number;
}

interface AppendWork {
  kind: 'append';
  data: string;
  classification: DaemonLogWriteClass;
}

interface RotationWork {
  kind: 'rotation';
  resolve: (value: DaemonLogRotationResult) => void;
  reject: (error: unknown) => void;
}

interface FlushWork {
  kind: 'flush';
  resolve: () => void;
}

type Work = AppendWork | RotationWork | FlushWork;

/**
 * Owns every in-process append to daemon.log. Writes are serialized, queued
 * appends are bounded, debug entries are the first overflow candidates, and
 * rotation/flush operations share the same ordered lifecycle.
 */
export function startDaemonLogFileWriter(opts: {
  logFile: string;
  maxQueuedEntries?: number;
  maxBatchEntries?: number;
  maxAppendAttempts?: number;
  append?: (data: string) => Promise<void>;
  rotate?: () => Promise<DaemonLogRotationResult>;
  waitBeforeRetry?: (failedAttempt: number) => Promise<void>;
  onDiagnostic?: (message: string) => void | Promise<void>;
}): DaemonLogFileWriter {
  const maxQueuedEntries = Math.max(1, Math.floor(opts.maxQueuedEntries ?? 2_048));
  const maxBatchEntries = Math.max(1, Math.floor(opts.maxBatchEntries ?? 128));
  const maxAppendAttempts = Math.max(1, Math.floor(opts.maxAppendAttempts ?? 3));
  const append = opts.append ?? ((data: string) => appendFile(opts.logFile, data));
  const waitBeforeRetry = opts.waitBeforeRetry ?? ((failedAttempt: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(250, 10 * (2 ** (failedAttempt - 1))));
    }));
  const queue: Work[] = [];
  let queuedAppends = 0;
  let accepting = true;
  let inFlightEntries = 0;
  let droppedEntries = 0;
  let overflowDroppedEntries = 0;
  let drainPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let diagnosticChain = Promise.resolve();

  const queueDiagnostic = (message: string): void => {
    diagnosticChain = diagnosticChain
      .then(() => opts.onDiagnostic?.(message))
      .then(() => undefined)
      .catch(() => undefined);
  };

  const recordOverflowDrop = (classification: DaemonLogWriteClass): void => {
    droppedEntries += 1;
    overflowDroppedEntries += 1;
    // Coalesce sustained overflow diagnostics at powers of two.
    if ((overflowDroppedEntries & (overflowDroppedEntries - 1)) === 0) {
      queueDiagnostic(
        `queue full; dropped ${overflowDroppedEntries} append ` +
        `entr${overflowDroppedEntries === 1 ? 'y' : 'ies'} due to overflow ` +
        `(total dropped=${droppedEntries}; latest classification: ${classification})`,
      );
    }
  };

  const removeOldestQueuedAppend = (classification?: DaemonLogWriteClass): boolean => {
    const index = queue.findIndex((work) =>
      work.kind === 'append' &&
      (classification === undefined || work.classification === classification));
    if (index < 0) return false;
    const [removed] = queue.splice(index, 1);
    queuedAppends -= 1;
    recordOverflowDrop((removed as AppendWork).classification);
    return true;
  };

  const appendBatch = async (batch: AppendWork[]): Promise<void> => {
    const payload = batch.map((work) => work.data).join('');
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAppendAttempts; attempt++) {
      try {
        await append(payload);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < maxAppendAttempts) {
          await waitBeforeRetry(attempt).catch(() => {});
        }
      }
    }

    droppedEntries += batch.length;
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    queueDiagnostic(
      `append failed after ${maxAppendAttempts} attempt(s); discarded ` +
      `${batch.length} accepted entr${batch.length === 1 ? 'y' : 'ies'}; ` +
      `total dropped=${droppedEntries}: ${detail}`,
    );
  };

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const first = queue[0];
      if (first.kind === 'rotation') {
        queue.shift();
        try {
          if (!opts.rotate) {
            throw new Error('daemon log rotation is not configured');
          }
          first.resolve(await opts.rotate());
        } catch (error) {
          first.reject(error);
        }
        continue;
      }
      if (first.kind === 'flush') {
        queue.shift();
        first.resolve();
        continue;
      }

      const batch: AppendWork[] = [];
      while (batch.length < maxBatchEntries && queue[0]?.kind === 'append') {
        batch.push(queue.shift() as AppendWork);
        queuedAppends -= 1;
      }
      inFlightEntries = batch.length;
      try {
        await appendBatch(batch);
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

  const rotate = (): Promise<DaemonLogRotationResult> => {
    if (!accepting) return Promise.reject(new Error('daemon log writer is stopped'));
    return new Promise<DaemonLogRotationResult>((resolve, reject) => {
      queue.push({
        kind: 'rotation',
        resolve,
        reject,
      });
      ensureDrain();
    });
  };

  const flush = (): Promise<void> => {
    if (!accepting) return Promise.reject(new Error('daemon log writer is stopped'));
    return new Promise<void>((resolve) => {
      queue.push({ kind: 'flush', resolve });
      ensureDrain();
    });
  };

  const push = (data: string, classification: DaemonLogWriteClass): boolean => {
    if (!accepting) return false;
    if (queuedAppends >= maxQueuedEntries) {
      // Debug output is intentionally the first thing sacrificed. A new
      // debug entry cannot evict standard output when no debug is queued.
      const removedDebug = removeOldestQueuedAppend('debug');
      if (!removedDebug && classification === 'debug') {
        recordOverflowDrop('debug');
        return false;
      }
      if (!removedDebug) removeOldestQueuedAppend();
    }
    queue.push({ kind: 'append', data, classification });
    queuedAppends += 1;
    ensureDrain();
    return true;
  };

  return {
    push: (data) => push(data, 'standard'),
    pushDebug: (record) => push(formatLogRecord(record, {
      timestampStyle: 'iso-bracketed',
      includeLevel: true,
      trailingNewline: true,
    }), 'debug'),
    flush,
    rotate,
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      accepting = false;
      shutdownPromise = (async () => {
        while (drainPromise || queue.length > 0) {
          ensureDrain();
          const activeDrain = drainPromise;
          if (activeDrain) await activeDrain;
        }
        await diagnosticChain;
      })();
      return shutdownPromise;
    },
    pending: () => inFlightEntries + queuedAppends,
    dropped: () => droppedEntries,
  };
}
