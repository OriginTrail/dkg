/**
 * What a durable share writes to disk on the default embedded store, what a restarted node makes of it,
 * and what a share costs on a store of a given size.
 *
 * The embedded store persists whole snapshots of its state: a flush rewrites the whole file, and a crash
 * leaves the state as it was after some earlier write. These tests run `durableSynchronousShare` (the
 * `POST /api/knowledge-assets/:name/swm/share` path) on persisted stores. They pin which queue writes wait
 * for disk, restart from the state after every store write of one share, and time shares on a worker store.
 *
 * The timing test uses a small store by default. To time shares at a realistic size:
 *   DKG_SHARE_SNAPSHOT_BENCH_QUADS=310000 DKG_SHARE_SNAPSHOT_BENCH_SHARES=8 [DKG_SHARE_SNAPSHOT_BENCH_OUT=<file>] \
 *     pnpm --filter @origintrail-official/dkg exec vitest run --config vitest.unit.config.ts \
 *     test/durable-share-snapshot-writes.test.ts -t 'times'
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, statSync } from 'node:fs';
import { appendFile, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Wallet } from 'ethers';
import { afterAll, describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-agent', () => import('../../agent/src/index.js'));
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { OxigraphStore, OxigraphWorkerStore, type TripleStore } from '@origintrail-official/dkg-storage';
import type { PromoteJob } from '@origintrail-official/dkg-publisher';
import { createPromotionAgentForTest } from '../../agent/test/_helpers/promotion-agent.js';
import { makeTestKaNumberAllocator } from '../../agent/test/_helpers/ka-allocator.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { durableSynchronousShare } from '../src/daemon/routes/durable-synchronous-share.js';
import { executePromoteRequest } from '../src/daemon/worker/execute-promote-request.js';
import { daemonState } from '../src/daemon/state.js';
import { createPromoteWorkerSupervisor, runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';

const signer = new Wallet(`0x${'33'.repeat(32)}`);
const CG = 'durable-share-snapshot-writes', NAME = 'asset', AUTHOR = signer.address.toLowerCase();
const LEASE_MS = 60_000;
/** No background snapshot: the file changes only when a caller flushes, or when a test takes an image. */
const NO_BACKGROUND_SNAPSHOT = { flushDelayMs: 24 * 60 * 60_000 };
const STORE_WRITES = ['insert', 'delete', 'deleteByPattern', 'deleteByPatternWithoutCount', 'createGraph', 'dropGraph',
  'replaceGraph', 'replaceAssetGroup', 'replaceGraphAndSubject', 'replaceSubject', 'replaceSubjectAndInsert',
  'rfc64AuthorCommitCasV1', 'rfc64AuthorCommitCasNormalizedV1', 'deleteBySubjectPrefix', 'update'] as const;
const QUEUE_STEPS = ['enqueue', 'enqueueAndClaim', 'claimNext', 'bindRecovery', 'recordCommitMarker', 'heartbeat', 'succeed', 'fail'] as const;
const BENCH_QUADS = Number(process.env.DKG_SHARE_SNAPSHOT_BENCH_QUADS ?? 2_000);
const BENCH_SHARES = Number(process.env.DKG_SHARE_SNAPSHOT_BENCH_SHARES ?? 2);
const BENCH_OUT = process.env.DKG_SHARE_SNAPSHOT_BENCH_OUT;

const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A node process over `store`: fresh agent, publisher and queue objects. */
async function nodeProcess(store: TripleStore, now: () => number = Date.now) {
  const { agent, publisher } = await createPromotionAgentForTest(store,
    { agentAddress: AUTHOR, peerId: '12D3KooWSnapshotWrites', kaAllocator: makeTestKaNumberAllocator() });
  agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'legacy', killSwitchActive: false });
  agent.createRfc64CatalogAuthorSignerV1 = () => ({ address: AUTHOR, signMessage: signer.signMessage.bind(signer) });
  agent.configurePromoteQueue({ backoff: () => 0, leaseMs: LEASE_MS, now });
  return { agent, publisher };
}

/** Label every store call made inside a queue step with that step. */
function labelQueueSteps(queue: object, step: AsyncLocalStorage<string>): void {
  const methods = queue as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of QUEUE_STEPS) {
    const original = methods[method]?.bind(queue);
    if (!original) continue;
    methods[method] = (...args: unknown[]) => step.run(method === 'recordCommitMarker' ? `${method}(${String(args[2])})` : method, () => original(...args));
  }
}

/** Every explicit flush, by the queue step that asked for it, with how long it took. */
function recordFlushes(store: TripleStore, step: AsyncLocalStorage<string>): { step: string; ms: number }[] {
  const flushes: { step: string; ms: number }[] = [];
  const flush = store.flush!.bind(store);
  store.flush = async () => {
    const started = performance.now();
    try { await flush(); } finally { flushes.push({ step: step.getStore() ?? 'outside the queue', ms: performance.now() - started }); }
  };
  return flushes;
}

/** A finalized asset in Working Memory, written to disk. */
async function finalizedAsset(store: TripleStore, publisher: Awaited<ReturnType<typeof nodeProcess>>['publisher'], name = NAME,
  quads = [{ subject: 'urn:asset', predicate: 'https://schema.org/name', object: '"original"' }]) {
  await publisher.assertionCreate(CG, name, AUTHOR);
  await publisher.assertionWrite(CG, name, AUTHOR, quads);
  const finalized = await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name, agentAddress: AUTHOR });
  await store.flush!();
  return finalized;
}

async function graphContent(store: TripleStore, graph: string) {
  return store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
}

async function share(agent: Awaited<ReturnType<typeof nodeProcess>>['agent'], name = NAME) {
  daemonState.promoteWorkerAvailable = true;
  try { return await durableSynchronousShare(agent, CG, name, { agentAddress: AUTHOR }); }
  finally { daemonState.promoteWorkerAvailable = false; }
}

/** Restart on `image` once the old process's lease has run out, and let the queue finish what it holds. */
async function restartOn(image: string) {
  const store = new OxigraphStore(image, NO_BACKGROUND_SNAPSHOT);
  const now = () => Date.now() + LEASE_MS + 1_000;
  const { agent } = await nodeProcess(store, now);
  const found: PromoteJob[] = await agent.promoteQueue.list();
  await agent.promoteQueue.recoverOnStartup();
  const worker = createPromoteWorkerSupervisor({ agent, workerConcurrency: 1, pollIntervalMs: 10, heartbeatIntervalMs: 0,
    bookkeepingRetryBudgetMs: 0, now, log: () => undefined });
  await worker.start();
  try {
    await vi.waitFor(async () => {
      const jobs: PromoteJob[] = await agent.promoteQueue.list();
      expect(jobs.every(job => job.state === 'succeeded' || job.state === 'failed')).toBe(true);
    }, { timeout: 20_000, interval: 20 });
  } finally { await worker.stop(); }
  return { store, agent, found };
}

/** Unrelated graphs of the shape a node accumulates: four memory layers over many context graphs. */
function syntheticStore(quads: number, graphs = 300): string {
  const lines: string[] = [];
  for (let i = 0; i < quads; i++) {
    const g = i % graphs;
    const cg = `did:dkg:context-graph:bench-cg-${String(g).padStart(4, '0')}`;
    const layer = ['_shared_memory', '_verifiable_memory', '_meta', '_working_memory'][g % 4];
    const subject = `${cg}/${layer}/0x5e1f0000000000000000000000000000000000${String(g % 97).padStart(2, '0')}/asset-${Math.floor(i / 7)}`;
    const predicate = ['https://schema.org/name', 'https://schema.org/description', 'http://dkg.io/ontology/memoryLayer', 'https://schema.org/dateCreated'][i % 4];
    const object = i % 3 === 0 ? `<urn:dkg:bench:object:${i}>` : `"Synthetic literal ${i} ${'x'.repeat(60 + (i % 90))}"`;
    lines.push(`<${subject}> <${predicate}> ${object} <${cg}/${layer}> .`);
  }
  return `${lines.join('\n')}\n`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

describe('durable share on a persisted embedded store', () => {
  it('waits for disk when the share is admitted and when it succeeds, and at no step between', async () => {
    const dir = await tempDir('dkg-share-flushes-');
    const path = join(dir, 'store.nq');
    const store = new OxigraphStore(path, NO_BACKGROUND_SNAPSHOT);
    const { agent, publisher } = await nodeProcess(store);
    const finalized = await finalizedAsset(store, publisher);
    const step = new AsyncLocalStorage<string>();
    labelQueueSteps(agent.promoteQueue, step);
    const flushes = recordFlushes(store, step);
    await expect(share(agent)).resolves.toMatchObject({ promotedCount: 1, publishReady: true });
    expect(flushes.map(flush => flush.step)).toEqual(['enqueueAndClaim', 'succeed']);
    // The flushed success carries the share and its markers with it: a restart from the file finds them all.
    const content = await graphContent(store, finalized.sharedGraphUri);
    const reopened = new OxigraphStore(path, NO_BACKGROUND_SNAPSHOT);
    const { agent: restarted } = await nodeProcess(reopened);
    expect(await restarted.promoteQueue.list()).toMatchObject([{ state: 'succeeded', commitMarker: { promoteStarted: true, swmInserted: true } }]);
    expect(await graphContent(reopened, finalized.sharedGraphUri)).toEqual(content);
    expect(await reopened.countQuads(finalized.graphUri)).toBe(0);
    await reopened.close();
    await store.close();
  });

  it('waits for disk on the admission, claim, binding and success of a queued share, and not on its markers', async () => {
    const dir = await tempDir('dkg-share-flushes-queued-');
    const store = new OxigraphStore(join(dir, 'store.nq'), NO_BACKGROUND_SNAPSHOT);
    const { agent, publisher } = await nodeProcess(store);
    const finalized = await finalizedAsset(store, publisher);
    const step = new AsyncLocalStorage<string>();
    labelQueueSteps(agent.promoteQueue, step);
    const flushes = recordFlushes(store, step);
    const id = await agent.promoteQueue.enqueue({ contextGraphId: CG, assertionName: NAME, agentAddress: AUTHOR, entities: 'all' });
    const worker = createPromoteWorkerSupervisor({ agent, workerConcurrency: 1, pollIntervalMs: 10, heartbeatIntervalMs: 0,
      bookkeepingRetryBudgetMs: 0, log: () => undefined });
    await worker.start();
    try {
      await vi.waitFor(async () => expect((await agent.promoteQueue.getStatus(id))?.state).toBe('succeeded'), { timeout: 20_000, interval: 20 });
    } finally { await worker.stop(); }
    // The worker bound the queued job before its promote, so its markers ride on the flushed success.
    expect((await agent.promoteQueue.getStatus(id))?.request.recoveryBinding).toBeDefined();
    expect(flushes.map(flush => flush.step)).toEqual(['enqueue', 'claimNext', 'bindRecovery', 'succeed']);
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    await store.close();
  });

  it('still waits for disk on every commit marker of an unbound job', async () => {
    const dir = await tempDir('dkg-share-flushes-unbound-');
    const path = join(dir, 'store.nq');
    const store = new OxigraphStore(path, NO_BACKGROUND_SNAPSHOT);
    const { agent, publisher } = await nodeProcess(store);
    await finalizedAsset(store, publisher);
    const id = await agent.promoteQueue.enqueue({ contextGraphId: CG, assertionName: NAME, agentAddress: AUTHOR, entities: 'all' });
    const job = (await agent.promoteQueue.claimNext('unbound'))!;
    expect(job.request.recoveryBinding).toBeUndefined();
    const step = new AsyncLocalStorage<string>();
    labelQueueSteps(agent.promoteQueue, step);
    const flushes = recordFlushes(store, step);
    let onDiskAtPromote: PromoteJob | null = null;
    const outcome = await runPromoteJob({ job, queue: agent.promoteQueue, workerId: 'unbound', now: Date.now, heartbeatIntervalMs: 0, log: () => undefined,
      runPromote: async (request, executionAuthority) => {
        // What a crash right now leaves: recovery must see that the promote may have started.
        const image = join(dir, 'at-promote.nq');
        await copyFile(path, image);
        const crashed = new OxigraphStore(image, NO_BACKGROUND_SNAPSHOT);
        onDiskAtPromote = await (await nodeProcess(crashed)).agent.promoteQueue.getStatus(id);
        await crashed.close();
        return executePromoteRequest(agent, request, { executionAuthority });
      } });
    expect(outcome).toMatchObject({ outcome: 'succeeded' });
    expect(onDiskAtPromote).toMatchObject({ state: 'running', commitMarker: { promoteStarted: true, swmInserted: false } });
    expect(flushes.map(flush => flush.step)).toEqual(['recordCommitMarker(promoteStarted)', 'recordCommitMarker(swmInserted)', 'succeed']);
    await store.close();
  });

  it('finishes the share exactly once from what a crash after any of its store writes leaves on disk', async () => {
    const dir = await tempDir('dkg-share-crash-images-');
    const path = join(dir, 'store.nq');
    const store = new OxigraphStore(path, NO_BACKGROUND_SNAPSHOT);
    const { agent, publisher } = await nodeProcess(store);
    const finalized = await finalizedAsset(store, publisher);
    const step = new AsyncLocalStorage<string>();
    labelQueueSteps(agent.promoteQueue, step);
    // After each store write of the share, write the snapshot a background flush would write right then, and keep a copy.
    const images: { path: string; after: string; step: string; swmPresent: boolean }[] = [];
    let capturing = false, depth = 0;
    const writes = store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const method of STORE_WRITES) {
      const original = writes[method]?.bind(store);
      if (!original) continue;
      writes[method] = async (...args: unknown[]) => {
        depth++;
        try { return await original(...args); } finally {
          depth--;
          if (capturing && depth === 0) {
            await (store as unknown as { flushNow(): Promise<void> }).flushNow();
            const image = join(dir, `image-${String(images.length).padStart(3, '0')}.nq`);
            await copyFile(path, image);
            images.push({ path: image, after: method, step: step.getStore() ?? 'share work',
              swmPresent: (await store.countQuads(finalized.sharedGraphUri)) > 0 });
          }
        }
      };
    }
    capturing = true;
    try { await expect(share(agent)).resolves.toMatchObject({ promotedCount: 1, publishReady: true }); }
    finally { capturing = false; }
    const expected = await graphContent(store, finalized.sharedGraphUri);
    const [original] = await agent.promoteQueue.list();
    const operationId = original!.request.recoveryBinding!.intent.operationId;
    await store.close();

    // Every queue step of the share, and the share's own content writes, are among the crash points.
    const steps = images.map(image => image.step);
    for (const queueStep of ['enqueueAndClaim', 'recordCommitMarker(promoteStarted)', 'recordCommitMarker(swmInserted)', 'succeed']) {
      expect(steps).toContain(queueStep);
    }
    expect(images.some(image => image.swmPresent && image.step === 'share work')).toBe(true);

    for (const [index, image] of images.entries()) {
      const label = `crash after write ${index + 1} of ${images.length} (${image.after}, ${image.step})`;
      const { store: restarted, agent: node, found } = await restartOn(image.path);
      if (found.length === 0) {
        // Nothing was admitted yet: the asset is still in Working Memory and sharing it again works.
        expect(await restarted.countQuads(finalized.sharedGraphUri), label).toBe(0);
        await expect(share(node), label).resolves.toMatchObject({ publishReady: true });
      }
      const jobs = await node.promoteQueue.list();
      expect(jobs, label).toHaveLength(1);
      expect(jobs[0], label).toMatchObject({ state: 'succeeded' });
      if (found.length > 0) {
        // The restarted queue finished the admitted operation itself, not a new one.
        expect(jobs[0]!.jobId, label).toBe(original!.jobId);
        expect(jobs[0]!.request.recoveryBinding?.intent.operationId, label).toBe(operationId);
      }
      expect(await graphContent(restarted, finalized.sharedGraphUri), label).toEqual(expected);
      expect(await restarted.countQuads(finalized.graphUri), label).toBe(0);
      await restarted.close();
    }
  }, 240_000);

  it(`times ${BENCH_SHARES} shares on a worker store of ${BENCH_QUADS} unrelated quads`, async () => {
    const dir = await tempDir('dkg-share-snapshot-bench-');
    const path = join(dir, 'store.nq');
    await writeFile(path, syntheticStore(BENCH_QUADS));
    // The default backend, with its background snapshots.
    const store = new OxigraphWorkerStore(path);
    // Whole-snapshot rewrites, flushed or background: each one renames a new file over the store file.
    let inode = statSync(path).ino, rewrites = 0;
    const watcher = setInterval(() => {
      try { const current = statSync(path).ino; if (current !== inode) { rewrites++; inode = current; } } catch { /* mid-rename */ }
    }, 2);
    const settled = async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
      while (existsSync(`${path}.tmp`)) await new Promise(resolve => setTimeout(resolve, 20));
    };
    try {
      const { agent, publisher } = await nodeProcess(store);
      const step = new AsyncLocalStorage<string>();
      labelQueueSteps(agent.promoteQueue, step);
      const flushes = recordFlushes(store, step);
      const rows: { shareMs: number; snapshotRewrites: number }[] = [];
      for (let i = 0; i < BENCH_SHARES; i++) {
        const name = `bench-asset-${i}`;
        await finalizedAsset(store, publisher, name, [
          { subject: `urn:bench:asset:${i}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://schema.org/Thing' },
          { subject: `urn:bench:asset:${i}`, predicate: 'https://schema.org/name', object: `"Bench asset ${i}"` },
          { subject: `urn:bench:asset:${i}`, predicate: 'https://schema.org/dateCreated', object: '"2026-11-19T00:00:00Z"' },
        ]);
        await settled();
        const flushesBefore = flushes.length, rewritesBefore = rewrites;
        const started = performance.now();
        await expect(share(agent, name)).resolves.toMatchObject({ promotedCount: 3, publishReady: true });
        const shareMs = Math.round(performance.now() - started), snapshotRewrites = rewrites - rewritesBefore;
        const during = flushes.slice(flushesBefore);
        expect(during.map(flush => flush.step)).toEqual(['enqueueAndClaim', 'succeed']);
        const row = { share: i, shareMs, snapshotRewrites,
          flushMs: Object.fromEntries(during.map(flush => [flush.step, Math.round(flush.ms)])) };
        rows.push(row);
        console.log(`[share-snapshot-bench] ${JSON.stringify(row)}`);
        if (BENCH_OUT) await appendFile(BENCH_OUT, `${JSON.stringify(row)}\n`);
        await settled();
      }
      const summary = { quads: BENCH_QUADS, shares: BENCH_SHARES, medianShareMs: median(rows.map(row => row.shareMs)),
        minShareMs: Math.min(...rows.map(row => row.shareMs)), maxShareMs: Math.max(...rows.map(row => row.shareMs)),
        medianSnapshotRewrites: median(rows.map(row => row.snapshotRewrites)) };
      console.log(`[share-snapshot-bench] summary ${JSON.stringify(summary)}`);
      if (BENCH_OUT) await appendFile(BENCH_OUT, `${JSON.stringify({ summary })}\n`);
    } finally {
      clearInterval(watcher);
      await store.close();
    }
  }, 30 * 60_000);
});
