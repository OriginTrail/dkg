// SPDX-License-Identifier: Apache-2.0

/**
 * Historical Context Graph discovery by ContextGraphStorage id enumeration.
 *
 * The chain event poller only tails new `ContextGraphCreated` events, and the
 * `NameClaimed` scan it relied on for history reads the archived
 * ContextGraphNameRegistry, which neither mainnet registers in its Hub. A fresh
 * node therefore never learned about any Context Graph created before it
 * booted. ContextGraphStorage mints sequential ids, so this module walks
 * `1..getLatestContextGraphId()` with view calls instead, through the chain
 * adapter's stateless `readContextGraphStorageRange`.
 *
 * State is one durable checkpoint holding BOTH the cursor (next id to read)
 * and the chain facts of every id below it, saved atomically after each page
 * has been applied. That pairing is what makes a restart resume from the
 * cursor: discovered rows are process-local, so boot re-stages them from the
 * saved facts without any chain read (or, when boot could not read the store,
 * the next pass does before reading on), and only ids at or above the cursor
 * are read again.
 *
 * A second, independent frontier re-reads `[1, cursor)` at most once per
 * `minimumIntervalMs` so the mutable facts (active flag, owner, publish
 * policy) do not go stale.
 */

import type {
  ContextGraphStorageEntry,
  ContextGraphStorageRange,
} from '@origintrail-official/dkg-chain';
import { NO_NAME_COMMITMENT } from './context-graph-claim-proof.js';

/** Ids read per durable page (one checkpoint save per page). */
export const CONTEXT_GRAPH_STORAGE_DISCOVERY_PAGE_SIZE = 16;

/**
 * Ids one discovery or refresh pass may read. Both mainnets hold fewer than
 * this many Context Graphs, so a fresh node lists all of them on its first
 * pass; a larger chain converges over several passes.
 */
export const CONTEXT_GRAPH_STORAGE_DISCOVERY_ID_BUDGET = 128;

/** Default spacing between two completed refresh generations: one day. */
export const CONTEXT_GRAPH_STORAGE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const CHECKPOINT_VERSION = 1;
const DECIMAL_ID = /^[1-9][0-9]*$/;
const LOWER_ADDRESS = /^0x[0-9a-f]{40}$/;
const LOWER_BYTES32 = /^0x[0-9a-f]{64}$/;

/**
 * Durable home of the storage discovery checkpoint. The value is opaque to the
 * store; this module owns its codec. `save` must replace the previous value
 * atomically. Implementations are scoped to one chain deployment.
 */
export interface ContextGraphStorageDiscoveryStore {
  load(): Promise<unknown>;
  save(checkpoint: unknown): Promise<void>;
}

/** Process-local store used when the host provides no durable one. */
export function createInMemoryContextGraphStorageDiscoveryStore(): ContextGraphStorageDiscoveryStore {
  let value: unknown;
  return {
    load: async () => (value === undefined ? undefined : structuredClone(value)),
    save: async (checkpoint) => {
      value = structuredClone(checkpoint);
    },
  };
}

/** One enumerated slot plus the anchor block it was read at. */
export interface ContextGraphStorageDiscoveryRecord extends ContextGraphStorageEntry {
  readonly observedAtBlock: number;
}

/** What applying one record changed on the node. */
export interface ContextGraphStorageDiscoveryApplyResult {
  /** The on-chain id was not known to this node before. */
  readonly isNew: boolean;
  /** Any recorded fact for the id changed. */
  readonly changed: boolean;
}

/** Where an applied record came from: a chain read, or the durable checkpoint. */
export type ContextGraphStorageDiscoveryRecordOrigin = 'read' | 'checkpoint';

export interface ContextGraphStorageDiscoveryOptions {
  readonly store: ContextGraphStorageDiscoveryStore;
  readonly readRange: (
    fromId: bigint,
    maxIds: number,
    signal?: AbortSignal,
  ) => Promise<ContextGraphStorageRange>;
  /**
   * Apply one record through the node's shared discovery path: `'read'` for a
   * record a pass just read from chain, `'checkpoint'` for one restored from
   * the durable checkpoint.
   */
  readonly apply: (
    record: ContextGraphStorageDiscoveryRecord,
    origin: ContextGraphStorageDiscoveryRecordOrigin,
  ) => ContextGraphStorageDiscoveryApplyResult | Promise<ContextGraphStorageDiscoveryApplyResult>;
  readonly log?: (message: string) => void;
  readonly pageSize?: number;
  readonly now?: () => number;
}

export interface ContextGraphStorageDiscoveryPassResult {
  /** On-chain ids this pass made known to the node. */
  readonly discovered: number;
  /** Ids whose recorded facts changed in this pass. */
  readonly changed: number;
  /** Ids read from chain in this pass. */
  readonly read: number;
  /** The pass reached its frontier's end (the latest id, or the cursor for a refresh). */
  readonly complete: boolean;
  /** False when a refresh was not due yet and read nothing. */
  readonly due: boolean;
  /** Durable cursor after the pass: the next id discovery will read. */
  readonly nextId: bigint;
  /** `getLatestContextGraphId()` at the last anchor read in this pass. */
  readonly latestId?: bigint;
  /**
   * Checkpoint records this call restored before the pass, because no earlier
   * restore had succeeded (see {@link ContextGraphStorageDiscovery.restore}).
   */
  readonly restored: number;
}

interface CheckpointV1 {
  readonly storageAddress: string | null;
  readonly nextId: bigint;
  readonly refreshNextId: bigint | null;
  readonly lastRefreshAt: number | null;
  readonly entries: ReadonlyMap<string, ContextGraphStorageDiscoveryRecord>;
}

const EMPTY_CHECKPOINT: CheckpointV1 = Object.freeze({
  storageAddress: null,
  nextId: 1n,
  refreshNextId: null,
  lastRefreshAt: null,
  entries: new Map(),
});

export class ContextGraphStorageDiscovery {
  private checkpoint: CheckpointV1 | undefined;
  private loading: Promise<CheckpointV1> | undefined;
  /** Serializes passes: both frontiers rewrite the one checkpoint. */
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pageSize: number;
  private readonly now: () => number;
  /** The checkpoint's records have been applied in this process. */
  private restored = false;

  constructor(private readonly options: ContextGraphStorageDiscoveryOptions) {
    const pageSize = options.pageSize ?? CONTEXT_GRAPH_STORAGE_DISCOVERY_PAGE_SIZE;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new RangeError('Context Graph storage discovery page size must be a positive integer');
    }
    this.pageSize = pageSize;
    this.now = options.now ?? Date.now;
  }

  /**
   * Apply every record saved below the durable cursor, as `'checkpoint'`, once
   * per process. Reads the store only; never the chain. Returns the number of
   * records this call applied, 0 once an earlier call succeeded.
   *
   * The cursor stops discovery from re-reading the ids below it, so these
   * records are the only way their graphs come back after a restart. Every
   * discovery and refresh pass therefore restores first: a restore that
   * failed at boot (a store briefly unreadable) is retried by the next pass
   * rather than leaving those graphs unlisted until a refresh generation.
   */
  restore(): Promise<number> {
    return this.serialize(() => this.restoreOnce());
  }

  /** The durable cursor: the next id discovery will read. */
  async cursor(): Promise<bigint> {
    return (await this.load()).nextId;
  }

  /** Read new ids from the durable cursor, at most `idBudget` of them. */
  discover(options: { idBudget?: number; signal?: AbortSignal } = {}): Promise<ContextGraphStorageDiscoveryPassResult> {
    return this.serialize(() => this.runDiscover(options));
  }

  /**
   * Re-read `[1, cursor)` to refresh mutable facts. A new generation starts at
   * most once per `minimumIntervalMs`; an unfinished one resumes on every call.
   */
  refresh(options: {
    idBudget?: number;
    minimumIntervalMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<ContextGraphStorageDiscoveryPassResult> {
    return this.serialize(() => this.runRefresh(options));
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async restoreOnce(): Promise<number> {
    if (this.restored) return 0;
    const checkpoint = await this.load();
    for (const record of checkpoint.entries.values()) {
      await this.options.apply(record, 'checkpoint');
    }
    this.restored = true;
    return checkpoint.entries.size;
  }

  private async runDiscover(options: {
    idBudget?: number;
    signal?: AbortSignal;
  }): Promise<ContextGraphStorageDiscoveryPassResult> {
    const { signal } = options;
    let remaining = normalizeBudget(options.idBudget);
    const restored = await this.restoreOnce();
    let checkpoint = await this.load();
    let discovered = 0;
    let changed = 0;
    let read = 0;
    let complete = false;
    let latestId: bigint | undefined;
    while (remaining > 0) {
      signal?.throwIfAborted();
      const fromId = checkpoint.nextId;
      const range = await this.options.readRange(fromId, Math.min(this.pageSize, remaining), signal);
      latestId = range.latestId;
      const bound = this.bindStorage(checkpoint, range.storageAddress);
      if (bound.reset) {
        // This range was read from the old contract's cursor; drop it and
        // enumerate the new contract from id 1.
        checkpoint = await this.commit(bound.checkpoint, signal);
        continue;
      }
      checkpoint = bound.checkpoint;
      const readCount = Number(range.nextId - fromId);
      if (readCount <= 0) {
        complete = range.latestId < fromId;
        if (!complete) {
          this.options.log?.(
            `Context Graph storage discovery: id ${fromId} is not readable yet at block `
            + `${range.anchorBlockNumber} (latest id ${range.latestId}); retrying on the next pass`,
          );
        }
        break;
      }
      const applied = await this.applyRange(range, signal);
      discovered += applied.discovered;
      changed += applied.changed;
      checkpoint = await this.commit({
        ...checkpoint,
        nextId: range.nextId,
        // A new catalog is fresh as of its first page; the first refresh is
        // due one interval later, not immediately after the initial pass.
        lastRefreshAt: checkpoint.lastRefreshAt ?? this.now(),
        entries: mergeRecords(checkpoint.entries, applied.records),
      }, signal);
      read += readCount;
      remaining -= readCount;
      if (range.nextId > range.latestId) {
        complete = true;
        break;
      }
    }
    return Object.freeze({
      discovered,
      changed,
      read,
      complete,
      due: true,
      nextId: checkpoint.nextId,
      ...(latestId === undefined ? {} : { latestId }),
      restored,
    });
  }

  private async runRefresh(options: {
    idBudget?: number;
    minimumIntervalMs?: number;
    signal?: AbortSignal;
  }): Promise<ContextGraphStorageDiscoveryPassResult> {
    const { signal } = options;
    let remaining = normalizeBudget(options.idBudget);
    const minimumIntervalMs = options.minimumIntervalMs ?? CONTEXT_GRAPH_STORAGE_REFRESH_INTERVAL_MS;
    const restored = await this.restoreOnce();
    let checkpoint = await this.load();
    const notDue = (): ContextGraphStorageDiscoveryPassResult => Object.freeze({
      discovered: 0,
      changed: 0,
      read: 0,
      complete: false,
      due: false,
      nextId: checkpoint.nextId,
      restored,
    });
    if (checkpoint.nextId <= 1n) return notDue();
    if (checkpoint.refreshNextId === null) {
      if (
        checkpoint.lastRefreshAt !== null
        && this.now() - checkpoint.lastRefreshAt < minimumIntervalMs
      ) {
        return notDue();
      }
      checkpoint = { ...checkpoint, refreshNextId: 1n };
    }

    let discovered = 0;
    let changed = 0;
    let read = 0;
    let complete = false;
    let latestId: bigint | undefined;
    while (remaining > 0 && checkpoint.refreshNextId !== null) {
      signal?.throwIfAborted();
      const fromId: bigint = checkpoint.refreshNextId;
      if (fromId >= checkpoint.nextId) {
        complete = true;
        break;
      }
      const span = Number(checkpoint.nextId - fromId);
      const range = await this.options.readRange(
        fromId,
        Math.min(this.pageSize, remaining, span),
        signal,
      );
      latestId = range.latestId;
      const bound = this.bindStorage(checkpoint, range.storageAddress);
      if (bound.reset) {
        // Nothing to refresh on a new contract; discovery re-enumerates it.
        checkpoint = await this.commit(bound.checkpoint, signal);
        break;
      }
      checkpoint = bound.checkpoint;
      const readCount = Number(range.nextId - fromId);
      if (readCount <= 0) break;
      const applied = await this.applyRange(range, signal);
      discovered += applied.discovered;
      changed += applied.changed;
      checkpoint = await this.commit({
        ...checkpoint,
        refreshNextId: range.nextId,
        entries: mergeRecords(checkpoint.entries, applied.records),
      }, signal);
      read += readCount;
      remaining -= readCount;
    }
    if (complete || (checkpoint.refreshNextId !== null && checkpoint.refreshNextId >= checkpoint.nextId)) {
      complete = true;
      checkpoint = await this.commit({
        ...checkpoint,
        refreshNextId: null,
        lastRefreshAt: this.now(),
      }, signal);
    }
    return Object.freeze({
      discovered,
      changed,
      read,
      complete,
      due: true,
      nextId: checkpoint.nextId,
      ...(latestId === undefined ? {} : { latestId }),
      restored,
    });
  }

  private async applyRange(
    range: ContextGraphStorageRange,
    signal?: AbortSignal,
  ): Promise<{ discovered: number; changed: number; records: ContextGraphStorageDiscoveryRecord[] }> {
    let discovered = 0;
    let changed = 0;
    const records: ContextGraphStorageDiscoveryRecord[] = [];
    for (const entry of range.entries) {
      signal?.throwIfAborted();
      const record = Object.freeze({ ...entry, observedAtBlock: range.anchorBlockNumber });
      const result = await this.options.apply(record, 'read');
      if (result.isNew) discovered += 1;
      if (result.changed) changed += 1;
      records.push(record);
    }
    // Cancellation after local work leaves the page unsaved on purpose: the
    // next pass replays it, and applying a record twice is a no-op.
    signal?.throwIfAborted();
    return { discovered, changed, records };
  }

  /**
   * A checkpoint belongs to one ContextGraphStorage contract. The host scopes
   * the store by chain deployment, so a different address means the binding
   * moved under the same scope; start over rather than mix two id spaces.
   */
  private bindStorage(
    checkpoint: CheckpointV1,
    storageAddress: string,
  ): { checkpoint: CheckpointV1; reset: boolean } {
    const address = storageAddress.toLowerCase();
    if (checkpoint.storageAddress === null) {
      return { checkpoint: { ...checkpoint, storageAddress: address }, reset: false };
    }
    if (checkpoint.storageAddress === address) return { checkpoint, reset: false };
    this.options.log?.(
      `Context Graph storage discovery: ContextGraphStorage moved from ${checkpoint.storageAddress} `
      + `to ${address}; restarting enumeration from id 1`,
    );
    return { checkpoint: { ...EMPTY_CHECKPOINT, storageAddress: address }, reset: true };
  }

  /** Store first, then memory: memory never runs ahead of durable state. */
  private async commit(next: CheckpointV1, signal?: AbortSignal): Promise<CheckpointV1> {
    signal?.throwIfAborted();
    await this.options.store.save(encodeCheckpoint(next));
    this.checkpoint = next;
    return next;
  }

  private load(): Promise<CheckpointV1> {
    if (this.checkpoint) return Promise.resolve(this.checkpoint);
    if (!this.loading) {
      this.loading = (async () => {
        const raw = await this.options.store.load();
        const decoded = raw === undefined || raw === null ? EMPTY_CHECKPOINT : decodeCheckpoint(raw);
        if (decoded === undefined) {
          this.options.log?.(
            'Context Graph storage discovery: ignoring an unreadable checkpoint; enumerating from id 1',
          );
        }
        this.checkpoint = decoded ?? EMPTY_CHECKPOINT;
        return this.checkpoint;
      })().finally(() => {
        // A failed load is not evidence that no checkpoint exists; retry it.
        this.loading = undefined;
      });
    }
    return this.loading;
  }
}

function normalizeBudget(value: number | undefined): number {
  if (value === undefined) return CONTEXT_GRAPH_STORAGE_DISCOVERY_ID_BUDGET;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('Context Graph storage discovery idBudget must be a positive integer');
  }
  return value;
}

function mergeRecords(
  current: ReadonlyMap<string, ContextGraphStorageDiscoveryRecord>,
  incoming: readonly ContextGraphStorageDiscoveryRecord[],
): ReadonlyMap<string, ContextGraphStorageDiscoveryRecord> {
  if (incoming.length === 0) return current;
  const merged = new Map(current);
  for (const record of incoming) {
    const existing = merged.get(record.contextGraphId);
    if (existing === undefined || existing.observedAtBlock <= record.observedAtBlock) {
      merged.set(record.contextGraphId, record);
    }
  }
  return merged;
}

function encodeCheckpoint(checkpoint: CheckpointV1): unknown {
  return {
    version: CHECKPOINT_VERSION,
    storageAddress: checkpoint.storageAddress,
    nextId: checkpoint.nextId.toString(10),
    refreshNextId: checkpoint.refreshNextId === null ? null : checkpoint.refreshNextId.toString(10),
    lastRefreshAt: checkpoint.lastRefreshAt,
    entries: [...checkpoint.entries.values()]
      .sort((a, b) => compareDecimalIds(a.contextGraphId, b.contextGraphId))
      .map((record) => ({
        contextGraphId: record.contextGraphId,
        owner: record.owner,
        active: record.active,
        createdAt: record.createdAt,
        accessPolicy: record.accessPolicy,
        publishPolicy: record.publishPolicy,
        publishAuthority: record.publishAuthority,
        nameHash: record.nameHash,
        observedAtBlock: record.observedAtBlock,
      })),
  };
}

/** Strict decoder: anything malformed yields `undefined` (enumerate afresh). */
function decodeCheckpoint(raw: unknown): CheckpointV1 | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== CHECKPOINT_VERSION) return undefined;
  const storageAddress = value.storageAddress;
  if (storageAddress !== null && (typeof storageAddress !== 'string' || !LOWER_ADDRESS.test(storageAddress))) {
    return undefined;
  }
  if (typeof value.nextId !== 'string' || !DECIMAL_ID.test(value.nextId)) return undefined;
  const nextId = BigInt(value.nextId);
  let refreshNextId: bigint | null = null;
  if (value.refreshNextId !== null) {
    if (typeof value.refreshNextId !== 'string' || !DECIMAL_ID.test(value.refreshNextId)) return undefined;
    refreshNextId = BigInt(value.refreshNextId);
  }
  const lastRefreshAt = value.lastRefreshAt;
  if (lastRefreshAt !== null && !isNonNegativeSafeInteger(lastRefreshAt)) return undefined;
  if (!Array.isArray(value.entries)) return undefined;
  const entries = new Map<string, ContextGraphStorageDiscoveryRecord>();
  for (const candidate of value.entries) {
    const record = decodeRecord(candidate);
    if (record === undefined) return undefined;
    // Facts never exist beyond the cursor; ignore any that do.
    if (BigInt(record.contextGraphId) >= nextId) continue;
    entries.set(record.contextGraphId, record);
  }
  return Object.freeze({
    storageAddress: storageAddress as string | null,
    nextId,
    refreshNextId,
    lastRefreshAt: lastRefreshAt as number | null,
    entries,
  });
}

function decodeRecord(candidate: unknown): ContextGraphStorageDiscoveryRecord | undefined {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const r = candidate as Record<string, unknown>;
  if (typeof r.contextGraphId !== 'string' || !DECIMAL_ID.test(r.contextGraphId)) return undefined;
  if (typeof r.owner !== 'string' || !LOWER_ADDRESS.test(r.owner)) return undefined;
  if (typeof r.active !== 'boolean') return undefined;
  if (!isNonNegativeSafeInteger(r.createdAt)) return undefined;
  if (!isUint8(r.accessPolicy) || !isUint8(r.publishPolicy)) return undefined;
  if (r.publishAuthority !== null
    && (typeof r.publishAuthority !== 'string' || !LOWER_ADDRESS.test(r.publishAuthority))) {
    return undefined;
  }
  if (r.nameHash !== null && (typeof r.nameHash !== 'string' || !LOWER_BYTES32.test(r.nameHash))) {
    return undefined;
  }
  if (!isNonNegativeSafeInteger(r.observedAtBlock)) return undefined;
  return Object.freeze({
    contextGraphId: r.contextGraphId,
    owner: r.owner,
    active: r.active,
    createdAt: r.createdAt as number,
    accessPolicy: r.accessPolicy as number,
    publishPolicy: r.publishPolicy as number,
    publishAuthority: r.publishAuthority as string | null,
    nameHash: r.nameHash as string | null,
    observedAtBlock: r.observedAtBlock as number,
  });
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isUint8(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value <= 255;
}

function compareDecimalIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ----- Chain facts the node keeps per on-chain Context Graph -----

/**
 * One chain observation of a Context Graph, as the shared discovery path takes
 * it. The live `ContextGraphCreated` event carries owner, policies and name
 * hash; a ContextGraphStorage read adds the creation time, active flag and
 * publish authority. A ContextGraphStorageDiscoveryRecord is one as it stands.
 */
export interface OnChainContextGraphObservation {
  /** Positive decimal ContextGraphStorage id. */
  readonly contextGraphId: string;
  readonly owner?: string | null;
  readonly accessPolicy: number;
  readonly publishPolicy?: number | null;
  /**
   * Storage reads only: null when the read found no authority. Omitted when
   * the observation did not read it, which keeps any authority read before.
   */
  readonly publishAuthority?: string | null;
  /** Curator-committed name hash, or null when the curator opted out. */
  readonly nameHash: string | null;
  /** Event block, or the anchor block of the storage read. */
  readonly observedAtBlock: number;
  /** Unix seconds (storage reads only). */
  readonly createdAt?: number;
  /** Storage reads only. */
  readonly active?: boolean;
}

/**
 * One ContextGraphStorage entry as an observation at the block it was read
 * at, for the on-demand read of a single id. Enumeration and checkpoint
 * records already carry `observedAtBlock` and are applied as they are.
 */
export function contextGraphStorageObservation(
  entry: ContextGraphStorageEntry,
  blockNumber: number,
): OnChainContextGraphObservation {
  return {
    contextGraphId: entry.contextGraphId,
    owner: entry.owner,
    accessPolicy: entry.accessPolicy,
    publishPolicy: entry.publishPolicy,
    publishAuthority: entry.publishAuthority,
    nameHash: entry.nameHash,
    observedAtBlock: blockNumber,
    createdAt: entry.createdAt,
    active: entry.active,
  };
}

/**
 * Chain-public facts for one on-chain Context Graph, merged from every
 * observation the node made: the live `ContextGraphCreated` event and
 * ContextGraphStorage enumeration. Null means "not observed yet", never zero.
 */
export interface OnChainContextGraphFacts {
  /** Positive decimal ContextGraphStorage id. */
  readonly onChainId: string;
  readonly nameHash: string | null;
  /** Current ERC-721 owner, lowercase (the creator unless ownership was transferred). */
  readonly owner: string | null;
  readonly accessPolicy: number | null;
  readonly publishPolicy: number | null;
  readonly publishAuthority: string | null;
  /** Unix seconds; only ContextGraphStorage reads carry it. */
  readonly createdAt: number | null;
  readonly active: boolean | null;
  /** Block of the newest observation merged into these facts. */
  readonly observedAtBlock: number;
}

/**
 * The facts one observation carries, before they are merged. Identical to
 * OnChainContextGraphFacts except for `publishAuthority`: `undefined` when the
 * observation did not read it (the live `ContextGraphCreated` event carries the
 * publish policy, never the authority), as opposed to `null`, a read that found
 * none.
 */
export type ObservedOnChainContextGraphFacts = Omit<OnChainContextGraphFacts, 'publishAuthority'> & {
  readonly publishAuthority: string | null | undefined;
};

/**
 * The name hash an observation commits, lowercase, or null for an opt-out:
 * absent, empty, or bytes32(0). Enumeration already reads bytes32(0) as null;
 * the live `ContextGraphCreated` event forwards the raw zero word.
 */
function committedObservationNameHash(nameHash: unknown): string | null {
  if (typeof nameHash !== 'string' || nameHash.length === 0) return null;
  const lower = nameHash.toLowerCase();
  return lower === NO_NAME_COMMITMENT ? null : lower;
}

/**
 * Normalize one observation into facts: lowercase addresses and hash, an empty
 * or zero name hash as an opt-out, and null for every field the observation
 * does not carry. An authority counts as read only alongside its publish
 * policy.
 */
export function onChainContextGraphFactsFromObservation(
  observation: OnChainContextGraphObservation,
): ObservedOnChainContextGraphFacts {
  const publishPolicy = observation.publishPolicy ?? null;
  return {
    onChainId: observation.contextGraphId,
    nameHash: committedObservationNameHash(observation.nameHash),
    owner: observation.owner ? observation.owner.toLowerCase() : null,
    accessPolicy: Number.isSafeInteger(observation.accessPolicy) ? observation.accessPolicy : null,
    publishPolicy,
    publishAuthority: publishPolicy === null || observation.publishAuthority === undefined
      ? undefined
      : observation.publishAuthority?.toLowerCase() ?? null,
    createdAt: observation.createdAt ?? null,
    active: observation.active ?? null,
    observedAtBlock: observation.observedAtBlock,
  };
}

/**
 * Merge one observation into the facts already known. The newer observation
 * (by block) wins field by field; a field it does not carry keeps the older
 * value. `nameHash`, `accessPolicy` and `createdAt` are write-once on chain,
 * so a disagreement there means the id now names a different graph (a reorg
 * replaced the slot) and the newer observation replaces the facts outright.
 */
export function mergeOnChainContextGraphFacts(
  current: OnChainContextGraphFacts | undefined,
  incoming: ObservedOnChainContextGraphFacts,
): OnChainContextGraphFacts {
  if (current === undefined) return settledOnChainContextGraphFacts(incoming);
  const [older, newer]: readonly [ObservedOnChainContextGraphFacts, ObservedOnChainContextGraphFacts] =
    current.observedAtBlock <= incoming.observedAtBlock ? [current, incoming] : [incoming, current];
  if (onChainContextGraphIdentityDiffers(older, newer)) return settledOnChainContextGraphFacts(newer);
  return Object.freeze({
    onChainId: newer.onChainId,
    nameHash: newer.nameHash ?? older.nameHash,
    owner: newer.owner ?? older.owner,
    accessPolicy: newer.accessPolicy ?? older.accessPolicy,
    publishPolicy: newer.publishPolicy ?? older.publishPolicy,
    publishAuthority: mergedPublishAuthority(older, newer),
    createdAt: newer.createdAt ?? older.createdAt,
    active: newer.active ?? older.active,
    observedAtBlock: newer.observedAtBlock,
  });
}

/**
 * The newer observation's authority when it read one alongside its policy,
 * including a read that found none (a curated graph turned open). Otherwise
 * the older reading stands, unless the newer observation reports a different
 * publish policy: an authority read under another policy says nothing about
 * this one.
 */
function mergedPublishAuthority(
  older: ObservedOnChainContextGraphFacts,
  newer: ObservedOnChainContextGraphFacts,
): string | null {
  if (newer.publishAuthority !== undefined && newer.publishPolicy !== null) {
    return newer.publishAuthority;
  }
  if (newer.publishPolicy !== null && newer.publishPolicy !== older.publishPolicy) return null;
  return older.publishAuthority ?? null;
}

/** Facts as the node keeps them: an authority not read yet is null. */
function settledOnChainContextGraphFacts(
  facts: ObservedOnChainContextGraphFacts,
): OnChainContextGraphFacts {
  return Object.freeze({ ...facts, publishAuthority: facts.publishAuthority ?? null });
}

/** True when two observations of one id disagree on a write-once field. */
export function onChainContextGraphIdentityDiffers(
  a: ObservedOnChainContextGraphFacts,
  b: ObservedOnChainContextGraphFacts,
): boolean {
  const differs = <T>(x: T | null, y: T | null) => x !== null && y !== null && x !== y;
  return differs(a.nameHash, b.nameHash)
    || differs(a.accessPolicy, b.accessPolicy)
    || differs(a.createdAt, b.createdAt);
}

export function sameOnChainContextGraphFacts(
  a: OnChainContextGraphFacts | undefined,
  b: OnChainContextGraphFacts,
): boolean {
  return a !== undefined
    && a.nameHash === b.nameHash
    && a.owner === b.owner
    && a.accessPolicy === b.accessPolicy
    && a.publishPolicy === b.publishPolicy
    && a.publishAuthority === b.publishAuthority
    && a.createdAt === b.createdAt
    && a.active === b.active;
}
