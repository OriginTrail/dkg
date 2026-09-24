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

type SnapshotWindowContext = Omit<KnowledgeAssetSnapshotPlan, 'query' | 'read'>;

interface SnapshotCoveragePolicy {
  readonly family: 'context-graph-ka' | 'context-graph-authority';
  readonly requireCaughtUp: boolean;
}

const REGISTRATION_TOPIC = id('KnowledgeAssetRegisteredToContextGraph(uint256,uint256)');
const UINT256_LIMIT = 1n << 256n;
const topic = (value: bigint): string => `0x${value.toString(16).padStart(64, '0')}`;

function windowFor(
  plan: SnapshotWindowContext,
  policy: SnapshotCoveragePolicy,
  nowMs: number,
  requiredFrom?: number,
) {
  const { state, options, contextGraphStorageAddress: address, maxHeadAgeMs } = plan;
  if (chainEventLogStateReadRefusal(state, maxHeadAgeMs === undefined ? {}
    : { nowMs, maxHeadAgeMs }) !== undefined) return undefined;
  const coverage = findChainEventLogCoverage(state.coverage, policy.family, address);
  if (coverage === undefined) return undefined;
  const target = options.view === 'latest' ? state.cursor.head.number : state.cursor.settledBlockNumber;
  if (policy.requireCaughtUp && coverage.coveredThroughBlock < target) return undefined;
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

interface DecodedSnapshot {
  readonly registrations: ContextGraphKaRegistration[];
  readonly authority: RawContextGraphAuthorityIndexEvent[];
}

interface SnapshotProjectionContext {
  readonly plan: SnapshotWindowContext;
  readonly window: NonNullable<ReturnType<typeof windowFor>>;
  readonly decoded: DecodedSnapshot;
  readonly now: () => number;
}

type SnapshotTopics = Pick<ChainEventLogQuery, 'topic0' | 'topic1' | 'topic2'>;

interface SnapshotOperation<K extends KnowledgeAssetReadKind> {
  readonly coverage: SnapshotCoveragePolicy;
  readonly select: (args: KnowledgeAssetSnapshotRead<K>['args']) => SnapshotTopics | undefined;
  readonly decode: (registry: ChainEventDecoderRegistry, rows: readonly ChainEventLogRow[], into: DecodedSnapshot) => void;
  readonly project: (args: KnowledgeAssetSnapshotRead<K>['args'], context: SnapshotProjectionContext) =>
    KnowledgeAssetResultByKind[K] | undefined;
}

/** Every operation must explicitly supply all selection and evaluation semantics. */
export type KnowledgeAssetSnapshotOperationTable = {
  readonly [K in KnowledgeAssetReadKind]: SnapshotOperation<K>;
};

function graphTopics(contextGraphId: bigint): SnapshotTopics | undefined {
  return contextGraphId < 0n || contextGraphId >= UINT256_LIMIT ? undefined
    : { topic1: Object.freeze([topic(contextGraphId)]) };
}

function decodeRegistrations(
  registry: ChainEventDecoderRegistry,
  rows: readonly ChainEventLogRow[],
  into: DecodedSnapshot,
): void {
  into.registrations.push(...registry.decodeContextGraphKaRegistrations(rows));
}

function decodeGraphHistory(
  registry: ChainEventDecoderRegistry,
  rows: readonly ChainEventLogRow[],
  into: DecodedSnapshot,
): void {
  decodeRegistrations(registry, rows, into);
  into.authority.push(...registry.decodeContextGraphAuthority(rows));
}

/** Complete graph projections need KA coverage from the witnessed creation. */
function graphListFromCreation(
  contextGraphId: bigint,
  context: SnapshotProjectionContext,
  registrationCoverage: SnapshotCoveragePolicy,
): ContextGraphKaList | undefined {
  const { plan, window, decoded, now } = context;
  const created = decoded.authority.find((entry) => entry.name === 'ContextGraphCreated'
    && entry.contextGraphId === contextGraphId
    && normalizeChainEventLogBlockNumber(entry.blockNumber) !== undefined);
  if (created === undefined) return undefined;
  const createdBlock = normalizeChainEventLogBlockNumber(created.blockNumber)!;
  const kaWindow = windowFor(plan, registrationCoverage, now(), createdBlock);
  if (kaWindow === undefined) return undefined;
  const throughBlockNumber = Math.min(window.throughBlockNumber, kaWindow.throughBlockNumber);
  const fold = reduceContextGraphKaRegistrations(decoded.registrations.filter((entry) =>
    entry.blockNumber >= createdBlock && entry.blockNumber <= throughBlockNumber));
  return Object.freeze({ contextGraphId,
    kaIds: fold.listsByContextGraph.get(contextGraphId.toString())?.kaIds ?? Object.freeze([]), throughBlockNumber });
}

// The sole operation dispatch table. Adding a kind without its own policy,
// query, decoder and correctly typed result projector is a compile error.
const operations: KnowledgeAssetSnapshotOperationTable = Object.freeze({
  binding: {
    coverage: { family: 'context-graph-ka', requireCaughtUp: false },
    select: ({ kaId }) => kaId < 0n || kaId >= UINT256_LIMIT ? undefined : {
      topic0: Object.freeze([REGISTRATION_TOPIC]), topic2: Object.freeze([topic(kaId)]),
    },
    decode: decodeRegistrations,
    project: ({ kaId }, { decoded, window }) => {
      const registration = decoded.registrations.find((entry) => entry.kaId === kaId);
      return registration === undefined ? undefined : Object.freeze({ kind: 'bound',
        contextGraphId: registration.contextGraphId, asOfBlockNumber: window.throughBlockNumber });
    },
  },
  list: {
    coverage: { family: 'context-graph-authority', requireCaughtUp: true },
    select: ({ contextGraphId }) => graphTopics(contextGraphId),
    decode: decodeGraphHistory,
    project: ({ contextGraphId }, context) => graphListFromCreation(contextGraphId, context,
      { family: 'context-graph-ka', requireCaughtUp: true }),
  },
  ordinal: {
    coverage: { family: 'context-graph-authority', requireCaughtUp: true },
    select: ({ contextGraphId, index }) => index < 0n ? undefined : graphTopics(contextGraphId),
    decode: decodeGraphHistory,
    project: ({ contextGraphId, index }, context) => {
      const list = graphListFromCreation(contextGraphId, context,
        { family: 'context-graph-ka', requireCaughtUp: true });
      return list === undefined || index >= BigInt(list.kaIds.length) ? undefined : Object.freeze({
        kaId: list.kaIds[Number(index)], asOfBlockNumber: list.throughBlockNumber,
      });
    },
  },
});

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
  const operation = operations[input.read.kind];
  const topics = operation.select(input.read.args);
  if (topics === undefined) return undefined;
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
  const window = windowFor(base, operation.coverage, input.nowMs ?? Date.now());
  if (window === undefined) return undefined;
  const query = Object.freeze({
    fromBlockNumber: window.fromBlockNumber,
    throughBlockNumber: window.throughBlockNumber,
    addresses: Object.freeze([address]),
    ...topics,
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
  const operation = operations[plan.read.kind];
  const window = windowFor(plan, operation.coverage, now());
  if (window === undefined) return undefined;
  const rows = snapshot.rows.filter((row) => row.address === plan.contextGraphStorageAddress
    && row.blockNumber >= plan.query.fromBlockNumber && row.blockNumber <= plan.query.throughBlockNumber
    && (plan.options.view === 'latest' || row.settled));
  const decoded: DecodedSnapshot = { registrations: [], authority: [] };
  for (let offset = 0; offset < rows.length; offset += 128) {
    controls.signal?.throwIfAborted();
    const batch = rows.slice(offset, offset + 128);
    operation.decode(registry, batch, decoded);
    if (offset + 128 < rows.length) {
      await controls.yieldBetweenBatches?.({ decodedRows: offset + 128, totalRows: rows.length });
    }
  }
  controls.signal?.throwIfAborted();
  // Freshness can expire during a cooperative decode, even without a new write.
  if (windowFor(plan, operation.coverage, now()) === undefined) return undefined;
  return operation.project(plan.read.args, { plan, window, decoded, now });
}
