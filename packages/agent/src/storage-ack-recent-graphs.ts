// SPDX-License-Identifier: Apache-2.0

/**
 * The graphs StorageACK requests reached recently, kept across restarts.
 *
 * A core keeps a saved subscription row for every graph it has discovered, and
 * after a restart the activation cap brings only a few of them back; the rest
 * are checked one at a time. A graph a publisher is writing to right now could
 * then be refused for as long as that backlog takes to reach it. This list
 * names the graphs ACK requests reached shortly before the restart, so the
 * startup pass brings their rows back first and outside the cap.
 *
 * It only orders work. A row on the list passes the same read-authority check
 * as any other before it activates, and a missing or unreadable file costs
 * nothing but the ordering.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createOperationContext } from '@origintrail-official/dkg-core';

export const STORAGE_ACK_RECENT_GRAPHS_FILE = 'storage-ack-recent-graphs.json';
/** Most graphs the list keeps; the least recently requested one makes room. */
export const STORAGE_ACK_RECENT_GRAPHS_MAX = 16;
/** A graph no ACK request reached for this long leaves the list. */
export const STORAGE_ACK_RECENT_GRAPH_TTL_MS = 24 * 60 * 60_000;
/** A saved request time this much older than a new request is written again. */
export const STORAGE_ACK_RECENT_GRAPH_REFRESH_MS = 60 * 60_000;
const MAX_FILE_BYTES = 64 * 1024;
const FILE_VERSION = 1;

export interface StorageAckRecentGraph {
  /** The local namespace the request was recorded under (the subscription row id). */
  readonly contextGraphId: string;
  /** The on-chain id the request named. */
  readonly onChainId: string;
  /** When an ACK request last reached it (ms since epoch). */
  readonly at: number;
}

export interface StorageAckRecentGraphsIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Remove a staged file a failed write left; a missing file is no error. */
  remove?(path: string): Promise<void>;
}

export interface StorageAckRecentGraphsOptions {
  /** File to keep the list in; without one the list lives only in memory. */
  readonly path?: string;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
  readonly maxGraphs?: number;
  readonly ttlMs?: number;
  readonly io?: StorageAckRecentGraphsIo;
}

const nodeIo: StorageAckRecentGraphsIo = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  rename: (from, to) => rename(from, to),
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
  remove: (path) => rm(path, { force: true }),
};

function isCanonicalId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value);
}

function parseEntries(text: string): StorageAckRecentGraph[] {
  const parsed = JSON.parse(text) as { version?: unknown; graphs?: unknown };
  if (parsed?.version !== FILE_VERSION || !Array.isArray(parsed.graphs)) return [];
  const entries: StorageAckRecentGraph[] = [];
  for (const raw of parsed.graphs as Array<Record<string, unknown>>) {
    if (
      raw === null || typeof raw !== 'object'
      || typeof raw.contextGraphId !== 'string' || raw.contextGraphId.length === 0
      || raw.contextGraphId.length > 1024
      || !isCanonicalId(raw.onChainId)
      || typeof raw.at !== 'number' || !Number.isFinite(raw.at)
    ) continue;
    entries.push({ contextGraphId: raw.contextGraphId, onChainId: raw.onChainId, at: raw.at });
  }
  return entries;
}

export class StorageAckRecentGraphs {
  readonly #path: string | undefined;
  readonly #now: () => number;
  readonly #warn: (message: string) => void;
  readonly #maxGraphs: number;
  readonly #ttlMs: number;
  readonly #io: StorageAckRecentGraphsIo;
  readonly #entries = new Map<string, StorageAckRecentGraph>();
  #loaded: Promise<void> | undefined;
  #writing: Promise<void> | undefined;
  #writeAgain = false;
  #warnedWrite = false;

  constructor(options: StorageAckRecentGraphsOptions = {}) {
    this.#path = options.path;
    this.#now = options.now ?? Date.now;
    this.#warn = options.warn ?? (() => undefined);
    this.#maxGraphs = options.maxGraphs ?? STORAGE_ACK_RECENT_GRAPHS_MAX;
    this.#ttlMs = options.ttlMs ?? STORAGE_ACK_RECENT_GRAPH_TTL_MS;
    this.#io = options.io ?? nodeIo;
  }

  /** Read the saved list once. Never rejects; an unreadable file is left out. */
  load(): Promise<void> {
    this.#loaded ??= this.#read();
    return this.#loaded;
  }

  /**
   * An ACK request reached this graph. Only a new graph, a changed id or a
   * saved time older than an hour is written, so a busy graph costs no I/O.
   */
  note(contextGraphId: string, onChainId: string): void {
    if (contextGraphId.length === 0 || !isCanonicalId(onChainId)) return;
    const now = this.#now();
    const saved = this.#entries.get(contextGraphId);
    const changed = saved === undefined
      || saved.onChainId !== onChainId
      || now - saved.at >= STORAGE_ACK_RECENT_GRAPH_REFRESH_MS;
    if (!changed) return;
    this.#entries.delete(contextGraphId);
    this.#entries.set(contextGraphId, { contextGraphId, onChainId, at: now });
    this.#trim(now);
    this.#scheduleWrite();
  }

  /** The graphs on the list, most recently requested first. */
  recent(): StorageAckRecentGraph[] {
    const now = this.#now();
    this.#trim(now);
    return [...this.#entries.values()].sort((a, b) => b.at - a.at
      || (a.contextGraphId < b.contextGraphId ? -1 : a.contextGraphId > b.contextGraphId ? 1 : 0));
  }

  /** Settles once every write asked for so far has finished. */
  async whenWritten(): Promise<void> {
    while (this.#writing !== undefined) await this.#writing;
  }

  #trim(now: number): void {
    for (const [id, entry] of this.#entries) {
      if (now - entry.at >= this.#ttlMs || entry.at > now + this.#ttlMs) this.#entries.delete(id);
    }
    if (this.#entries.size <= this.#maxGraphs) return;
    const oldestFirst = [...this.#entries.values()].sort((a, b) => a.at - b.at);
    for (const entry of oldestFirst.slice(0, this.#entries.size - this.#maxGraphs)) {
      this.#entries.delete(entry.contextGraphId);
    }
  }

  async #read(): Promise<void> {
    if (this.#path === undefined) return;
    let text: string;
    try {
      text = await this.#io.readFile(this.#path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.#warn(`Could not read the recently ACK-requested graphs: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (text.length > MAX_FILE_BYTES) {
      this.#warn('Ignoring the recently ACK-requested graphs: the file is too large');
      return;
    }
    let saved: StorageAckRecentGraph[];
    try {
      saved = parseEntries(text);
    } catch {
      this.#warn('Ignoring the recently ACK-requested graphs: the file is not valid JSON');
      return;
    }
    // A request noted before the file was read is newer than the file.
    for (const entry of saved) {
      const current = this.#entries.get(entry.contextGraphId);
      if (current === undefined || current.at < entry.at) this.#entries.set(entry.contextGraphId, entry);
    }
    this.#trim(this.#now());
  }

  #scheduleWrite(): void {
    if (this.#path === undefined) return;
    if (this.#writing !== undefined) {
      this.#writeAgain = true;
      return;
    }
    const writing = this.#writeLoop().finally(() => {
      if (this.#writing === writing) this.#writing = undefined;
    });
    this.#writing = writing;
  }

  async #writeLoop(): Promise<void> {
    // Merge the saved list first, so an early write cannot drop it.
    await this.load();
    do {
      this.#writeAgain = false;
      await this.#write();
    } while (this.#writeAgain);
  }

  async #write(): Promise<void> {
    const path = this.#path!;
    const graphs = this.recent();
    const staged = join(dirname(path), `.${STORAGE_ACK_RECENT_GRAPHS_FILE}.${randomUUID()}.tmp`);
    try {
      await this.#io.mkdir(dirname(path));
      await this.#io.writeFile(staged, `${JSON.stringify({ version: FILE_VERSION, graphs })}\n`);
      await this.#io.rename(staged, path);
      this.#warnedWrite = false;
    } catch (error) {
      await this.#io.remove?.(staged).catch(() => undefined);
      if (this.#warnedWrite) return;
      this.#warnedWrite = true;
      this.#warn(`Could not save the recently ACK-requested graphs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

interface RecentGraphsAgent {
  readonly config: { readonly dataDir?: string };
  readonly log: { warn(ctx: ReturnType<typeof createOperationContext>, message: string): void };
}

const lists = new WeakMap<object, StorageAckRecentGraphs>();

/** The agent's list, kept in its data directory when it has one. */
export function storageAckRecentGraphsOf(agentObject: object): StorageAckRecentGraphs {
  let list = lists.get(agentObject);
  if (list === undefined) {
    const agent = agentObject as RecentGraphsAgent;
    const dataDir = agent.config?.dataDir;
    list = new StorageAckRecentGraphs({
      ...(dataDir ? { path: join(dataDir, STORAGE_ACK_RECENT_GRAPHS_FILE) } : {}),
      warn: (message) => agent.log?.warn(createOperationContext('system'), message),
    });
    lists.set(agentObject, list);
  }
  return list;
}

/** Note an ACK request for a graph. `onChainId` is the id the request named. */
export function noteStorageAckRequest(agentObject: object, contextGraphId: string, onChainId: string): void {
  let canonical: string;
  try {
    canonical = BigInt(onChainId).toString();
  } catch {
    return;
  }
  storageAckRecentGraphsOf(agentObject).note(contextGraphId, canonical);
}

/**
 * The saved rows to bring back first at start, as rank by local id (0 is the
 * most recently requested). Never rejects.
 */
export async function recentStorageAckGraphRanks(agentObject: object): Promise<Map<string, number>> {
  const list = storageAckRecentGraphsOf(agentObject);
  await list.load();
  return new Map(list.recent().map((entry, rank) => [entry.contextGraphId, rank]));
}
