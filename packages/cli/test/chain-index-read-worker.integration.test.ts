import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Interface } from 'ethers';
import { DashboardDB, SqliteChainEventLogStore } from '@origintrail-official/dkg-node-ui';
import type { ChainEventLogStore, ChainEventLogState, ChainEventLogRow } from '@origintrail-official/dkg-chain';
import { ChainIndexReadWorker, type ChainIndexReadDiagnostic } from '../src/daemon/worker/chain-index-read-worker.js';
import type {
  ChainIndexReadRequest, ChainIndexReadResponse, ChainIndexReadWorkerMessage,
} from '../src/daemon/worker/chain-index-read-worker-protocol.js';

type ChainEventLogCommit = Parameters<ChainEventLogStore['commit']>[2];
type ChainEventLogCoverage = ChainEventLogState['coverage'][number];

const address = `0x${'cd'.repeat(20)}`;
const scope = 'evm:31337:worker-test';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const abi = readFileSync(new URL('../../chain/abi/ContextGraphStorage.json', import.meta.url), 'utf8');
const iface = new Interface(JSON.parse(abi));

function event(name: string, args: unknown[], blockNumber: number, logIndex = 0): ChainEventLogRow {
  const encoded = iface.encodeEventLog(iface.getEvent(name)!, args);
  return { address, blockNumber, logIndex, topics: encoded.topics, data: encoded.data,
    blockHash: hash(blockNumber), transactionHash: hash(logIndex + 100), settled: blockNumber <= 10 };
}
const registration = (ka: bigint, block = 10, graph = 7n, index = 0) =>
  event('KnowledgeAssetRegisteredToContextGraph', [graph, ka], block, index);
const creation = (graph = 7n) => event('ContextGraphCreated',
  [graph, address, hash(22), [address], 7n, 1, 0, address, 7n], 1);

function commit(rows: ChainEventLogRow[], overrides: Partial<ChainEventLogCommit> = {}): ChainEventLogCommit {
  return {
    cursor: { lineage: hash(1), deploymentBlockNumber: 1, settledBlockNumber: 10,
      settledBlockHash: hash(10), head: { number: 12, hash: hash(12),
        timestampSeconds: Math.floor(Date.now() / 1_000), fetchedAtMs: Date.now() }, topicSetVersion: 'v1' },
    coverage: ['context-graph-ka', 'context-graph-authority'].map((family) => ({ family, address,
      coveredFromBlock: 1, coveredThroughBlock: 12, floorBlock: 1 })),
    rows, replacedRange: { fromBlockNumber: 11, throughBlockNumber: 12 }, ...overrides,
  };
}

type TestWorkerMessage = ChainIndexReadWorkerMessage
  | { type: 'test-decode-batch'; id: number; decodedRows: number; totalRows: number };

function nextMessage(worker: Worker, matches: (message: TestWorkerMessage) => boolean): Promise<TestWorkerMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.off('message', receive);
      worker.off('error', fail);
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const receive = (message: TestWorkerMessage) => {
      if (matches(message)) { cleanup(); resolve(message); }
    };
    const timer = setTimeout(() => fail(new Error('Worker did not reach the expected checkpoint')), 10_000);
    worker.on('message', receive);
    worker.on('error', fail);
  });
}

describe('chain-index reader with the packaged worker and a real SQLite log', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

  async function fixture(rows: ChainEventLogRow[], coverage?: ChainEventLogCoverage[]) {
    const dataDir = mkdtempSync(join(tmpdir(), 'dkg-read-worker-'));
    const db = new DashboardDB({ dataDir });
    const store = new SqliteChainEventLogStore(db);
    const diagnostics: ChainIndexReadDiagnostic[] = [];
    const worker = new ChainIndexReadWorker(join(dataDir, 'node-ui.db'), store, {
      timeoutMs: 5_000, onDiagnostic: (entry) => diagnostics.push(entry),
    });
    cleanup.push(async () => { await worker.close(); db.close(); rmSync(dataDir, { recursive: true, force: true }); });
    await store.commit(scope, undefined, commit(rows, coverage ? { coverage } : {}));
    const model = worker.createReadModel({ scope, contextGraphStorageAddress: address,
      contextGraphStorageAbi: abi, maxHeadAgeMs: 60_000 });
    return { db, store, worker, model, diagnostics, dataDir };
  }

  async function heldBulkDecode() {
    const rows = Array.from({ length: 8_000 }, (_, n) => registration(BigInt(n + 1), 10, 7n, n));
    const { dataDir } = await fixture([creation(), ...rows]);
    const barrier = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const thread = new Worker(new URL('../dist/daemon/worker/chain-index-read-worker-entry.js', import.meta.url), {
      workerData: { dbPath: join(dataDir, 'node-ui.db'), testDecodeBarrier: barrier.buffer },
    });
    const release = () => { Atomics.store(barrier, 0, 2); Atomics.notify(barrier, 0); };
    // Terminate before the fixture closes/removes its database, including on assertion failure.
    cleanup.unshift(async () => { release(); await thread.terminate(); });
    const responses: number[] = [];
    const errors: Error[] = [];
    thread.on('error', (error) => errors.push(error));
    thread.on('message', (message: TestWorkerMessage) => {
      if (!('type' in message)) responses.push(message.id);
    });
    await nextMessage(thread, (message) => 'type' in message && message.type === 'ready');
    const request = (id: number, method: 'ordinal' | 'binding', key: bigint): ChainIndexReadRequest => ({
      type: 'read', id, method, key, ...(method === 'ordinal' ? { index: 7_999n } : {}),
      model: { scope, contextGraphStorageAddress: address, contextGraphStorageAbi: abi, maxHeadAgeMs: 60_000 },
      options: {}, deadlineAt: Date.now() + 30_000,
    });
    const checkpoint = nextMessage(thread, (message) => 'type' in message && message.type === 'test-decode-batch');
    const bulk = nextMessage(thread, (message) => !('type' in message) && message.id === 1);
    thread.postMessage(request(1, 'ordinal', 7n));
    await expect(checkpoint).resolves.toMatchObject({ decodedRows: 128, totalRows: 8_001 });
    return { thread, release, request, bulk, responses, errors };
  }

  it('serves a concurrent point read at a real batch yield before a permitted bulk ordinal completes', async () => {
    const { thread, release, request, bulk, responses, errors } = await heldBulkDecode();
    const point = nextMessage(thread, (message) => !('type' in message) && message.id === 2);
    // Queue while decode is synchronously held; the hook cannot process messages.
    // Removing the production yield makes ordinal 1 finish before point 2.
    thread.postMessage(request(2, 'binding', 8_000n));
    release();
    await expect(point).resolves.toMatchObject({ id: 2, reason: 'served', rowsRead: 1,
      result: { kind: 'bound', contextGraphId: 7n } });
    await expect(bulk).resolves.toMatchObject({ id: 1, reason: 'served', rowsRead: 8_001,
      result: { kaId: 8_000n } });
    expect(responses.indexOf(2)).toBeLessThan(responses.indexOf(1));
    expect(errors).toEqual([]);
  });

  it('observes cancellation at a real batch yield without recycling the worker', async () => {
    const { thread, release, request, bulk, errors } = await heldBulkDecode();
    const point = nextMessage(thread, (message) => !('type' in message) && message.id === 2);
    thread.postMessage({ type: 'cancel', id: 1 });
    thread.postMessage(request(2, 'binding', 8_000n));
    release();
    const cancelled = await bulk as ChainIndexReadResponse;
    expect(cancelled.result).toBeUndefined();
    expect(cancelled.reason).toBe('timeout');
    await expect(point).resolves.toMatchObject({ reason: 'served', result: { contextGraphId: 7n } });
    // The same real worker still serves after cancellation; no client/watchdog is involved.
    const after = nextMessage(thread, (message) => !('type' in message) && message.id === 3);
    thread.postMessage(request(3, 'binding', 1n));
    await expect(after).resolves.toMatchObject({ reason: 'served', result: { contextGraphId: 7n } });
    expect(errors).toEqual([]);
  });

  it('reads only one registration for a point lookup and never changes the database', async () => {
    const rows = Array.from({ length: 2_000 }, (_, n) => registration(BigInt(n + 1), 10, 7n, n));
    const { db, store, model, diagnostics } = await fixture([creation(), ...rows]);
    const before = await store.load(scope);
    const countBefore = db.db.prepare('SELECT COUNT(*) AS n FROM chain_events').get();
    await expect(model.readContextGraphForKa(1_777n)).resolves.toEqual({
      kind: 'bound', contextGraphId: 7n, asOfBlockNumber: 10,
    });
    expect(diagnostics.at(-1)).toMatchObject({ method: 'binding', reason: 'served', rowsRead: 1 });
    await expect(model.readContextGraphForKa(9_999n)).resolves.toBeUndefined();
    expect(diagnostics.at(-1)).toMatchObject({ reason: 'proof-miss', rowsRead: 0 });
    expect(await store.load(scope)).toEqual(before);
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM chain_events').get()).toEqual(countBefore);
  });

  it('keeps finality, own-write hashes and reorg replacement semantics across the worker boundary', async () => {
    const { model, store } = await fixture([creation(), registration(11n), registration(12n, 12)]);
    await expect(model.readContextGraphForKa(12n)).resolves.toBeUndefined();
    await expect(model.readContextGraphForKa(12n, { view: 'latest' })).resolves.toMatchObject({ contextGraphId: 7n });
    await expect(model.readContextGraphForKa(11n, { ownWrite: { blockNumber: 10, blockHash: hash(10) } }))
      .resolves.toMatchObject({ contextGraphId: 7n });
    await expect(model.readContextGraphForKa(11n, { ownWrite: { blockNumber: 10, blockHash: hash(99) } }))
      .resolves.toBeUndefined();
    await expect(model.readContextGraphForKa(11n, { ownWrite: { blockNumber: 12, blockHash: hash(12) } }))
      .resolves.toBeUndefined();
    await store.commit(scope, 1, commit([registration(12n, 12, 8n)]));
    await expect(model.readContextGraphForKa(12n, { view: 'latest' })).resolves.toMatchObject({ contextGraphId: 8n });
    await store.tombstone(scope, 2);
    await expect(model.readContextGraphForKa(11n)).resolves.toBeUndefined();
  });

  it('returns a scalar ordinal for a large graph and refuses incomplete ordinal coverage', async () => {
    const rows = Array.from({ length: 1_500 }, (_, n) => registration(BigInt(n + 1), 10, 7n, n));
    const { model, store } = await fixture([creation(), ...rows]);
    await expect(model.readContextGraphKaAt!(7n, 1_499n)).resolves.toEqual({ kaId: 1_500n, asOfBlockNumber: 10 });
    // Whole large lists cannot accidentally be cloned onto the event loop.
    await expect(model.readContextGraphKaList(7n)).resolves.toBeUndefined();
    await expect(model.readContextGraphKaAt!(7n, 1_500n)).resolves.toBeUndefined();
    const partial = await fixture([creation(), registration(11n)], [{
      family: 'context-graph-ka', address, coveredFromBlock: 10, coveredThroughBlock: 12, floorBlock: 1,
    }, { family: 'context-graph-authority', address, coveredFromBlock: 1, coveredThroughBlock: 12, floorBlock: 1 }]);
    await expect(partial.model.readContextGraphKaAt!(7n, 0n)).resolves.toBeUndefined();
    // Positive bindings remain usable even while older history is incomplete.
    await expect(partial.model.readContextGraphForKa(11n)).resolves.toMatchObject({ contextGraphId: 7n });
    const state = await store.load(scope);
    await store.commit(scope, state!.cursor.revision, commit([], { suspectedForkBlockNumber: 10 }));
    await expect(model.readContextGraphForKa(1n)).resolves.toBeUndefined();
  });

  it('caps native SQL allocation and keeps point reads working after an oversized graph refusal', async () => {
    const template = registration(1n);
    const rows = Array.from({ length: 9_000 }, (_, n) => ({
      ...template, logIndex: n, topics: [...template.topics.slice(0, 2), hash(n + 1)],
    }));
    const { model, diagnostics } = await fixture([creation(), ...rows]);
    await expect(model.readContextGraphKaAt!(7n, 0n)).resolves.toBeUndefined();
    expect(diagnostics.at(-1)).toMatchObject({ method: 'ordinal', reason: 'row-limit', rowsRead: 8_193 });
    await expect(model.readContextGraphForKa(9_000n)).resolves.toMatchObject({ contextGraphId: 7n });
    expect(diagnostics.at(-1)).toMatchObject({ method: 'binding', reason: 'served', rowsRead: 1 });
  });
});
