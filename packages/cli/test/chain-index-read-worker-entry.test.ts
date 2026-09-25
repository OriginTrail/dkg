import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface } from 'ethers';
import { DashboardDB, SqliteChainEventLogStore } from '@origintrail-official/dkg-node-ui';
import type { ChainEventLogRow } from '@origintrail-official/dkg-chain/internal/chain-index-worker';
import {
  yieldChainIndexReadWorker,
  type ChainIndexReadCheckpoint,
} from '../src/daemon/worker/chain-index-read-worker-handler.js';
import type {
  ChainIndexReadRequest, ChainIndexReadResponse, ChainIndexReadWorkerMessage,
} from '../src/daemon/worker/chain-index-read-worker-protocol.js';

// Most cases replace only the transport boundary and load the production entry.
// Checkpoint fault cases exercise its shared handler with an injected dependency.
const environment = vi.hoisted(() => ({
  parentPort: null as unknown,
  workerData: {} as { dbPath?: string },
}));
vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  get parentPort() { return environment.parentPort; },
  get workerData() { return environment.workerData; },
}));

type EntryMessage = ChainIndexReadWorkerMessage;

class TestPort extends EventEmitter {
  readonly posted: EntryMessage[] = [];
  closed = false;

  postMessage(message: EntryMessage) {
    this.posted.push(message);
    this.emit('outbound', message);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  send(request: ChainIndexReadRequest): Promise<ChainIndexReadResponse> {
    return new Promise((resolve, reject) => {
      const receive = (message: EntryMessage) => {
        if ('type' in message || message.id !== request.id) return;
        clearTimeout(timer);
        this.off('outbound', receive);
        try {
          expect(message.method).toBe(request.method);
          if (message.reason === 'served') {
            expect(message.result).toBeDefined();
            expect(message.fence).toBeDefined();
          } else {
            expect(message.result).toBeUndefined();
            expect(message.fence).toBeUndefined();
          }
          resolve(message);
        } catch (error) { reject(error); }
      };
      const timer = setTimeout(() => {
        this.off('outbound', receive);
        reject(new Error(`No response for request ${request.id}`));
      }, 5_000);
      this.on('outbound', receive);
      this.emit('message', request);
    });
  }
}

const address = `0x${'ab'.repeat(20)}`;
const scope = 'evm:31337:entry-test';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const abi = readFileSync(new URL('../../chain/abi/ContextGraphStorage.json', import.meta.url), 'utf8');
const iface = new Interface(JSON.parse(abi));

function event(name: string, args: unknown[], blockNumber: number, logIndex = 0): ChainEventLogRow {
  const encoded = iface.encodeEventLog(iface.getEvent(name)!, args);
  return { address, blockNumber, logIndex, topics: encoded.topics, data: encoded.data,
    blockHash: hash(blockNumber), transactionHash: hash(logIndex + 100), settled: blockNumber <= 10 };
}
const registration = (ka: bigint, block = 10, index = 0) =>
  event('KnowledgeAssetRegisteredToContextGraph', [7n, ka], block, index);
const creation = () => event('ContextGraphCreated',
  [7n, address, hash(22), [address], 7n, 1, 0, address, 7n], 1);
const registrations = (count: number) => {
  const template = registration(1n);
  return Array.from({ length: count }, (_, n) => ({
    ...template, logIndex: n, topics: [...template.topics.slice(0, 2), hash(n + 1)],
  }));
};
const cleanup: (() => void)[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
  environment.parentPort = null;
  environment.workerData = {};
  vi.resetModules();
});

async function fixture(
  rows: ChainEventLogRow[],
  checkpoint?: (progress: ChainIndexReadCheckpoint, port: TestPort) => Promise<void>,
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dkg-entry-test-'));
  const db = new DashboardDB({ dataDir });
  const store = new SqliteChainEventLogStore(db);
  const port = new TestPort();
  cleanup.push(() => { port.close(); db.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await store.commit(scope, undefined, {
    cursor: { lineage: hash(1), deploymentBlockNumber: 1, settledBlockNumber: 10,
      settledBlockHash: hash(10), head: { number: 12, hash: hash(12),
        timestampSeconds: Math.floor(Date.now() / 1_000), fetchedAtMs: Date.now() }, topicSetVersion: 'v1' },
    coverage: ['context-graph-ka', 'context-graph-authority'].map((family) => ({ family, address,
      coveredFromBlock: 1, coveredThroughBlock: 12, floorBlock: 1 })),
    rows, replacedRange: { fromBlockNumber: 11, throughBlockNumber: 12 },
  });
  environment.parentPort = port;
  environment.workerData = { dbPath: join(dataDir, 'node-ui.db') };
  vi.resetModules();
  if (checkpoint === undefined) {
    await import('../src/daemon/worker/chain-index-read-worker-entry.js');
  } else {
    const { createChainIndexReadWorkerHandler } = await import('../src/daemon/worker/chain-index-read-worker-handler.js');
    const handler = createChainIndexReadWorkerHandler({
      dbPath: environment.workerData.dbPath!,
      postMessage: (response) => port.postMessage(response),
      checkpoint: (progress) => checkpoint(progress, port),
    });
    port.on('message', handler.handle);
    port.on('close', handler.close);
    port.postMessage({ type: 'ready' });
  }
  expect(port.posted).toEqual([{ type: 'ready' }]);
  let nextId = 0;
  const request = (overrides: Partial<ChainIndexReadRequest> = {}): ChainIndexReadRequest => ({
    type: 'read', id: ++nextId, method: 'binding', key: 1n, options: {}, deadlineAt: Date.now() + 30_000,
    model: { scope, contextGraphStorageAddress: address, contextGraphStorageAbi: abi, maxHeadAgeMs: 60_000 },
    ...overrides,
  });
  return { db, store, port, request };
}

describe('chain-index worker entry and handler over a message port and real SQLite', () => {
  it('requires a worker message port before opening a database', async () => {
    environment.parentPort = null;
    vi.resetModules();
    await expect(import('../src/daemon/worker/chain-index-read-worker-entry.js'))
      .rejects.toThrow('Chain-index reader requires a worker');
  });

  it('dispatches binding, list and ordinal reads with a fence, and closes its reader handle', async () => {
    const { db, store, port, request } = await fixture([creation(), registration(1n), registration(2n, 10, 1)]);
    const before = await store.load(scope);
    const count = db.db.prepare('SELECT COUNT(*) AS n FROM chain_events').get();
    await expect(port.send(request())).resolves.toMatchObject({ reason: 'served', rowsRead: 1,
      result: { kind: 'bound', contextGraphId: 7n, asOfBlockNumber: 10 },
      fence: { revision: 1, lineage: hash(1), topicSetVersion: 'v1' } });
    await expect(port.send(request({ method: 'list', key: 7n }))).resolves.toMatchObject({
      reason: 'served', result: { contextGraphId: 7n, kaIds: [1n, 2n], throughBlockNumber: 10 } });
    await expect(port.send(request({ method: 'ordinal', key: 7n, index: 1n }))).resolves.toMatchObject({
      reason: 'served', result: { kaId: 2n, asOfBlockNumber: 10 } });
    await expect(port.send(request({ method: 'ordinal', key: 7n, index: -1n }))).resolves.toMatchObject({ reason: 'proof-miss' });
    expect(await store.load(scope)).toEqual(before);
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM chain_events').get()).toEqual(count);
    port.close();
    // The closed read-only connection refuses; the independent writer remains usable.
    await expect(port.send(request())).resolves.toMatchObject({ reason: 'read-error' });
    expect(await store.load(scope)).toEqual(before);
  });

  it('enforces finality and own-write hashes using the captured database state', async () => {
    const { port, request } = await fixture([creation(), registration(1n), registration(2n, 12)]);
    await expect(port.send(request({ key: 2n }))).resolves.toMatchObject({ reason: 'proof-miss', rowsRead: 0 });
    await expect(port.send(request({ key: 2n, options: { view: 'latest' } }))).resolves.toMatchObject({
      reason: 'served', result: { contextGraphId: 7n, asOfBlockNumber: 12 } });
    await expect(port.send(request({ options: { ownWrite: { blockNumber: 10, blockHash: hash(10) } } })))
      .resolves.toMatchObject({ reason: 'served', result: { contextGraphId: 7n } });
    await expect(port.send(request({ options: { ownWrite: { blockNumber: 10, blockHash: hash(99) } } })))
      .resolves.toMatchObject({ reason: 'proof-miss' });
    await expect(port.send(request({ options: { ownWrite: { blockNumber: 12, blockHash: hash(12) } } })))
      .resolves.toMatchObject({ reason: 'proof-miss', rowsRead: 0 });
  });

  it('refuses missing scope, invalid keys and bad ABI without losing the message listener', async () => {
    const { port, request } = await fixture([creation(), registration(1n)]);
    const missing = request();
    missing.model = { ...missing.model, scope: 'unknown-scope' };
    await expect(port.send(missing)).resolves.toMatchObject({ reason: 'proof-miss', rowsRead: 0 });
    await expect(port.send(request({ key: -1n }))).resolves.toMatchObject({ reason: 'proof-miss', rowsRead: 0 });
    const invalidAbi = request();
    invalidAbi.model = { ...invalidAbi.model, contextGraphStorageAbi: 'invalid JSON' };
    await expect(port.send(invalidAbi)).resolves.toMatchObject({ reason: 'read-error' });
    await expect(port.send(request())).resolves.toMatchObject({ reason: 'served' });
  });

  it('refuses an expired request before reading, and expiry during snapshot capture', async () => {
    const { port, request } = await fixture([creation(), registration(1n)]);
    await expect(port.send(request({ deadlineAt: Date.now() - 1 }))).resolves.toMatchObject({
      reason: 'unavailable', rowsRead: 0 });
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const duringCapture = port.send(request({ deadlineAt: clock + 1_000 }));
    // The first store await resumes the planner before this microtask; the
    // next await completes the row capture after its deadline has passed.
    queueMicrotask(() => { clock += 2_000; });
    await expect(duringCapture).resolves.toMatchObject({ reason: 'unavailable', rowsRead: 1 });
    await expect(port.send(request())).resolves.toMatchObject({ reason: 'served' });
  });

  it('caps SQL allocation and still serves an indexed point lookup after refusal', async () => {
    const { port, request } = await fixture([creation(), ...registrations(9_000)]);
    const refused = await port.send(request({ method: 'ordinal', key: 7n, index: 0n }));
    expect(refused).toMatchObject({ reason: 'row-limit', rowsRead: 8_193 });
    expect(refused.result).toBeUndefined();
    await expect(port.send(request({ key: 9_000n }))).resolves.toMatchObject({
      reason: 'served', rowsRead: 1, result: { contextGraphId: 7n } });
  });

  it('refuses a large compatibility list while serving a scalar ordinal from the same graph', async () => {
    const { port, request } = await fixture([creation(), ...registrations(1_025)]);
    await expect(port.send(request({ method: 'list', key: 7n }))).resolves.toMatchObject({
      reason: 'proof-miss', rowsRead: 1_026 });
    await expect(port.send(request({ method: 'ordinal', key: 7n, index: 1_024n }))).resolves.toMatchObject({
      reason: 'served', result: { kaId: 1_025n } });
  });

  it('wires the real cooperative checkpoint through the production entry', async () => {
    const { port, request } = await fixture([creation(), ...registrations(300)]);
    const bulk = request({ method: 'ordinal', key: 7n, index: 299n });
    const result = port.send(bulk);
    // Capture starts in microtasks. The production entry must yield an event-loop
    // turn during decoding for this queued cancellation to reach the handler.
    setImmediate(() => port.emit('message', { type: 'cancel', id: bulk.id }));
    await expect(result).resolves.toMatchObject({ reason: 'timeout' });
    await expect(port.send(request())).resolves.toMatchObject({ reason: 'served', rowsRead: 1 });
  });

  it.each(['cancel', 'deadline'] as const)('observes %s at an injected decode checkpoint and handles the next request', async (kind) => {
    let clock = Date.now();
    const checkpoints: number[] = [];
    const { port, request } = await fixture([creation(), ...registrations(300)], async (progress, entryPort) => {
      checkpoints.push(progress.decodedRows);
      setImmediate(() => {
        if (kind === 'cancel') entryPort.emit('message', { type: 'cancel', id: progress.id });
        else clock += 2_000;
      });
      await yieldChainIndexReadWorker();
    });
    clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const bulk = request({ method: 'ordinal', key: 7n, index: 299n, deadlineAt: clock + 1_000 });
    await expect(port.send(bulk)).resolves.toMatchObject({ reason: 'timeout' });
    expect(checkpoints).toEqual([128]);
    // A cancel for a completed/unknown request is harmless, and the live handler
    // serves the next request without any worker replacement or reset.
    port.emit('message', { type: 'cancel', id: bulk.id });
    await expect(port.send(request())).resolves.toMatchObject({ reason: 'served', rowsRead: 1 });
  });
});
