/**
 * GH#3081 / GH#3072 — what one finalized-private catalog placement costs as the author catalog
 * grows. An offline measurement through the real observer, supervisor, upsert and successor
 * producer of one agent: every placement reports its phases (the placement timing of GH#3081),
 * its process CPU time and the longest stall of the main thread.
 *
 *   pnpm --filter @origintrail-official/dkg-agent run benchmark:catalog-placement
 *
 * Two modes, chosen by CATALOG_PLACEMENT_BENCH_MODE:
 *
 * - `grow` (default) grows one catalog from nothing, one confirmed asset at a time as a node grows
 *   it, to CATALOG_PLACEMENT_BENCH_ROWS rows (default 1024, the bucket row cap). With
 *   CATALOG_PLACEMENT_BENCH_SNAPSHOT_DIR it also saves the agent's data directory shortly before
 *   each size in CATALOG_PLACEMENT_BENCH_SIZES (default 10,100,700,1024).
 * - `measure` starts an agent on a copy of each saved snapshot and places
 *   CATALOG_PLACEMENT_BENCH_WINDOW (default 5) assets after a first one. The first placement after
 *   a start finds nothing in memory and is reported on its own. As many passes of the share-time
 *   projection then run over the same catalog: every row of the author's inventory is in it, so
 *   each pass signs nothing. Two runs measured on the same snapshots place the same assets into
 *   the same catalog; the applied inventory digest each run prints says whether they signed the
 *   same rows, and the bytes still held after a full collection say what each run keeps in memory
 *   for a catalog of that size (measure one size per process for that, with
 *   CATALOG_PLACEMENT_BENCH_SIZES: an agent that was stopped is not collected while the run goes
 *   on).
 *
 * CATALOG_PLACEMENT_BENCH_OUT names a JSON file for the samples.
 *
 * Before and after, from one checkout. `DKG_RFC64_CATALOG_MUTATION_MEMORY=0` makes every placement
 * read and verify the durable catalog, as every placement did before the memory existed:
 *
 *   # the catalogs, once (about 35 minutes for 1,024 rows)
 *   CATALOG_PLACEMENT_BENCH_SNAPSHOT_DIR=$SNAP pnpm run benchmark:catalog-placement
 *   # before, then after; repeat both, alternating, for more samples
 *   DKG_RFC64_CATALOG_MUTATION_MEMORY=0 CATALOG_PLACEMENT_BENCH_MODE=measure \
 *     CATALOG_PLACEMENT_BENCH_SNAPSHOT_DIR=$SNAP CATALOG_PLACEMENT_BENCH_OUT=$OUT/before-1.json \
 *     pnpm run benchmark:catalog-placement
 *   CATALOG_PLACEMENT_BENCH_MODE=measure \
 *     CATALOG_PLACEMENT_BENCH_SNAPSHOT_DIR=$SNAP CATALOG_PLACEMENT_BENCH_OUT=$OUT/after-1.json \
 *     pnpm run benchmark:catalog-placement
 *   # medians per catalog size over all runs of each label
 *   node test/benchmarks/catalog-placement-cost.compare.mjs \
 *     before=$OUT/before-1.json after=$OUT/after-1.json
 */
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 } from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../../src/index.js';
import {
  CatalogPlacementTimingV1,
  installCatalogPlacementTimingV1,
} from '../../src/internal/catalog-placement-timing.js';
import {
  appliedPlacementHeadV1 as appliedHead,
  observeConfirmationV1,
  startPlacementAgentV1,
} from '../support/rfc64-catalog-placement-fixture.js';
import {
  AUTHOR,
  CONTEXT_GRAPH_ID,
  agents,
  seedInventoryAssetV1,
} from '../support/rfc64-local-catalog-repair-fixture.js';

const MODE = process.env.CATALOG_PLACEMENT_BENCH_MODE ?? 'grow';
const ROWS = Number(process.env.CATALOG_PLACEMENT_BENCH_ROWS ?? MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1);
const SIZES = (process.env.CATALOG_PLACEMENT_BENCH_SIZES ?? '10,100,700,1024')
  .split(',').map(Number).filter((size) => size <= ROWS);
const WINDOW = Number(process.env.CATALOG_PLACEMENT_BENCH_WINDOW ?? 5);
const SNAPSHOT_DIR = process.env.CATALOG_PLACEMENT_BENCH_SNAPSHOT_DIR;
const OUT = process.env.CATALOG_PLACEMENT_BENCH_OUT;
const PHASES = ['coverageMs', 'assetMs', 'stateMs', 'successorMs', 'casMs', 'announceMs', 'otherMs'] as const;

interface PlacementSampleV1 {
  /** Rows in the catalog before this placement. */
  readonly rows: number;
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly stallMs: number;
  readonly phases: Readonly<Record<string, number>>;
}

/** Rows a snapshot for `size` holds: one placement warms the agent, WINDOW more are measured. */
function snapshotRows(size: number): number {
  return size - WINDOW - 1;
}

/** A copy that keeps every mode: the catalog's durable stores refuse a directory others can read. */
function copyTree(source: string, target: string): void {
  const { mode } = statSync(source);
  mkdirSync(target, { recursive: true });
  chmodSync(target, mode);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, statSync(from).mode);
    }
  }
}

function snapshotPath(size: number): string {
  if (SNAPSHOT_DIR === undefined) throw new Error('CATALOG_PLACEMENT_BENCH_SNAPSHOT_DIR is not set');
  return join(SNAPSHOT_DIR, `rows-${size}`);
}

async function startPlacementAgent(dataDir: string): Promise<Readonly<{
  agent: DKGAgent;
  lines: string[];
}>> {
  const agent = await startPlacementAgentV1('placement-cost', {
    dataDir,
    storePath: join(dataDir, 'oxigraph'),
  });
  installCatalogPlacementTimingV1(agent, new CatalogPlacementTimingV1({ logThresholdMs: 0 }));
  const lines: string[] = [];
  const log = (agent as any).log;
  const info = log.info.bind(log);
  log.info = (ctx: unknown, message: unknown, ...rest: unknown[]) => {
    const text = String(message);
    if (text.startsWith('rfc64_catalog_placement_wait ')) {
      lines.push(text);
      return undefined;
    }
    return info(ctx, message, ...rest);
  };
  return { agent, lines };
}

async function stopPlacementAgent(agent: DKGAgent): Promise<void> {
  await agent.stop();
  agents.splice(agents.indexOf(agent), 1);
}

function phasesOf(line: string): Record<string, number> {
  const phases: Record<string, number> = {};
  for (const pair of line.split(' ').slice(1)) {
    const separator = pair.indexOf('=');
    const key = pair.slice(0, separator);
    if (key.endsWith('Ms')) phases[key] = Number(pair.slice(separator + 1));
  }
  return phases;
}

async function measured(
  rows: number,
  lines: readonly string[],
  stall: ReturnType<typeof monitorEventLoopDelay>,
  work: () => Promise<void>,
): Promise<PlacementSampleV1> {
  const before = lines.length;
  stall.reset();
  const cpu = process.cpuUsage();
  const startedAt = performance.now();
  await work();
  const wallMs = performance.now() - startedAt;
  const used = process.cpuUsage(cpu);
  const line = lines[before];
  if (line === undefined) throw new Error('the placement wrote no timing line');
  return {
    rows,
    wallMs,
    cpuMs: (used.user + used.system) / 1_000,
    stallMs: stall.max / 1e6,
    phases: phasesOf(line),
  };
}

/** Place asset number `rows + 1` and observe its confirmation a second time, as recovery does. */
async function placeNext(
  agent: DKGAgent,
  lines: readonly string[],
  stall: ReturnType<typeof monitorEventLoopDelay>,
  rows: number,
): Promise<Readonly<{ first: PlacementSampleV1; covered: PlacementSampleV1 }>> {
  const suffix = `bench-${rows}`;
  const { seal } = await seedInventoryAssetV1(agent, suffix, BigInt(rows + 1));
  await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
  const first = await measured(rows, lines, stall, () => observeConfirmationV1(agent, suffix, seal));
  const covered = await measured(rows + 1, lines, stall, () => observeConfirmationV1(agent, suffix, seal));
  return { first, covered };
}

/**
 * Passes of the share-time projection over the catalog as it is: every row of the author's
 * inventory is placed, so each pass resolves the rows, finds nothing to sign and ends there.
 * `catalogMs` is the part spent in the catalog mutation. The fixture's stand-in for that
 * projection is taken out first, so nothing is placed through the agent after this.
 */
async function projectNothing(
  agent: DKGAgent,
  stall: ReturnType<typeof monitorEventLoopDelay>,
  rows: number,
): Promise<PlacementSampleV1[]> {
  vi.mocked(agent.reconcileRfc64PublicCatalogFromSwmInventoryV1).mockRestore();
  let catalogMs = 0;
  const reconcile = (agent as any).reconcileRfc64SwmInventoryCatalogV1.bind(agent);
  (agent as any).reconcileRfc64SwmInventoryCatalogV1 = async (params: unknown) => {
    const startedAt = performance.now();
    try {
      return await reconcile(params);
    } finally {
      catalogMs = performance.now() - startedAt;
    }
  };
  const samples: PlacementSampleV1[] = [];
  for (let pass = 0; pass < WINDOW; pass += 1) {
    stall.reset();
    const cpu = process.cpuUsage();
    const startedAt = performance.now();
    const result = await agent.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    });
    const wallMs = performance.now() - startedAt;
    const used = process.cpuUsage(cpu);
    expect(result).toMatchObject({ status: 'existing', successorsApplied: 0 });
    samples.push({
      rows,
      wallMs,
      cpuMs: (used.user + used.system) / 1_000,
      stallMs: stall.max / 1e6,
      phases: { catalogMs },
    });
  }
  return samples;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function summarize(samples: readonly PlacementSampleV1[], rows: number) {
  return {
    rows,
    placements: samples.length,
    wallMs: mean(samples.map(({ wallMs }) => wallMs)),
    cpuMs: mean(samples.map(({ cpuMs }) => cpuMs)),
    stallMaxMs: Math.max(0, ...samples.map(({ stallMs }) => stallMs)),
    ...Object.fromEntries(PHASES.map((phase) => [
      phase,
      mean(samples.map(({ phases }) => phases[phase] ?? 0)),
    ])) as Record<typeof PHASES[number], number>,
  };
}

function table(title: string, rows: readonly ReturnType<typeof summarize>[]): string {
  const columns = ['rows', 'placements', 'wallMs', 'cpuMs', 'stallMaxMs', ...PHASES] as const;
  const cell = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));
  return [
    title,
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---:').join(' | ')} |`,
    ...rows.map((row) => `| ${columns.map((column) => cell(row[column])).join(' | ')} |`),
  ].join('\n');
}

/** Heap and buffer bytes still held after a full collection, or undefined without `--expose-gc`. */
function retainedBytes(): number | undefined {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (collect === undefined) return undefined;
  collect();
  collect();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}

/** Grow one author catalog from nothing to ROWS rows, measuring every placement. */
async function growCatalog(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dkg-catalog-placement-bench-'));
  let { agent, lines } = await startPlacementAgent(dataDir);
  const stall = monitorEventLoopDelay({ resolution: 1 });
  stall.enable();
  const first: PlacementSampleV1[] = [];
  const covered: PlacementSampleV1[] = [];
  const startedAt = performance.now();
  for (let rows = 0; rows < ROWS; rows += 1) {
    const size = SNAPSHOT_DIR === undefined
      ? undefined
      : SIZES.find((candidate) => snapshotRows(candidate) === rows);
    if (size !== undefined) {
      await stopPlacementAgent(agent);
      mkdirSync(SNAPSHOT_DIR!, { recursive: true });
      rmSync(snapshotPath(size), { recursive: true, force: true });
      copyTree(dataDir, snapshotPath(size));
      ({ agent, lines } = await startPlacementAgent(dataDir));
    }
    const sample = await placeNext(agent, lines, stall, rows);
    first.push(sample.first);
    covered.push(sample.covered);
    if ((rows + 1) % 50 === 0) {
      process.stderr.write(
        `rows=${rows + 1} elapsed=${((performance.now() - startedAt) / 1000).toFixed(0)}s`
        + ` placementWallMs=${sample.first.wallMs.toFixed(0)} cpuMs=${sample.first.cpuMs.toFixed(0)}`
        + ` coveredWallMs=${sample.covered.wallMs.toFixed(1)}\n`,
      );
    }
  }
  stall.disable();
  expect(appliedHead(agent)).toMatchObject({ inventoryRowCount: String(ROWS) });
  await stopPlacementAgent(agent);
  rmSync(dataDir, { recursive: true, force: true });

  const window = (samples: readonly PlacementSampleV1[], size: number) => (
    samples.filter(({ rows }) => rows < size && rows >= size - WINDOW)
  );
  const placements = SIZES.map((size) => summarize(window(first, size), size));
  const repeats = SIZES.map((size) => summarize(window(covered, size + 1), size));
  process.stderr.write(`\n${[
    table('One placement into a catalog of up to `rows` rows', placements),
    '',
    table('The same confirmation observed again (already covered)', repeats),
  ].join('\n')}\n`);
  if (OUT !== undefined) writeFileSync(OUT, JSON.stringify({ mode: MODE, first, covered }, null, 1));
}

/** Place assets into a copy of each saved catalog. */
async function measureSavedCatalogs(): Promise<void> {
  const stall = monitorEventLoopDelay({ resolution: 1 });
  stall.enable();
  const results = [];
  for (const size of SIZES) {
    const dataDir = mkdtempSync(join(tmpdir(), 'dkg-catalog-placement-bench-'));
    copyTree(snapshotPath(size), dataDir);
    const { agent, lines } = await startPlacementAgent(dataDir);
    let rows = snapshotRows(size);
    expect(appliedHead(agent)).toMatchObject({ inventoryRowCount: String(rows) });
    const afterStart = await placeNext(agent, lines, stall, rows);
    const first: PlacementSampleV1[] = [];
    const covered: PlacementSampleV1[] = [];
    for (rows += 1; rows < size; rows += 1) {
      const sample = await placeNext(agent, lines, stall, rows);
      first.push(sample.first);
      covered.push(sample.covered);
    }
    const applied = appliedHead(agent);
    expect(applied).toMatchObject({ inventoryRowCount: String(size) });
    const retained = retainedBytes();
    const projection = await projectNothing(agent, stall, size);
    expect(appliedHead(agent)).toEqual(applied);
    results.push({
      size,
      retainedBytes: retained,
      appliedInventoryDigest: applied!.appliedInventoryDigest,
      afterStart: summarize([afterStart.first], size),
      placement: summarize(first, size),
      repeat: summarize(covered, size),
      projection: {
        rows: size,
        passes: projection.length,
        wallMs: mean(projection.map(({ wallMs }) => wallMs)),
        cpuMs: mean(projection.map(({ cpuMs }) => cpuMs)),
        stallMaxMs: Math.max(0, ...projection.map(({ stallMs }) => stallMs)),
        catalogMs: mean(projection.map(({ phases }) => phases.catalogMs ?? 0)),
      },
      samples: { afterStart, first, covered, projection },
    });
    await stopPlacementAgent(agent);
    rmSync(dataDir, { recursive: true, force: true });
  }
  stall.disable();
  process.stderr.write(`\n${[
    table('First placement after a start, into a catalog of just under `rows` rows',
      results.map(({ afterStart }) => afterStart)),
    '',
    table('One placement into a catalog of up to `rows` rows', results.map(({ placement }) => placement)),
    '',
    table('The same confirmation observed again (already covered)', results.map(({ repeat }) => repeat)),
    '',
    'A projection pass over the same catalog that finds nothing to sign',
    '| rows | passes | wallMs | cpuMs | stallMaxMs | catalogMs |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    ...results.map(({ projection }) => (
      `| ${projection.rows} | ${projection.passes} | ${projection.wallMs.toFixed(1)} | ${projection.cpuMs.toFixed(1)}`
      + ` | ${projection.stallMaxMs.toFixed(1)} | ${projection.catalogMs.toFixed(1)} |`
    )),
    '',
    ...results.map(({ size, appliedInventoryDigest, retainedBytes: retained }) => (
      `rows=${size} appliedInventoryDigest=${appliedInventoryDigest}`
      + ` retainedAfterGcMiB=${retained === undefined ? '-' : (retained / 1_048_576).toFixed(1)}`
    )),
  ].join('\n')}\n`);
  if (OUT !== undefined) writeFileSync(OUT, JSON.stringify({ mode: MODE, results }, null, 1));
}

describe('catalog placement cost', () => {
  it(MODE === 'measure' ? 'places assets into saved catalogs' : `grows one author catalog to ${ROWS} rows`, async () => {
    if (MODE === 'measure') await measureSavedCatalogs();
    else await growCatalog();
  });
});
