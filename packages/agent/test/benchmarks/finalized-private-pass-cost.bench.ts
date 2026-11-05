/**
 * GH#3134 — what one finalized-private placement pass costs while every marker is parked on a
 * full author catalog. An offline measurement over the real repair store (SQLite), supervisor,
 * owner and capacity parking, with synthetic valid markers, mostly V1 with a few V2 (3,406 to 128),
 * all in one graph and one author scope:
 *
 *   pnpm --filter @origintrail-official/dkg-agent run benchmark:private-placement-pass
 *
 * For each backlog size in PRIVATE_PLACEMENT_PASS_BENCH_SIZES (default 3534,10602) it fills a store
 * and opens it again, as a restart does, so nothing is decoded yet. It then measures the first pass
 * of a started supervisor, which decodes every marker and parks them all on the one attempt the
 * full catalog refuses. Then, PRIVATE_PLACEMENT_PASS_BENCH_PASSES times (default 10),
 * a pass that a start asks for and one that a placement request for a parked marker asks for, with
 * every marker parked:
 *
 * - `timerMs`: how late a timer set just before the pass was requested fires;
 * - `passMs`: the duration the supervisor reports for the pass (`lastPassDurationMs`);
 * - `wallMs`: from the request to the supervisor being idle;
 * - `cpuMs`: the process CPU time (user and system) over that span;
 * - `maxBlockMs`: the longest the event loop was held, between two 1 ms timers, meanwhile.
 *
 * `retainedHeapMb` is the JS heap after a full collection with every marker parked: compare it
 * between builds, since it also holds the test runner's own.
 *
 * The authority reader is synthetic and cheap, so on a node a read per marker costs more than here.
 * PRIVATE_PLACEMENT_PASS_BENCH_OUT names a JSON file for the samples.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  createOperationContext,
  type AssertionCoordinateV1,
  type CanonicalDeterministicUalV1,
  type ContextGraphIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type NetworkIdV1,
  type PositiveDecimalU64V1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';

import { Rfc64SwmCatalogProjectionOwnerV1 } from '../../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import { AuthorCatalogFullErrorV1 } from '../../src/internal/author-catalog-capacity.js';
import {
  createRfc64FinalizedPrivatePlacementRepairStoreV1,
  type Rfc64FinalizedPrivatePlacementRepairStoreV1,
  type Rfc64FinalizedPrivatePlacementRepairV1,
} from '../../src/rfc64/finalized-private-placement-repair-store-v1.js';
import { openInventoryV1 } from '../../src/rfc64/inventory-v1/index.js';
import { pinnedPrivatePlacementAuthorityV1 } from '../support/finalized-placement-decision-fixture.js';
import { AUTHOR, authorSealV1 } from '../support/rfc64-local-catalog-repair-fixture.js';

const SIZES = (process.env.PRIVATE_PLACEMENT_PASS_BENCH_SIZES ?? '3534,10602')
  .split(',').map(Number).filter((size) => Number.isSafeInteger(size) && size > 0);
const PASSES = Number(process.env.PRIVATE_PLACEMENT_PASS_BENCH_PASSES ?? 10);
const OUT = process.env.PRIVATE_PLACEMENT_PASS_BENCH_OUT;
const GRAPH = 'parked-private-backlog' as ContextGraphIdV1;
const ctx = createOperationContext('system');

type Marker = Rfc64FinalizedPrivatePlacementRepairV1;

const SCOPE = Object.freeze({
  networkId: 'otp:20430' as NetworkIdV1, contextGraphId: GRAPH, governanceChainId: null,
  governanceContractAddress: null, ownershipTransitionDigest: null, authorAddress: AUTHOR,
  subGraphName: null, era: '1' as DecimalU64V1,
});

function v1Marker(kaNumber: number): Marker {
  return {
    version: 1, contextGraphId: GRAPH, authorAddress: AUTHOR, inventoryScope: SCOPE,
    assertionCoordinate: `asset-${kaNumber}` as AssertionCoordinateV1,
    assertionVersion: '1' as PositiveDecimalU64V1,
    kaUal: `did:dkg:otp:20430/${AUTHOR}/${kaNumber}` as CanonicalDeterministicUalV1,
    sealDigest: `0x${kaNumber.toString(16).padStart(64, '0')}` as Digest32V1,
  };
}

async function v2Marker(kaNumber: number): Promise<Marker> {
  const seal = await authorSealV1(BigInt(kaNumber));
  return {
    version: 2, contextGraphId: GRAPH, authorAddress: seal.authorAddress, inventoryScope: null,
    subGraphName: null, assertionCoordinate: `asset-${kaNumber}` as AssertionCoordinateV1,
    assertionVersion: seal.assertionVersion, kaUal: seal.kaUal,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal), seal,
  };
}

/** The catalog the markers wait for: full, and holding none of their assets. */
const HELD = Array.from({ length: MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 }, (_value, index) => ({
  seal: { kaUal: `did:dkg:otp:20430/${AUTHOR}/${9_000_000 + index}` },
}));

interface Calls { attempts: number; heads: number; failureReads: number; failureWrites: number; authority: number }

function supervisor(store: Rfc64FinalizedPrivatePlacementRepairStoreV1, calls: Calls) {
  const authority = pinnedPrivatePlacementAuthorityV1(v1Marker(1));
  return new Rfc64SwmCatalogProjectionOwnerV1({
    resolvePartition: () => ({ retryIntervalMs: 0, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }) as never,
    listDurableInventoryScopes: () => [],
    listLocalAuthorAddresses: () => [],
    acceptsPublicRootLane: () => true,
    readFinalizedPlacementAuthority: () => {
      calls.authority += 1;
      return authority.status === 'active' ? { status: 'active', lane: { ...authority.lane } } : authority;
    },
    readRepairRevision: () => null,
    listFinalizedPrivateRepairs: () => store.list(),
    listFinalizedPrivateRepairsAsync: (signal) => store.listAsync(signal),
    readPrivateFailure: (repair) => { calls.failureReads += 1; return store.readFailure(repair); },
    writePrivateFailures: (entries) => { calls.failureWrites += 1; store.writeFailures(entries); },
    repairFinalizedPrivatePlacement: async () => {
      calls.attempts += 1;
      throw new AuthorCatalogFullErrorV1(HELD, 1);
    },
    reconcile: async () => null,
    readAppliedCatalogHead: () => {
      calls.heads += 1;
      return { inventoryRowCount: String(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) };
    },
    warn: () => {},
  });
}

interface PassSample { timerMs: number; passMs: number | null; wallMs: number; cpuMs: number; maxBlockMs: number; calls: Calls }

/** One pass asked for by `trigger`, which a start or a placement request is. */
async function measurePass(owner: Rfc64SwmCatalogProjectionOwnerV1, calls: Calls, trigger: () => void): Promise<PassSample> {
  const before = { ...calls };
  // A timer every millisecond from before the request until after the pass: the longest gap
  // between two of them is the longest the event loop was held.
  let ticking = true;
  let lastTickAt = performance.now();
  let maxBlockMs = 0;
  const tick = (): void => {
    const now = performance.now();
    maxBlockMs = Math.max(maxBlockMs, now - lastTickAt);
    lastTickAt = now;
    if (ticking) setTimeout(tick, 1);
  };
  setTimeout(tick, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const requestedAt = performance.now();
  let timerMs = Number.NaN;
  const timer = new Promise<void>((resolve) => setTimeout(() => {
    timerMs = performance.now() - requestedAt;
    resolve();
  }, 0));
  const cpuBefore = process.cpuUsage();
  trigger();
  await owner.whenIdle();
  const wallMs = performance.now() - requestedAt;
  const cpu = process.cpuUsage(cpuBefore);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  await timer;
  await new Promise((resolve) => setTimeout(resolve, 5));
  ticking = false;
  const passMs = owner.status()?.finalizedPrivatePlacement.lastPassDurationMs ?? null;
  const delta = Object.fromEntries(Object.entries(calls)
    .map(([name, count]) => [name, count - before[name as keyof Calls]])) as unknown as Calls;
  return { timerMs, passMs, wallMs, cpuMs, maxBlockMs, calls: delta };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

const results: Record<string, unknown>[] = [];

describe('finalized-private placement pass over a parked backlog', () => {
  for (const size of SIZES) {
    it(`measures passes over ${size} parked markers`, async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'private-placement-pass-bench-'));
      let inventory = await openInventoryV1(dataDir);
      let owner: Rfc64SwmCatalogProjectionOwnerV1 | undefined;
      try {
        const filling = createRfc64FinalizedPrivatePlacementRepairStoreV1(inventory);
        const v2 = Math.round((size * 128) / 3534);
        const fillStartedAt = performance.now();
        for (let index = 0; index < size - v2; index += 1) await filling.put(v1Marker(index + 1));
        for (let index = 0; index < v2; index += 1) await filling.put(await v2Marker(1_000_000 + index));
        const fillMs = performance.now() - fillStartedAt;
        // A listing here would decode every marker before the first pass is measured.
        inventory.close();
        inventory = await openInventoryV1(dataDir);
        const store = createRfc64FinalizedPrivatePlacementRepairStoreV1(inventory);

        const calls: Calls = { attempts: 0, heads: 0, failureReads: 0, failureWrites: 0, authority: 0 };
        owner = supervisor(store, calls);
        const started = owner;
        const start = () => { started.start(ctx); };
        const first = await measurePass(owner, calls, start);
        expect(first.calls.attempts).toBe(1);
        expect(owner.status()?.authorCatalogCapacity).toEqual({ parkedPlacements: size, scopesAtCap: 1 });
        const requested = store.list()[0]!;
        const request = () => { started.requestFinalizedPrivate({ repair: requested, ctx }); };
        const series = { start: [] as PassSample[], request: [] as PassSample[] };
        for (let pass = 0; pass < PASSES; pass += 1) {
          series.start.push(await measurePass(owner, calls, start));
          series.request.push(await measurePass(owner, calls, request));
        }
        for (const sample of [...series.start, ...series.request]) expect(sample.calls.attempts).toBe(0);
        (globalThis as { gc?: () => void }).gc?.();
        const retainedHeapMb = process.memoryUsage().heapUsed / 1e6;
        const summarize = (samples: readonly PassSample[]) => ({
          timerMs: median(samples.map((sample) => sample.timerMs)),
          passMs: median(samples.map((sample) => sample.passMs ?? Number.NaN)),
          wallMs: median(samples.map((sample) => sample.wallMs)),
          cpuMs: median(samples.map((sample) => sample.cpuMs)),
          maxBlockMs: Math.max(...samples.map((sample) => sample.maxBlockMs)),
          timerRangeMs: [Math.min(...samples.map((s) => s.timerMs)), Math.max(...samples.map((s) => s.timerMs))],
          calls: samples[samples.length - 1]?.calls,
        });
        const summary = {
          size, v1: size - v2, v2, fillMs: Math.round(fillMs), retainedHeapMb, first,
          parkedByStart: summarize(series.start), parkedByRequest: summarize(series.request), samples: series,
        };
        results.push(summary);
        console.log(JSON.stringify({ size, v2, retainedHeapMb, first: { ...first }, parkedByStart: summary.parkedByStart,
          parkedByRequest: summary.parkedByRequest }));
      } finally {
        await owner?.close();
        inventory.close();
        rmSync(dataDir, { recursive: true, force: true });
        if (OUT !== undefined) writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
      }
    });
  }
});
