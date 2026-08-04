#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * W1 §8.5 — hot-path overhead of the sync telemetry record sites (A18).
 *
 *   node packages/agent/scripts/bench-sync-telemetry.mjs --pages 200 --warmup 50 --json
 *
 * ## Why this file exists at all
 *
 * v4 of the plan gave a budget with no script. An implementer could then time a
 * mock that never reaches a record site and still report that the budget passed.
 * So the one property this benchmark must never lose is that it drives the REAL
 * helpers. There is deliberately **no stub fallback**: if the real module cannot
 * be loaded, this exits non-zero rather than measuring something else and
 * reporting a number that looks like an answer.
 *
 * ## What is actually measured (do not overclaim from these numbers)
 *
 * Per page — the real per-attempt path, exactly as the send bracket calls it:
 *   `syncAttemptAttributes()` → `recordSyncAttemptRequestBytes()` (I2)
 *   → `recordSyncAttempt()` (I1) → `recordSyncAttemptResponseBytes()` (I3)
 *
 * Per operation — the real I4 boundary instrumentation:
 *   `withSyncAdmissionSource()` (the AsyncLocalStorage scope that makes `source`
 *   ambient) wrapping a `monotonicNowMs()` bracket → `recordSyncOperationDuration()`
 *
 * It does NOT drive `runContextGraphSyncWithBackpressure` itself, because that
 * needs a live `DKGAgent`, peers and a store — whose cost would dominate and
 * whose variance would swamp the signal. The claim this benchmark supports is
 * therefore precisely: *"the instrumentation added to the attempt path and to
 * the I4 boundary costs <= X ms per page"*, not *"a sync page costs X ms"*.
 * `--print-seams` lists the resolved functions so a reviewer can confirm the
 * real ones were loaded.
 *
 * ## Arms
 *
 * `noop` — no global MeterProvider registered, so `getMetrics()` binds to the
 *          OpenTelemetry API's no-op meter. This is a node with telemetry off.
 * `sdk`  — a real `MeterProvider` + `PeriodicExportingMetricReader` over a stub
 *          exporter, with the export interval pushed past the run so the timer
 *          never fires: we are measuring the RECORD path, which is what sits on
 *          the hot path, not the exporter's I/O, which does not.
 *
 * Arms are **interleaved** round by round and reduced by median. Running one arm
 * to completion and then the other lets JIT warm-up, GC scheduling and CPU
 * frequency drift land entirely on one side and be reported as instrumentation
 * cost; alternating cancels monotonic drift, and the median discards the
 * scheduler outliers a shared machine produces.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(scriptDir, '..');

// ─────────────────────────────────────────────────────────────── args ────────

function parseArgs(argv) {
  const opts = {
    pages: 200,
    warmup: 50,
    rounds: 15,
    pagesPerOperation: 20,
    requestBytes: 512,
    responseBytes: 64 * 1024,
    json: false,
    ci: false,
    printSeams: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const num = (name) => {
      const raw = argv[i + 1];
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        fail(`--${name} requires a positive number (got ${JSON.stringify(raw)})`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case '--pages': opts.pages = num('pages'); break;
      case '--warmup': opts.warmup = num('warmup'); break;
      case '--rounds': opts.rounds = num('rounds'); break;
      case '--pages-per-operation': opts.pagesPerOperation = num('pages-per-operation'); break;
      case '--request-bytes': opts.requestBytes = num('request-bytes'); break;
      case '--response-bytes': opts.responseBytes = num('response-bytes'); break;
      case '--json': opts.json = true; break;
      // Host variance on a shared runner is expected, so CI records the numbers
      // without gating (§8.5). The bound is still evaluated and reported.
      case '--ci': opts.ci = true; break;
      case '--print-seams': opts.printSeams = true; break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default: fail(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function usage() {
  console.log(
    'usage: node packages/agent/scripts/bench-sync-telemetry.mjs ' +
      '[--pages N] [--warmup N] [--rounds N] [--pages-per-operation N] ' +
      '[--request-bytes N] [--response-bytes N] [--json] [--ci] [--print-seams]',
  );
}

function fail(message) {
  console.error(`bench-sync-telemetry: ${message}`);
  process.exit(2);
}

// ─────────────────────────────────────────────── load the REAL seam ──────────

/**
 * Resolve the real record helpers out of the built package.
 *
 * Cross-package imports load `dist`, so §8.1's build must have run. Two guards,
 * both hard failures rather than fallbacks:
 *
 *  1. the module must exist and export every helper we intend to time;
 *  2. the built file must not be older than its source — benchmarking a stale
 *     `dist` measures code that is not the code under review, which is the same
 *     class of mistake as running a mutation against an unrebuilt dependency.
 */
async function loadRealSeam() {
  const distFile = path.join(pkgRoot, 'dist/sync/attempt-telemetry.js');
  const srcFile = path.join(pkgRoot, 'src/sync/attempt-telemetry.ts');
  const buildHint =
    'build the closure first (§8.1):\n' +
    '  pnpm --filter @origintrail-official/dkg-core build\n' +
    '  pnpm --filter @origintrail-official/dkg-agent build';

  if (!fs.existsSync(distFile)) {
    fail(`real record helper not built: ${distFile} is missing.\n${buildHint}`);
  }
  if (fs.existsSync(srcFile)) {
    const distMtime = fs.statSync(distFile).mtimeMs;
    const srcMtime = fs.statSync(srcFile).mtimeMs;
    if (srcMtime > distMtime) {
      fail(
        `dist is STALE: src/sync/attempt-telemetry.ts is newer than its build ` +
          `output, so this run would measure code that is not on disk.\n${buildHint}`,
      );
    }
  }

  const mod = await import(pathToFileURL(distFile).href);
  const required = [
    'syncAttemptAttributes',
    'recordSyncAttempt',
    'recordSyncAttemptRequestBytes',
    'recordSyncAttemptResponseBytes',
    'recordSyncOperationDuration',
    'withSyncAdmissionSource',
    'monotonicNowMs',
  ];
  const absent = required.filter((name) => typeof mod[name] !== 'function' && name !== 'monotonicNowMs');
  if (typeof mod.monotonicNowMs !== 'function') absent.push('monotonicNowMs');
  if (absent.length) {
    fail(
      `the real record helper is missing exports: ${absent.join(', ')}.\n` +
        'This benchmark deliberately has no stub fallback — a stub would let a ' +
        'budget "pass" without ever reaching a record site.',
    );
  }
  return { mod, distFile };
}

// ───────────────────────────────────────────────────── metric arms ──────────

function loadOtel() {
  try {
    return {
      api: require('@opentelemetry/api'),
      sdk: require('@opentelemetry/sdk-metrics'),
      core: require('@origintrail-official/dkg-core'),
    };
  } catch (error) {
    fail(
      `could not load the OpenTelemetry SDK / dkg-core from ${pkgRoot}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Swallows batches. `PeriodicExportingMetricReader` requires the temporality
 * selector; everything else resolves immediately so teardown cannot hang.
 */
function createStubExporter(sdk) {
  let batches = 0;
  return {
    batches: () => batches,
    exporter: {
      export(_resourceMetrics, resultCallback) {
        batches += 1;
        resultCallback({ code: sdk.ExportResultCode?.SUCCESS ?? 0 });
      },
      forceFlush: async () => {},
      shutdown: async () => {},
      selectAggregationTemporality: () => sdk.AggregationTemporality.CUMULATIVE,
    },
  };
}

function installNoopArm({ api, core }) {
  // No provider registered ⇒ the API hands back a no-op meter. `disable()` clears
  // any provider a previous arm registered; `rebuildMetrics()` then rebinds the
  // cached instruments, which is what every record site reads through.
  api.metrics.disable();
  core.rebuildMetrics();
  return { teardown: async () => {} };
}

function installSdkArm({ api, sdk, core }, runtimeMs) {
  const stub = createStubExporter(sdk);
  const provider = new sdk.MeterProvider({
    readers: [
      new sdk.PeriodicExportingMetricReader({
        exporter: stub.exporter,
        // Past the end of the run: we are timing the record path, which is on
        // the hot path. The exporter's timer is not.
        exportIntervalMillis: Math.max(600_000, runtimeMs * 10),
      }),
    ],
  });
  api.metrics.disable();
  api.metrics.setGlobalMeterProvider(provider);
  core.rebuildMetrics();
  return {
    exportedBatches: stub.batches,
    teardown: async () => {
      await provider.shutdown().catch(() => {});
      api.metrics.disable();
      core.rebuildMetrics();
    },
  };
}

// ───────────────────────────────────────────────────── workload ─────────────

/**
 * One round = `pages` attempt records plus the I4 boundary work for each
 * completed operation. Returns milliseconds for the whole round; the caller
 * divides by `pages` so the unit is ms/page, which is what A18 bounds.
 *
 * Attribute values are fixed, so both arms allocate identically and the SDK arm
 * accumulates into a bounded number of series — the same shape a real node with
 * closed vocabularies produces.
 */
function runRound(seam, opts) {
  const {
    syncAttemptAttributes,
    recordSyncAttempt,
    recordSyncAttemptRequestBytes,
    recordSyncAttemptResponseBytes,
    recordSyncOperationDuration,
    withSyncAdmissionSource,
    monotonicNowMs,
  } = seam;

  // Pages are dealt out from a REMAINING counter rather than re-derived as
  // `ceil(pages / operations)`. For a non-divisible split the derived form
  // over-executes and then divides by the requested count: `--pages 201
  // --pages-per-operation 20` gave 11 x 19 = 209 recorded attempts reported as
  // 201, inflating ms/page by ~4% and able to fail the A18 budget on cost the
  // benchmark invented. The last operation is simply short.
  const operations = Math.max(1, Math.ceil(opts.pages / opts.pagesPerOperation));
  let remainingPages = opts.pages;
  let recordedPages = 0;

  const startedAt = monotonicNowMs();
  for (let op = 0; op < operations; op += 1) {
    const pagesPerOperation = Math.min(opts.pagesPerOperation, remainingPages);
    remainingPages -= pagesPerOperation;
    recordedPages += pagesPerOperation;
    // The real I4 boundary: the ambient-source scope wrapping a monotonic
    // bracket, ending in the duration record.
    withSyncAdmissionSource('catchup-foreground', () => {
      const operationStartedAt = monotonicNowMs();
      for (let page = 0; page < pagesPerOperation; page += 1) {
        // Exactly the per-attempt sequence the send bracket performs.
        const attributes = syncAttemptAttributes({
          transport: 'legacy',
          plane: 'durable',
          phase: 'data',
        });
        recordSyncAttemptRequestBytes(attributes, opts.requestBytes);
        recordSyncAttempt(attributes, 'response');
        recordSyncAttemptResponseBytes(attributes, opts.responseBytes, 'response');
      }
      recordSyncOperationDuration({
        lane: 'durable',
        source: 'catchup-foreground',
        outcome: 'resolved',
        durationMs: monotonicNowMs() - operationStartedAt,
      });
    });
  }
  const elapsedMs = monotonicNowMs() - startedAt;
  // The caller divides by `opts.pages`, so that has to be what actually ran.
  // Asserted rather than commented, because the previous arithmetic was wrong
  // in exactly this way and reported a plausible number while being wrong.
  if (recordedPages !== opts.pages) {
    throw new Error(
      `bench-sync-telemetry: recorded ${recordedPages} page attempts but reports per ${opts.pages} `
      + `(operations=${operations}, pagesPerOperation=${opts.pagesPerOperation}) — ms/page would be wrong`,
    );
  }
  return elapsedMs;
}

// ───────────────────────────────────────────────────── statistics ───────────

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// ───────────────────────────────────────────────────────── main ─────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { mod: seam, distFile } = await loadRealSeam();
  const otel = loadOtel();

  if (opts.printSeams) {
    console.log(`resolved real seam: ${distFile}`);
    for (const name of Object.keys(seam).sort()) {
      if (typeof seam[name] === 'function') console.log(`  - ${name}`);
    }
  }

  // Warm-up runs against BOTH arms so neither pays first-call JIT during
  // measurement. The SDK arm additionally lazily creates its series on first
  // record, which would otherwise show up as instrumentation cost.
  const warmupOpts = { ...opts, pages: opts.warmup };
  for (const install of [installNoopArm, installSdkArm]) {
    const arm = install(otel, 1_000);
    runRound(seam, warmupOpts);
    runRound(seam, warmupOpts);
    await arm.teardown();
  }

  const samples = { noop: [], sdk: [] };
  let exportedBatches = 0;

  for (let round = 0; round < opts.rounds; round += 1) {
    // Interleaved, and the order flips every round so a systematic
    // first-in-round advantage cannot accrue to one arm.
    const order = round % 2 === 0 ? ['noop', 'sdk'] : ['sdk', 'noop'];
    for (const armName of order) {
      const arm = armName === 'noop'
        ? installNoopArm(otel)
        : installSdkArm(otel, opts.rounds * 100);
      const elapsedMs = runRound(seam, opts);
      samples[armName].push(elapsedMs / opts.pages);
      if (armName === 'sdk' && arm.exportedBatches) exportedBatches += arm.exportedBatches();
      await arm.teardown();
    }
  }

  const noopMedian = median(samples.noop);
  const sdkMedian = median(samples.sdk);
  const absoluteDeltaMs = sdkMedian - noopMedian;
  const relativePct = noopMedian > 0 ? (absoluteDeltaMs / noopMedian) * 100 : Infinity;

  // A18: <= 2 % relative AND <= 1 ms absolute per page — except that when the
  // no-op baseline is under 5 ms/page the percentage is noise and the ABSOLUTE
  // bound governs. A record-site-only benchmark is always in that regime, so the
  // relative number is reported for the record and does not decide the verdict.
  const ABSOLUTE_BUDGET_MS = 1;
  const RELATIVE_BUDGET_PCT = 2;
  const NOISE_FLOOR_MS_PER_PAGE = 5;
  const absoluteGoverns = noopMedian < NOISE_FLOOR_MS_PER_PAGE;
  const withinAbsolute = absoluteDeltaMs <= ABSOLUTE_BUDGET_MS;
  const withinRelative = relativePct <= RELATIVE_BUDGET_PCT;
  const pass = absoluteGoverns ? withinAbsolute : withinAbsolute && withinRelative;

  const result = {
    acceptance: 'A18',
    governingBound: absoluteGoverns ? 'absolute' : 'absolute+relative',
    pass,
    gated: !opts.ci,
    config: {
      pages: opts.pages,
      warmup: opts.warmup,
      rounds: opts.rounds,
      pagesPerOperation: opts.pagesPerOperation,
      requestBytes: opts.requestBytes,
      responseBytes: opts.responseBytes,
    },
    seam: {
      module: path.relative(path.resolve(pkgRoot, '../..'), distFile).replace(/\\/g, '/'),
      perAttempt: [
        'syncAttemptAttributes',
        'recordSyncAttemptRequestBytes',
        'recordSyncAttempt',
        'recordSyncAttemptResponseBytes',
      ],
      i4Boundary: ['withSyncAdmissionSource', 'monotonicNowMs', 'recordSyncOperationDuration'],
      stubbed: [],
    },
    msPerPage: {
      noopMedian,
      sdkMedian,
      noopP95: percentile(samples.noop, 95),
      sdkP95: percentile(samples.sdk, 95),
      absoluteDeltaMs,
      relativePct,
    },
    budget: {
      absoluteMs: ABSOLUTE_BUDGET_MS,
      relativePct: RELATIVE_BUDGET_PCT,
      noiseFloorMsPerPage: NOISE_FLOOR_MS_PER_PAGE,
      withinAbsolute,
      withinRelative,
    },
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: require('node:os').cpus()?.[0]?.model ?? 'unknown',
    },
    // A non-zero count would mean the exporter timer fired mid-measurement and
    // its I/O is inside the numbers. It must stay 0.
    exportedBatchesDuringMeasurement: exportedBatches,
    samples,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const us = (ms) => `${(ms * 1000).toFixed(3)} µs`;
    console.log('');
    console.log('W1 §8.5 sync-telemetry overhead (A18)');
    console.log(`  seam            ${result.seam.module}`);
    console.log(`  config          pages=${opts.pages} warmup=${opts.warmup} rounds=${opts.rounds}`);
    console.log(`  no-op   median  ${us(noopMedian)}/page  (p95 ${us(result.msPerPage.noopP95)})`);
    console.log(`  sdk     median  ${us(sdkMedian)}/page  (p95 ${us(result.msPerPage.sdkP95)})`);
    console.log(`  delta           ${us(absoluteDeltaMs)}/page  (${relativePct.toFixed(1)} %)`);
    console.log(`  governing bound ${result.governingBound} (no-op baseline ` +
      `${absoluteGoverns ? 'below' : 'above'} the ${NOISE_FLOOR_MS_PER_PAGE} ms/page noise floor)`);
    console.log(`  verdict         ${pass ? 'PASS' : 'FAIL'}` + (opts.ci ? ' (recorded, not gated)' : ''));
    console.log('');
  }

  if (exportedBatches > 0) {
    console.error(
      `warning: the stub exporter received ${exportedBatches} batch(es) during ` +
        'measurement; export I/O may be inside the numbers.',
    );
  }
  if (!pass && !opts.ci) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
