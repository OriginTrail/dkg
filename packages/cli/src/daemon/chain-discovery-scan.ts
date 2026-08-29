/**
 * Chain-discovery scan scheduling: which scan mode each run issues, and the
 * runner the daemon's 30-minute timer drives (GH#2323).
 *
 * Extracted from lifecycle.ts — the runner is a self-contained state machine
 * with a narrow dependency surface (two agent methods and a log sink), and
 * retry/cadence policy changes should not require editing the module that
 * also owns boot, servers, workers and shutdown.
 */

export const CHAIN_FULL_SCAN_EVERY = 48; // about once per day at the 30-minute cadence
export const CHAIN_DISCOVERY_SCAN_PAGE_BUDGET = 30;

/**
 * How many consecutive ticks a failed scan is retried AS-IS before the runner
 * releases its slot and lets the normal cadence proceed. Bounded because an
 * unbounded pin trades one liveness bug for another: a deterministically
 * failing historical page would otherwise block incremental discovery of new
 * blocks forever.
 */
export const MAX_CONSECUTIVE_SAME_SCAN_RETRIES = 3;

/**
 * While a full resync is overdue (a `seedFull` exhausted its retries), a
 * fresh attempt is injected every this-many ticks (~2h at the 30-minute
 * cadence). Incremental scans run on the ticks in between, so recent blocks
 * keep being discovered while the historical re-walk stays scheduled.
 */
export const OVERDUE_FULL_RESYNC_RETRY_EVERY = 4;

export function chainDiscoveryScanOptions(input: {
  watermarkSeeded: boolean;
  run?: number;
  fullScanEvery?: number;
  pageBudget?: number;
}):
  | { mode: 'incremental'; pageBudget: number }
  | { mode: 'seedFromCursor'; throwOnChainScanFailure: true; pageBudget: number }
  | { mode: 'seedFull'; throwOnChainScanFailure: true } {
  const configuredFullScanEvery = input.fullScanEvery;
  let fullScanEvery = CHAIN_FULL_SCAN_EVERY;
  if (
    typeof configuredFullScanEvery === 'number' &&
    Number.isFinite(configuredFullScanEvery) &&
    configuredFullScanEvery >= 1
  ) {
    fullScanEvery = Math.floor(configuredFullScanEvery);
  }
  const configuredPageBudget = input.pageBudget;
  const pageBudget = (
    typeof configuredPageBudget === 'number' &&
    Number.isFinite(configuredPageBudget) &&
    configuredPageBudget >= 1
  )
    ? Math.floor(configuredPageBudget)
    : CHAIN_DISCOVERY_SCAN_PAGE_BUDGET;
  const run = input.run ?? 0;
  const startupRecoveryScan = input.watermarkSeeded && run === 0;
  const periodicFullResync = input.watermarkSeeded && run > 0 && run % fullScanEvery === 0;
  if (startupRecoveryScan || periodicFullResync) {
    return { mode: 'seedFull', throwOnChainScanFailure: true };
  }
  return input.watermarkSeeded && !periodicFullResync
    ? { mode: 'incremental', pageBudget }
    : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget };
}

type ScanOptions = ReturnType<typeof chainDiscoveryScanOptions>;

/**
 * The scan runner (GH#2323). Its scheduling invariants, each pinned by a
 * test:
 *
 * SLOT ON RESOLVE. The run counter advances only when a scan settles the
 * slot — success, or a failure that exhausted its retries. `runs++` before
 * the awaits meant a rejected run-0 `seedFull` burned its slot and silently
 * downgraded the startup recovery to `incremental` until run 48 (~24h).
 *
 * SAME SCAN, NOT SAME NUMBER. A failed attempt is retried with its CAPTURED
 * options. The mode derives from the run number AND the mutable watermark,
 * and a partially-successful scan moves the watermark — recomputed, a fresh
 * node's failed `seedFromCursor` would become an unbounded `seedFull` from
 * block zero instead of resuming its cursor.
 *
 * BOUNDED PIN. The same failed scan is retried at most
 * MAX_CONSECUTIVE_SAME_SCAN_RETRIES ticks in a row, then its slot is
 * released so the normal cadence (usually `incremental`) resumes — a
 * deterministic failure must not starve discovery of new blocks forever.
 *
 * OVERDUE RESYNC. A released `seedFull` is not forgotten: while overdue, a
 * fresh attempt is injected every OVERDUE_FULL_RESYNC_RETRY_EVERY ticks in
 * place of an incremental scan, until one succeeds.
 *
 * ATOMIC COMMITS. All scheduling state is committed before anything is
 * logged, and the watermark probe has its own error boundary — a throwing
 * log line must neither corrupt the state machine nor be misclassified as a
 * probe failure.
 */
export function createChainDiscoveryScanRunner(input: {
  agent: {
    hasContextGraphRegistryScanWatermark(): Promise<boolean>;
    discoverContextGraphsFromChain(options: ScanOptions): Promise<number>;
  };
  log: (msg: string) => void;
  pageBudget?: number;
  fullScanEvery?: number;
}): () => Promise<void> {
  let runs = 0;
  let inFlight = false;
  let retryOptions: ScanOptions | undefined;
  let consecutiveRetries = 0;
  let fullResyncOverdue = false;
  let ticksSinceOverdueAttempt = 0;

  const safeLog = (msg: string): void => {
    try {
      input.log(msg);
    } catch {
      /* a broken log sink must not affect scan scheduling */
    }
  };

  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const run = runs;

      // ── Select the scan ────────────────────────────────────────────────
      let options: ScanOptions;
      if (retryOptions !== undefined) {
        options = retryOptions;
      } else {
        let watermarkSeeded: boolean;
        try {
          watermarkSeeded = await input.agent.hasContextGraphRegistryScanWatermark();
        } catch (err) {
          // Probe failure: no options exist to pin, and the slot survives —
          // scoped to the probe call so nothing else can be misclassified.
          safeLog(
            `Chain scan run ${run} skipped (watermark probe failed; retrying next tick): ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
        options = chainDiscoveryScanOptions({
          run,
          watermarkSeeded,
          pageBudget: input.pageBudget,
          fullScanEvery: input.fullScanEvery,
        });
        if (fullResyncOverdue && options.mode === 'incremental') {
          ticksSinceOverdueAttempt += 1;
          if (ticksSinceOverdueAttempt >= OVERDUE_FULL_RESYNC_RETRY_EVERY) {
            ticksSinceOverdueAttempt = 0;
            options = { mode: 'seedFull', throwOnChainScanFailure: true };
          }
        }
      }

      // ── Run it ─────────────────────────────────────────────────────────
      let found: number | undefined;
      let failure: unknown;
      try {
        found = await input.agent.discoverContextGraphsFromChain(options);
      } catch (err) {
        failure = err;
      }

      // ── Commit ALL state atomically, before any logging ────────────────
      let released = false;
      if (failure === undefined) {
        retryOptions = undefined;
        consecutiveRetries = 0;
        runs = run + 1;
        if (options.mode === 'seedFull') {
          fullResyncOverdue = false;
          ticksSinceOverdueAttempt = 0;
        }
      } else if (consecutiveRetries < MAX_CONSECUTIVE_SAME_SCAN_RETRIES) {
        retryOptions = options;
        consecutiveRetries += 1;
      } else {
        // Retries exhausted: release the slot so the cadence proceeds, and
        // keep a failed full resync scheduled instead of forgetting it.
        released = true;
        retryOptions = undefined;
        consecutiveRetries = 0;
        runs = run + 1;
        if (options.mode === 'seedFull') {
          fullResyncOverdue = true;
          ticksSinceOverdueAttempt = 0;
        }
      }

      // ── Report ─────────────────────────────────────────────────────────
      if (failure === undefined) {
        if (found !== undefined && found > 0) {
          safeLog(`Chain scan: discovered ${found} new context graph(s)`);
        }
      } else {
        const reason = failure instanceof Error ? failure.message : String(failure);
        safeLog(
          released
            ? `Chain scan run ${run} (${options.mode}) failed ${MAX_CONSECUTIVE_SAME_SCAN_RETRIES + 1}x; ` +
              `releasing the slot so discovery continues` +
              (options.mode === 'seedFull'
                ? ` — the full resync stays scheduled and retries every ${OVERDUE_FULL_RESYNC_RETRY_EVERY} tick(s)`
                : '') +
              `: ${reason}`
            : `Chain scan run ${run} (${options.mode}) failed; ` +
              `the same scan retries next tick: ${reason}`,
        );
      }
    } finally {
      inFlight = false;
    }
  };
}
