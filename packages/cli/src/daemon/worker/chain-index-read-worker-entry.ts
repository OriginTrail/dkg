import { parentPort, workerData } from 'node:worker_threads';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { Interface } from 'ethers';
import {
  ChainEventDecoderRegistry,
  createKnowledgeAssetReadSnapshot,
  evaluateKnowledgeAssetSnapshot,
  planKnowledgeAssetSnapshotRead,
  type KnowledgeAssetSnapshotPlan,
  type KnowledgeAssetSnapshotRead,
  type ChainEventLogRow,
} from '@origintrail-official/dkg-chain';
import { SqliteChainEventLogStore } from '@origintrail-official/dkg-node-ui';
import type {
  ChainIndexReadMessage,
  ChainIndexReadRequest,
  ChainIndexReadResponse,
} from './chain-index-read-worker-protocol.js';

if (parentPort === null) throw new Error('Chain-index reader requires a worker');
const port = parentPort;
const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true, timeout: 50 });
db.pragma('query_only = ON');
const store = new SqliteChainEventLogStore({ db });
const active = new Map<number, AbortController>();
// Bound native SQLite allocation before .all() constructs JS rows. A worker
// heap limit alone cannot safely contain an OOM inside a native addon.
const MAX_SNAPSHOT_ROWS = 8_192;
// Integration tests can queue messages while the first decode batch is held.
// This synchronous barrier does NOT process messages or yield: progress after
// release still requires the production yieldTurn() below.
const testDecodeBarrier = workerData.testDecodeBarrier instanceof SharedArrayBuffer
  ? new Int32Array(workerData.testDecodeBarrier) : undefined;

function snapshotRead(request: ChainIndexReadRequest): KnowledgeAssetSnapshotRead {
  if (request.method === 'binding') return { kind: 'binding', kaId: request.key };
  if (request.method === 'ordinal') {
    return { kind: 'ordinal', contextGraphId: request.key, index: request.index ?? -1n };
  }
  return { kind: 'list', contextGraphId: request.key };
}

async function read(request: ChainIndexReadRequest): Promise<ChainIndexReadResponse> {
  const response: ChainIndexReadResponse = { id: request.id, rowsRead: 0, readMs: 0, decodeMs: 0 };
  const task = new AbortController();
  active.set(request.id, task);
  const expired = () => task.signal.aborted || Date.now() >= request.deadlineAt;
  const assertActive = () => {
    if (Date.now() >= request.deadlineAt) task.abort(new Error('Chain-index read deadline expired'));
    task.signal.throwIfAborted();
  };
  try {
    if (expired()) return { ...response, reason: 'unavailable' };
    const started = performance.now();
    // SQL is synchronous and these awaits only yield microtasks. Capture one
    // immutable snapshot, then release the transaction before cooperative work.
    db.exec('BEGIN');
    let plan: KnowledgeAssetSnapshotPlan | undefined;
    let rows: readonly ChainEventLogRow[] | undefined;
    let ownWriteHash: string | undefined;
    try {
      const state = await store.load(request.model.scope);
      if (state !== undefined) {
        plan = planKnowledgeAssetSnapshotRead({
          state, contextGraphStorageAddress: request.model.contextGraphStorageAddress,
          read: snapshotRead(request), options: request.options,
          maxHeadAgeMs: request.model.maxHeadAgeMs,
        });
        if (plan !== undefined) {
          rows = await store.readEventsBounded(request.model.scope, plan.query, MAX_SNAPSHOT_ROWS);
          if (request.options.ownWrite !== undefined) {
            ownWriteHash = await store.blockHashAt(request.model.scope, request.options.ownWrite.blockNumber);
          }
        }
      }
    } finally {
      db.exec('ROLLBACK');
    }
    response.readMs = performance.now() - started;
    response.rowsRead = rows?.length ?? 0;
    if (plan === undefined) return { ...response, reason: 'proof-miss' };
    if (rows === undefined) return { ...response, rowsRead: MAX_SNAPSHOT_ROWS + 1, reason: 'row-limit' };
    if (expired()) return { ...response, reason: 'unavailable' };

    const registry = new ChainEventDecoderRegistry();
    const abi = new Interface(JSON.parse(request.model.contextGraphStorageAbi));
    registry.registerContextGraphAuthority(request.model.contextGraphStorageAddress, abi);
    registry.registerContextGraphKnowledgeAssets(request.model.contextGraphStorageAddress, abi);
    const decodeStarted = performance.now();
    try {
      response.result = await evaluateKnowledgeAssetSnapshot(
        createKnowledgeAssetReadSnapshot(plan, rows, ownWriteHash), registry, {
          signal: task.signal,
          yieldBetweenBatches: async (progress) => {
            if (testDecodeBarrier !== undefined && request.method === 'ordinal'
              && Atomics.compareExchange(testDecodeBarrier, 0, 0, 1) === 0) {
              port.postMessage({ type: 'test-decode-batch', id: request.id, ...progress });
              Atomics.wait(testDecodeBarrier, 0, 1, 10_000);
            }
            await yieldTurn();
            assertActive();
          },
        },
      );
    } finally {
      response.decodeMs = performance.now() - decodeStarted;
    }
    // The compatibility list port must not copy a large list to the main loop.
    if (response.result !== undefined && 'kaIds' in response.result && response.result.kaIds.length > 1_024) {
      response.result = undefined;
    }
    if (expired()) return { ...response, result: undefined, reason: 'timeout' };
    response.fence = {
      revision: plan.state.cursor.revision,
      lineage: plan.state.cursor.lineage,
      topicSetVersion: plan.state.cursor.topicSetVersion,
    };
    response.reason = response.result === undefined ? 'proof-miss' : 'served';
    return response;
  } catch {
    // Refusal never starts a scanner or a main-thread historical fold.
    return { ...response, result: undefined, reason: expired() ? 'timeout' : 'read-error' };
  } finally {
    active.delete(request.id);
  }
}

port.on('message', (message: ChainIndexReadMessage) => {
  if (message.type === 'cancel') {
    active.get(message.id)?.abort(new Error('Chain-index read cancelled'));
    return;
  }
  void read(message).then((response) => port.postMessage(response));
});
port.on('close', () => db.close());
port.postMessage({ type: 'ready' });
