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

export function createChainDiscoveryScanRunner(input: {
  agent: {
    hasContextGraphRegistryScanWatermark(): Promise<boolean>;
    discoverContextGraphsFromChain(
      options: ReturnType<typeof chainDiscoveryScanOptions>,
    ): Promise<number>;
  };
  log: (msg: string) => void;
  pageBudget?: number;
  fullScanEvery?: number;
}): () => Promise<void> {
  let runs = 0;
  let inFlight = false;
  // GH#2323 — a failed attempt is retried as the SAME SCAN, not merely the
  // same run number. The mode is derived from the run number AND the mutable
  // watermark, and a partially-successful scan moves the watermark: a fresh
  // node's run-0 `seedFromCursor` that seeds blocks 0..1999 and then fails
  // would, recomputed, become a `seedFull` (run 0 + now-seeded watermark) —
  // discarding cursor resumption and the page budget for an unbounded
  // re-walk from block zero. Retrying the CAPTURED options instead resumes
  // `seedFromCursor` from the saved cursor, which is what "retry" means.
  let retryOptions: ReturnType<typeof chainDiscoveryScanOptions> | undefined;
  return async () => {
    if (inFlight) return;
    inFlight = true;
    // GH#2323 — peek at the slot, commit it only after the scan RESOLVES.
    // `runs++` before the awaits meant a rejected scan still consumed its
    // slot, and the run number is what selects the mode: a run-0 `seedFull`
    // startup-recovery scan that failed on a transient RPC error left runs
    // 1..47 issuing `incremental` scans, so the history it existed to
    // re-walk stayed unwalked until run 48 — roughly 24 hours at the
    // 30-minute cadence — with nothing in the log. A rejected scan now
    // retries the SAME run next tick: a failed full scan re-runs in 30
    // minutes, not a day.
    const run = runs;
    try {
      const options = retryOptions ?? chainDiscoveryScanOptions({
        run,
        watermarkSeeded: await input.agent.hasContextGraphRegistryScanWatermark(),
        pageBudget: input.pageBudget,
        fullScanEvery: input.fullScanEvery,
      });
      try {
        const found = await input.agent.discoverContextGraphsFromChain(options);
        retryOptions = undefined;
        runs = run + 1;
        if (found > 0) {
          input.log(`Chain scan: discovered ${found} new context graph(s)`);
        }
      } catch (err) {
        // Still non-critical — the daemon keeps running — but no longer
        // silent, and the slot survives for the retry.
        retryOptions = options;
        input.log(
          `Chain scan run ${run} (${options.mode}) failed; ` +
            `the same scan retries next tick: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      // Watermark probe failed before any options existed — nothing to pin;
      // the next tick recomputes from scratch.
      input.log(
        `Chain scan run ${run} skipped (watermark probe failed; retrying next tick): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      inFlight = false;
    }
  };
}
