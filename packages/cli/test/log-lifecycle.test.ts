import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogRedactor, Logger } from '@origintrail-official/dkg-core';
import { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { startDaemonLogLifecycle } from '../src/daemon/log-lifecycle.js';

describe('startDaemonLogLifecycle', () => {
  afterEach(() => {
    Logger.setSink(null);
    vi.useRealTimers();
  });

  it('wires legacy cleanup, diagnostic persistence, and shutdown cancellation', () => {
    vi.useFakeTimers();
    const dataDir = mkdtempSync(join(tmpdir(), 'dkg-daemon-log-lifecycle-'));
    let dashDb = new DashboardDB({
      dataDir,
      retentionDays: 365,
      legacyRoutineLogCleanupBatchRows: 2,
    });
    try {
      const insertLegacy = dashDb.db.prepare(
        `INSERT INTO logs (ts, level, module, message) VALUES (?, 'info', 'old-daemon', ?)`,
      );
      insertLegacy.run(Date.now(), 'legacy-1');
      insertLegacy.run(Date.now() + 1, 'legacy-2');
      dashDb.db.prepare(
        `DELETE FROM settings WHERE key LIKE 'legacyRoutineLogCleanup%'`,
      ).run();
      dashDb.close();
      dashDb = new DashboardDB({
        dataDir,
        retentionDays: 365,
        legacyRoutineLogCleanupBatchRows: 2,
      });

      let cleanupCalls = 0;
      const handle = startDaemonLogLifecycle({
        dashDb: {
          insertLog: (record) => dashDb.insertLog(record),
          runLegacyRoutineLogCleanupBatch: () => {
            cleanupCalls += 1;
            return dashDb.runLegacyRoutineLogCleanupBatch();
          },
        },
        log: () => {},
        redact: createLogRedactor(),
        remoteShipper: () => null,
        cleanupIntervals: {
          initialDelayMs: 10,
          catchupIntervalMs: 10,
          reclaimRetryMs: 10,
        },
      });

      const logger = new Logger('lifecycle-test');
      const context = { operationId: 'op-1', operationName: 'system' as const };
      logger.info(context, 'routine-current-version');
      logger.warn(context, 'diagnostic-current-version');

      vi.advanceTimersByTime(10);
      expect(cleanupCalls).toBe(1);
      expect(dashDb.db.prepare(
        `SELECT level, message FROM logs ORDER BY id`,
      ).all()).toEqual([
        { level: 'warn', message: 'diagnostic-current-version' },
      ]);

      // The exact-size batch conservatively scheduled a final probe. Daemon
      // shutdown must cancel it even though all legacy rows are already gone.
      handle.stop();
      vi.advanceTimersByTime(100);
      expect(cleanupCalls).toBe(1);
    } finally {
      if (dashDb.db.open) dashDb.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
