import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

function integerSetting(name, fallback, minimum) {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
  return parsed;
}

const routineRows = integerSetting('DKG_BENCH_ROUTINE_ROWS', 1_050_000, 1);
const rowCap = integerSetting('DKG_BENCH_ROUTINE_CAP', 1_000_000, 0);
const checks = integerSetting('DKG_BENCH_RETENTION_CHECKS', 50, 1);
const trials = integerSetting('DKG_BENCH_TRIALS', 5, 1);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function measure(operation) {
  const samples = [];
  for (let trial = 0; trial < trials; trial += 1) {
    const startedAt = performance.now();
    for (let check = 0; check < checks; check += 1) {
      operation();
    }
    samples.push(performance.now() - startedAt);
  }
  return median(samples);
}

const directory = mkdtempSync(join(tmpdir(), 'dkg-routine-retention-bench-'));
const databasePath = join(directory, 'node-ui.db');
const db = new Database(databasePath);

try {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,
      module TEXT,
      message TEXT NOT NULL
    );
    WITH RECURSIVE rows(id) AS (
      SELECT 1
      UNION ALL
      SELECT id + 1 FROM rows WHERE id < ${routineRows}
    )
    INSERT INTO logs (ts, level, module, message)
    SELECT id, 'info', 'benchmark', 'routine' FROM rows;
    CREATE INDEX idx_logs_routine_id
      ON logs(id)
      WHERE level NOT IN ('warn', 'error');
    CREATE TABLE routine_log_retention_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      routine_rows INTEGER NOT NULL CHECK (routine_rows >= 0)
    );
    INSERT INTO routine_log_retention_state (singleton, routine_rows)
    VALUES (1, ${routineRows});
  `);

  const legacyCutoff = db.prepare(`
    SELECT id
    FROM logs
    WHERE level NOT IN ('warn', 'error')
    ORDER BY id DESC
    LIMIT 1 OFFSET ?
  `);
  const retainedCount = db.prepare(`
    SELECT routine_rows
    FROM routine_log_retention_state
    WHERE singleton = 1
  `);

  // Warm both statements and prove they observe the seeded state before the
  // isolated trials. With monotonically assigned ids, the legacy cutoff is the
  // first row outside the newest `rowCap` routine rows.
  const expectedCutoff = routineRows > rowCap ? routineRows - rowCap : undefined;
  const observedCutoff = legacyCutoff.get(rowCap)?.id;
  const observedCount = retainedCount.get()?.routine_rows;
  if (observedCutoff !== expectedCutoff || observedCount !== routineRows) {
    throw new Error(`Benchmark state mismatch: cutoff=${observedCutoff}, count=${observedCount}`);
  }

  const legacyMs = measure(() => legacyCutoff.get(rowCap)?.id);
  const counterMs = measure(() => retainedCount.get()?.routine_rows);
  const result = {
    node: process.version,
    routineRows,
    rowCap,
    checks,
    trials,
    legacyOffsetMedianMs: legacyMs,
    counterMedianMs: counterMs,
    speedup: legacyMs / counterMs,
  };

  console.log('Routine-log retention overflow-check benchmark');
  console.log(`Node ${process.version}; ${routineRows.toLocaleString()} routine rows; ${checks} checks; ${trials} trials`);
  console.log('');
  console.log('| Legacy OFFSET median | Counter median | Speedup |');
  console.log('| ---: | ---: | ---: |');
  console.log(`| ${legacyMs.toFixed(2)} ms | ${counterMs.toFixed(3)} ms | ${result.speedup.toFixed(1)}x |`);
  console.log('');
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
