import { parentPort, workerData } from 'node:worker_threads';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { Interface, id } from 'ethers';
import {
  ChainEventDecoderRegistry,
  chainEventLogStateReadRefusal,
  createKnowledgeAssetReadModel,
  type ChainEventLogRow,
  type ChainEventLogStore,
} from '@origintrail-official/dkg-chain';
import { SqliteChainEventLogStore } from '@origintrail-official/dkg-node-ui';
import type {
  ChainIndexReadMessage,
  ChainIndexReadRequest,
  ChainIndexReadResponse,
} from './chain-index-read-worker-protocol.js';

const port = parentPort;
if (port === null) throw new Error('Chain-index reader requires a worker');
const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true, timeout: 50 });
db.pragma('query_only = ON');
const store = new SqliteChainEventLogStore({ db });
const active = new Map<number, { cancelled: boolean }>();
const registrationTopic = id('KnowledgeAssetRegisteredToContextGraph(uint256,uint256)');
const topic = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
const uint256 = (value: bigint) => value >= 0n && value < (1n << 256n);
// Bound native SQLite allocation before .all() constructs JS rows. A worker
// heap limit alone cannot safely contain an OOM inside a native addon.
const MAX_SNAPSHOT_ROWS = 8_192;

async function read(request: ChainIndexReadRequest): Promise<ChainIndexReadResponse> {
  const response: ChainIndexReadResponse = { id: request.id, rowsRead: 0, readMs: 0, decodeMs: 0 };
  const task = { cancelled: false };
  active.set(request.id, task);
  const expired = () => task.cancelled || Date.now() >= request.deadlineAt;
  try {
    if (!uint256(request.key) || expired()) return { ...response, reason: 'unavailable' };
    const started = performance.now();
    // Store methods perform their SQL synchronously. These already-resolved
    // awaits only yield microtasks, so no other request opens a transaction
    // until this snapshot has been fully captured and released.
    db.exec('BEGIN');
    let state;
    let rows: readonly ChainEventLogRow[] = [];
    let ownWriteHash: string | undefined;
    let oversized = false;
    try {
      state = await store.load(request.model.scope);
      if (state !== undefined && chainEventLogStateReadRefusal(state, {
        nowMs: Date.now(), maxHeadAgeMs: request.model.maxHeadAgeMs,
      }) === undefined) {
        const selected = await store.readEventsBounded(request.model.scope, {
          fromBlockNumber: 0,
          throughBlockNumber: state.cursor.head.number,
          addresses: [request.model.contextGraphStorageAddress.toLowerCase()],
          ...(request.method === 'binding'
            ? { topic0: [registrationTopic], topic2: [topic(request.key)] }
            : { topic1: [topic(request.key)] }),
        }, MAX_SNAPSHOT_ROWS);
        oversized = selected === undefined;
        rows = selected ?? [];
        if (request.options.ownWrite !== undefined) {
          ownWriteHash = await store.blockHashAt(request.model.scope, request.options.ownWrite.blockNumber);
        }
      }
    } finally {
      db.exec('ROLLBACK');
    }
    response.readMs = performance.now() - started;
    response.rowsRead = rows.length;
    if (oversized) return { ...response, rowsRead: MAX_SNAPSHOT_ROWS + 1, reason: 'row-limit' };
    if (state === undefined || expired()) return { ...response, reason: 'unavailable' };

    const held = state;
    // The chain package retains all coverage/finality/own-write decisions.
    // Its reads now observe one immutable snapshot, not interleaved commits.
    const snapshot: ChainEventLogStore = {
      load: async (scope) => scope === request.model.scope ? held : undefined,
      blockHashAt: async (_scope, block) => block === request.options.ownWrite?.blockNumber ? ownWriteHash : undefined,
      readEvents: async (_scope, query) => rows.filter((row) =>
        row.blockNumber >= query.fromBlockNumber && row.blockNumber <= query.throughBlockNumber
        && (!query.addresses?.length || query.addresses.includes(row.address))
        && (!query.topic0?.length || query.topic0.includes(row.topics[0]))
        && (!query.topic1?.length || query.topic1.includes(row.topics[1]))
        && (!query.topic2?.length || query.topic2.includes(row.topics[2]))),
      commit: async () => { throw new Error('Read-only chain snapshot'); },
      tombstone: async () => { throw new Error('Read-only chain snapshot'); },
    };
    const registry = new ChainEventDecoderRegistry();
    const abi = new Interface(JSON.parse(request.model.contextGraphStorageAbi));
    registry.registerContextGraphAuthority(request.model.contextGraphStorageAddress, abi);
    registry.registerContextGraphKnowledgeAssets(request.model.contextGraphStorageAddress, abi);
    const decodeStarted = performance.now();
    const decode = registry.decodeContextGraphKaRegistrations.bind(registry);
    const decodeAuthority = registry.decodeContextGraphAuthority.bind(registry);
    const decoded = new Map<ChainEventLogRow, ReturnType<typeof decode>[number]>();
    const decodedAuthority = new Map<ChainEventLogRow, ReturnType<typeof decodeAuthority>[number]>();
    // Bulk ordinal reads yield between batches, allowing cancellations and
    // concurrent point requests to progress. Decoding never holds a SQL lock.
    for (let offset = 0; offset < rows.length; offset += 128) {
      if (expired()) return { ...response, decodeMs: performance.now() - decodeStarted, reason: 'timeout' };
      for (const row of rows.slice(offset, offset + 128)) {
        const event = decode([row])[0];
        if (event !== undefined) decoded.set(row, event);
        if (request.method !== 'binding') {
          const authority = decodeAuthority([row])[0];
          if (authority !== undefined) decodedAuthority.set(row, authority);
        }
      }
      if (offset + 128 < rows.length) await yieldTurn();
    }
    registry.decodeContextGraphKaRegistrations = (selected) => selected.flatMap((row) => {
      const event = decoded.get(row);
      return event === undefined ? [] : [event];
    });
    registry.decodeContextGraphAuthority = (selected) => selected.flatMap((row) => {
      const event = decodedAuthority.get(row);
      return event === undefined ? [] : [event];
    });
    const model = createKnowledgeAssetReadModel({ ...request.model, store: snapshot, registry });
    if (request.method === 'binding') {
      response.result = await model.readContextGraphForKa(request.key, request.options);
    } else {
      const list = await model.readContextGraphKaList(request.key, request.options);
      if (request.method === 'list') {
        // Avoid a large clone back to the main thread. A refused list remains
        // a proof miss and takes the same RPC fallback as incomplete coverage.
        if (list !== undefined && list.kaIds.length <= 1_024) response.result = list;
      } else if (list !== undefined && request.index !== undefined
        && request.index >= 0n && request.index < BigInt(list.kaIds.length)) {
        response.result = { kaId: list.kaIds[Number(request.index)], asOfBlockNumber: list.throughBlockNumber };
      }
    }
    response.decodeMs = performance.now() - decodeStarted;
    if (expired()) return { ...response, result: undefined, reason: 'timeout' };
    response.fence = {
      revision: held.cursor.revision,
      lineage: held.cursor.lineage,
      topicSetVersion: held.cursor.topicSetVersion,
    };
    response.reason = response.result === undefined ? 'proof-miss' : 'served';
    return response;
  } catch {
    // A read-model failure never starts a second scanner or a main-thread fold.
    return { ...response, result: undefined, reason: 'read-error' };
  } finally {
    active.delete(request.id);
  }
}

port.on('message', (message: ChainIndexReadMessage) => {
  if (message.type === 'cancel') {
    const task = active.get(message.id);
    if (task !== undefined) task.cancelled = true;
    return;
  }
  void read(message).then((response) => port.postMessage(response));
});
port.on('close', () => db.close());
port.postMessage({ type: 'ready' });
