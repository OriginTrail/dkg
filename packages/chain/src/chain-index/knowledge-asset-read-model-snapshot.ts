import { id } from 'ethers';
import type { RawContextGraphAuthorityIndexEvent } from '../context-graph-authority-index-reducer.js';
import {
  chainEventLogCoverageIncludes, chainEventLogStateReadRefusal, findChainEventLogCoverage,
  normalizeChainEventLogAddress, normalizeChainEventLogBlockNumber, normalizeChainEventLogHash,
  type ChainEventLogQuery, type ChainEventLogRow, type ChainEventLogState,
} from './chain-event-log.js';
import type { ChainEventDecoderRegistry, ContextGraphKaRegistration } from './chain-event-decoders.js';
import { reduceContextGraphKaRegistrations, type ContextGraphKaList } from './knowledge-asset-reducer.js';
import type { KnowledgeAssetReadOptions } from './knowledge-asset-read-model.js';
import type {
  KnowledgeAssetReadKind, KnowledgeAssetResultByKind, KnowledgeAssetSnapshotRead, KnowledgeAssetSnapshotResult,
} from './knowledge-asset-read-contract.js';
export type { KnowledgeAssetSnapshotRead, KnowledgeAssetSnapshotResult } from './knowledge-asset-read-contract.js';

/** The complete selection contract; callers must capture every matching row. */
export interface KnowledgeAssetSnapshotPlan<K extends KnowledgeAssetReadKind = KnowledgeAssetReadKind> {
  readonly state: ChainEventLogState;
  readonly contextGraphStorageAddress: string;
  readonly read: KnowledgeAssetSnapshotRead<K>;
  readonly options: Omit<KnowledgeAssetReadOptions, 'signal'>;
  readonly maxHeadAgeMs?: number;
  readonly query: ChainEventLogQuery;
}

/** A bounded capture may refuse, but must never pass a truncated row set here. */
export interface KnowledgeAssetReadSnapshot<K extends KnowledgeAssetReadKind = KnowledgeAssetReadKind> {
  readonly plan: KnowledgeAssetSnapshotPlan<K>;
  readonly rows: readonly ChainEventLogRow[];
  readonly ownWriteHash?: string;
}

export interface KnowledgeAssetSnapshotEvaluationOptions {
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  /** Called between 128-row batches, outside the database read transaction. */
  readonly yieldBetweenBatches?: (progress: Readonly<{ decodedRows: number; totalRows: number }>) => Promise<void>;
}

const REGISTRATION_TOPIC = id('KnowledgeAssetRegisteredToContextGraph(uint256,uint256)');
const UINT256_LIMIT = 1n << 256n;
const topic = (value: bigint): string => `0x${value.toString(16).padStart(64, '0')}`;

function windowFor(
  plan: Omit<KnowledgeAssetSnapshotPlan, 'query' | 'read'>,
  family: string,
  nowMs: number,
  requiredFrom?: number,
) {
  const { state, options, contextGraphStorageAddress: address, maxHeadAgeMs } = plan;
  if (chainEventLogStateReadRefusal(state, maxHeadAgeMs === undefined ? {}
    : { nowMs, maxHeadAgeMs }) !== undefined) return undefined;
  const coverage = findChainEventLogCoverage(state.coverage, family, address);
  if (coverage === undefined) return undefined;
  const target = options.view === 'latest' ? state.cursor.head.number : state.cursor.settledBlockNumber;
  const through = Math.min(coverage.coveredThroughBlock, target);
  if (through < coverage.coveredFromBlock) return undefined;
  if (options.ownWrite !== undefined) {
    if (through < options.ownWrite.blockNumber) return undefined;
  }
  if (requiredFrom !== undefined && !chainEventLogCoverageIncludes(coverage, requiredFrom, through)) {
    return undefined;
  }
  return {
    fromBlockNumber: Math.max(requiredFrom ?? coverage.coveredFromBlock, coverage.coveredFromBlock),
    throughBlockNumber: through,
    caughtUp: coverage.coveredThroughBlock >= target,
  };
}

/** Evaluation always checks held evidence; planning never claims to verify it. */
function ownWriteMatches(snapshot: { plan: Pick<KnowledgeAssetSnapshotPlan, 'options'>; ownWriteHash?: string }): boolean {
  const ownWrite = snapshot.plan.options.ownWrite;
  if (ownWrite === undefined) return true;
  const expected = normalizeChainEventLogHash(ownWrite.blockHash);
  const held = normalizeChainEventLogHash(snapshot.ownWriteHash);
  return expected !== undefined && held !== undefined && expected === held;
}

/** Plan selection once for both inline and SQLite-worker readers. No I/O. */
export function planKnowledgeAssetSnapshotRead<K extends KnowledgeAssetReadKind>(input: Readonly<{
  state: ChainEventLogState;
  contextGraphStorageAddress: string;
  read: KnowledgeAssetSnapshotRead<K>;
  options?: KnowledgeAssetReadOptions;
  maxHeadAgeMs?: number;
  nowMs?: number;
}>): KnowledgeAssetSnapshotPlan<K> | undefined {
  const address = normalizeChainEventLogAddress(input.contextGraphStorageAddress);
  if (address === undefined) throw new Error('Knowledge asset snapshot ContextGraphStorage address is invalid');
  const selections: { [P in KnowledgeAssetReadKind]:
    (args: KnowledgeAssetSnapshotRead<P>['args']) => { key: bigint; valid: boolean } } = {
    binding: ({ kaId }) => ({ key: kaId, valid: true }),
    list: ({ contextGraphId }) => ({ key: contextGraphId, valid: true }),
    ordinal: ({ contextGraphId, index }) => ({ key: contextGraphId, valid: index >= 0n }),
  };
  const { key, valid } = selections[input.read.kind](input.read.args);
  if (key < 0n || key >= UINT256_LIMIT || !valid) return undefined;
  const state: ChainEventLogState = Object.freeze({
    ...input.state,
    cursor: Object.freeze({ ...input.state.cursor, head: Object.freeze({ ...input.state.cursor.head }) }),
    coverage: Object.freeze(input.state.coverage.map((entry) => Object.freeze({ ...entry }))),
  });
  const base = {
    state, contextGraphStorageAddress: address, read: Object.freeze({ ...input.read, args: Object.freeze({ ...input.read.args }) }),
    options: Object.freeze({ view: input.options?.view ?? 'finalized',
      ownWrite: input.options?.ownWrite && Object.freeze({ ...input.options.ownWrite }) }),
    maxHeadAgeMs: input.maxHeadAgeMs,
  };
  const window = windowFor(base, input.read.kind === 'binding'
    ? 'context-graph-ka' : 'context-graph-authority', input.nowMs ?? Date.now());
  if (window === undefined || (input.read.kind !== 'binding' && !window.caughtUp)) return undefined;
  const query = Object.freeze({
    fromBlockNumber: window.fromBlockNumber,
    throughBlockNumber: window.throughBlockNumber,
    addresses: Object.freeze([address]),
    ...(input.read.kind === 'binding'
      ? { topic0: Object.freeze([REGISTRATION_TOPIC]), topic2: Object.freeze([topic(key)]) }
      : { topic1: Object.freeze([topic(key)]) }),
  });
  return Object.freeze({ ...base, query });
}

/** Detach immutable event values; evaluation never depends on row identity. */
export function createKnowledgeAssetReadSnapshot<K extends KnowledgeAssetReadKind>(
  plan: KnowledgeAssetSnapshotPlan<K>,
  rows: readonly ChainEventLogRow[],
  ownWriteHash?: string,
): KnowledgeAssetReadSnapshot<K> {
  return Object.freeze({ plan, ownWriteHash, rows: Object.freeze(rows.map((row) => Object.freeze({
    ...row, topics: Object.freeze([...row.topics]),
  }))) });
}

/** Canonical coverage, finality, own-write and ordinal evaluation; no store facade. */
export async function evaluateKnowledgeAssetSnapshot<K extends KnowledgeAssetReadKind>(
  snapshot: KnowledgeAssetReadSnapshot<K>,
  registry: ChainEventDecoderRegistry,
  controls: KnowledgeAssetSnapshotEvaluationOptions = {},
): Promise<KnowledgeAssetSnapshotResult<K> | undefined> {
  const { plan } = snapshot;
  const now = controls.now ?? (() => Date.now());
  controls.signal?.throwIfAborted();
  if (!ownWriteMatches(snapshot)) return undefined;
  const firstWindow = windowFor(plan, plan.read.kind === 'binding'
    ? 'context-graph-ka' : 'context-graph-authority', now());
  if (firstWindow === undefined || (plan.read.kind !== 'binding' && !firstWindow.caughtUp)) return undefined;
  const rows = snapshot.rows.filter((row) => row.address === plan.contextGraphStorageAddress
    && row.blockNumber >= plan.query.fromBlockNumber && row.blockNumber <= plan.query.throughBlockNumber
    && (plan.options.view === 'latest' || row.settled));
  const registrations: ContextGraphKaRegistration[] = [];
  const authority: RawContextGraphAuthorityIndexEvent[] = [];
  for (let offset = 0; offset < rows.length; offset += 128) {
    controls.signal?.throwIfAborted();
    const batch = rows.slice(offset, offset + 128);
    registrations.push(...registry.decodeContextGraphKaRegistrations(batch));
    if (plan.read.kind !== 'binding') authority.push(...registry.decodeContextGraphAuthority(batch));
    if (offset + 128 < rows.length) {
      await controls.yieldBetweenBatches?.({ decodedRows: offset + 128, totalRows: rows.length });
    }
  }
  controls.signal?.throwIfAborted();
  // Freshness can expire during a cooperative decode, even without a new write.
  if (windowFor(plan, plan.read.kind === 'binding' ? 'context-graph-ka'
    : 'context-graph-authority', now()) === undefined) return undefined;
  const graphList = (contextGraphId: bigint): ContextGraphKaList | undefined => {
    const created = authority.find((entry) => entry.name === 'ContextGraphCreated'
      && entry.contextGraphId === contextGraphId
      && normalizeChainEventLogBlockNumber(entry.blockNumber) !== undefined);
    if (created === undefined) return undefined;
    const createdBlock = normalizeChainEventLogBlockNumber(created.blockNumber)!;
    const kaWindow = windowFor(plan, 'context-graph-ka', now(), createdBlock);
    if (kaWindow === undefined || !kaWindow.caughtUp) return undefined;
    const throughBlockNumber = Math.min(firstWindow.throughBlockNumber, kaWindow.throughBlockNumber);
    const fold = reduceContextGraphKaRegistrations(registrations.filter((entry) =>
      entry.blockNumber >= createdBlock && entry.blockNumber <= throughBlockNumber));
    return Object.freeze({ contextGraphId,
      kaIds: fold.listsByContextGraph.get(contextGraphId.toString())?.kaIds ?? Object.freeze([]), throughBlockNumber });
  };
  const evaluate: { [P in KnowledgeAssetReadKind]:
    (args: KnowledgeAssetSnapshotRead<P>['args']) => KnowledgeAssetResultByKind[P] | undefined } = {
    binding: ({ kaId }) => {
      const registration = registrations.find((entry) => entry.kaId === kaId);
      return registration === undefined ? undefined : Object.freeze({ kind: 'bound',
        contextGraphId: registration.contextGraphId, asOfBlockNumber: firstWindow.throughBlockNumber });
    },
    list: ({ contextGraphId }) => graphList(contextGraphId),
    ordinal: ({ contextGraphId, index }) => {
      const list = graphList(contextGraphId);
      return list === undefined || index >= BigInt(list.kaIds.length) ? undefined : Object.freeze({
        kaId: list.kaIds[Number(index)], asOfBlockNumber: list.throughBlockNumber,
      });
    },
  };
  return evaluate[plan.read.kind](plan.read.args);
}
