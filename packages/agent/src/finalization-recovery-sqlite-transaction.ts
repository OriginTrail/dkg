// SPDX-License-Identifier: Apache-2.0
import type { DatabaseSync } from 'node:sqlite';

/** One atomic boundary for inbox mutations, including their typed results. */
export function finalizationRecoveryTransaction<T>(database: DatabaseSync, operation: () => T): T {
    let open = false;
    try {
      database.exec('BEGIN IMMEDIATE');
      open = true;
      const result = operation();
      database.exec('COMMIT');
      open = false;
      return result;
    } catch (error) {
      if (open) {
        try { database.exec('ROLLBACK'); } catch { /* retain transaction failure */ }
      }
      throw error;
    }
  }

