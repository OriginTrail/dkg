// SPDX-License-Identifier: Apache-2.0

/**
 * The node's working-memory identity rule on a backend's read-graph runtime,
 * and the record of the identity its working-memory read graphs are kept under.
 *
 * The rule decides which agent owns the drafts written under an address: each
 * agent owns its own, and the node's default agent also those written under
 * the node's peer ID. A working-memory read graph holds the drafts of the
 * addresses its agent owns, so it is valid only under the rule it was built
 * and maintained under. The record, a file in each data directory of the
 * backend's runtime (`./data-directories.ts`), lets a later start keep those
 * read graphs when the identity is the same.
 *
 * The record names an identity only while every working-memory row the store
 * holds as `ready` is valid under it. A change of identity removes it before
 * the new rule is installed. It is written again once every dirty mark the
 * change needs is stored and the store has made them durable (`flush`): a
 * stopped process leaves either no record, so start-up keeps no
 * working-memory read graph, or a record with its marks. A mark is durable
 * once a flush after it ends with no restart of the backend since it was
 * stored; one that a restart may have undone, as when a worker reloads an
 * earlier snapshot, is owed again. While a record that
 * names another identity cannot be removed, the backend's working-memory read
 * graphs are held (`./working-memory-hold.ts`): none is built or repaired, so
 * none built under the new identity sits beside that record.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryLayer, parseReadGraphIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '../triple-store.js';
import { workingMemoryIdentityRule, type WorkingMemoryIdentityRule } from './membership.js';
import { readGraphRuntimeOf } from './read-graph-store.js';
import { addReadGraphDataDirectory, readGraphDataDirectories } from './data-directories.js';
import { markReadGraphDirty, type ReadGraphJobContext } from './rebuild.js';
import { readGraphRecoveryGeneration, syncReadGraphRuntimeWithRecovery } from './recovery.js';
import { holdWorkingMemoryReadGraphs } from './working-memory-hold.js';
import type { ReadGraphBackendRuntime } from './runtime.js';
import { nextReadGraphState } from './state.js';

/** The node as its working-memory identity rule sees it. Either value may be absent. */
export interface WorkingMemoryNodeIdentity {
  readonly defaultAgentAddress?: string;
  readonly peerId?: string;
}

/** The record, in the node's data directory, of the identity its working-memory read graphs are kept under. */
export const READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE = 'read-graph-working-memory-identity.json';

/** What a backend's runtime knows of its identity and its record. */
interface IdentityRecording {
  /** The identity its rule was installed from: the recorded one start-up installed, or the last installation's. */
  node: WorkingMemoryNodeIdentity | undefined;
  /** Whether the record names `node`, with every dirty mark it needs durable. */
  recorded: boolean;
  /** Working-memory read graphs marked dirty in the mirror for a change of identity, whose stored mark is owed. */
  readonly owed: Set<string>;
  /**
   * Marks the store took that no flush has made durable yet, each with the runtime's recovery generation
   * (`./recovery.ts`) from before it was stored. A restart or restore of the backend since may have undone them.
   */
  readonly unflushed: Map<string, number>;
  /** Data directories whose record a change of identity could not remove: the working-memory read graphs are held. */
  readonly stale: Set<string>;
  /** The stored part of the installations, one at a time. */
  queue: Promise<void>;
}

const RECORDINGS = new WeakMap<ReadGraphBackendRuntime, IdentityRecording>();

function recordingOf(runtime: ReadGraphBackendRuntime): IdentityRecording {
  let recording = RECORDINGS.get(runtime);
  if (!recording) {
    recording = { node: undefined, recorded: false, owed: new Set(), unflushed: new Map(), stale: new Set(), queue: Promise.resolve() };
    RECORDINGS.set(runtime, recording);
  }
  return recording;
}

/** The identity recorded in `dataDir`; `undefined` when there is none or it cannot be read. */
export function recordedWorkingMemoryIdentity(dataDir: string): WorkingMemoryNodeIdentity | undefined {
  const path = join(dataDir, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const { defaultAgentAddress, peerId } = parsed as Record<string, unknown>;
  if (![defaultAgentAddress, peerId].every((value) => value === undefined || typeof value === 'string')) return undefined;
  return {
    ...(defaultAgentAddress === undefined ? {} : { defaultAgentAddress: defaultAgentAddress as string }),
    ...(peerId === undefined ? {} : { peerId: peerId as string }),
  };
}

/**
 * Start-up's part, before anything writes, by the start-up that loads the
 * backend's mirror: note the node's data directory,
 * where identity changes are recorded, and install the recorded identity's
 * rule. Returns that identity, under which start-up may keep working-memory
 * read graphs; `undefined` when there is no readable record, or when a change
 * of identity in this process still owes a stored or durable mark.
 */
export function installRecordedWorkingMemoryIdentity(
  runtime: ReadGraphBackendRuntime,
  dataDir: string,
): WorkingMemoryNodeIdentity | undefined {
  addReadGraphDataDirectory(runtime, dataDir);
  const recording = recordingOf(runtime);
  const recorded = recording.owed.size > 0 || recording.unflushed.size > 0 ? undefined : recordedWorkingMemoryIdentity(dataDir);
  recording.node = recorded;
  recording.recorded = recorded !== undefined;
  if (recorded !== undefined) runtime.workingMemoryIdentity = workingMemoryIdentityRule(recorded);
  return recorded;
}

/**
 * A later start-up's part, over a backend another start-up of this process
 * loaded: its agent may be the one a later process starts alone, so its data
 * directory records the running identity from now on. A record it holds is
 * replaced by the running identity's, or removed while none is recorded.
 */
export function noteWorkingMemoryIdentityDirectory(runtime: ReadGraphBackendRuntime, dataDir: string): void {
  addReadGraphDataDirectory(runtime, dataDir);
  const recording = recordingOf(runtime);
  if (recording.recorded && recording.node !== undefined) {
    try {
      recordWorkingMemoryIdentity(dataDir, recording.node);
      return;
    } catch {
      // No record rather than one of another identity.
    }
  }
  removeRecordsOrHold(runtime, [dataDir]);
}

/** Write the record: a new file, synced, renamed over the old one, and the directory synced. */
function recordWorkingMemoryIdentity(dataDir: string, node: WorkingMemoryNodeIdentity): void {
  const path = join(dataDir, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE);
  const next = `${path}.next`;
  const file = openSync(next, 'w');
  try {
    writeFileSync(file, `${JSON.stringify({ defaultAgentAddress: node.defaultAgentAddress, peerId: node.peerId })}\n`);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(next, path);
  syncDirectory(dataDir);
}

/**
 * Remove the record in each of `dirs`, holding the backend's working-memory
 * read graphs while any record that should be gone is left and releasing them
 * once none is. Returns whether none is left.
 */
function removeRecordsOrHold(runtime: ReadGraphBackendRuntime, dirs: Iterable<string>): boolean {
  const { stale } = recordingOf(runtime);
  for (const dir of dirs) {
    try {
      removeWorkingMemoryIdentityRecord(dir);
      stale.delete(dir);
    } catch {
      stale.add(dir);
    }
  }
  holdWorkingMemoryReadGraphs(runtime, stale.size > 0);
  return stale.size === 0;
}

/** Remove the record, if there is one, and sync the directory. Only a confirmed absence counts as no record. */
function removeWorkingMemoryIdentityRecord(dataDir: string): void {
  const path = join(dataDir, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE);
  try {
    unlinkSync(path);
  } catch (error) {
    // A record that cannot be reached, as in a directory without search permission, is not gone.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  syncDirectory(dataDir);
}

function syncDirectory(dir: string): void {
  // As for the store's own snapshot, best effort: not every platform syncs a directory.
  try {
    const handle = openSync(dir, 'r');
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch {
    // The rename or removal itself has happened.
  }
}

function sameIdentity(left: WorkingMemoryNodeIdentity, right: WorkingMemoryNodeIdentity): boolean {
  return left.defaultAgentAddress === right.defaultAgentAddress && left.peerId === right.peerId;
}

/** What one installation did. */
export interface WorkingMemoryIdentityInstall {
  /** The working-memory read graphs marked dirty because their agent owns other addresses under the new rule. */
  readonly marked: readonly string[];
  /** Whether the record now names the runtime's identity, every mark it needs stored. When not, the next start keeps no working-memory read graph. */
  readonly recorded: boolean;
}

/**
 * Install the node's working-memory identity rule on the store's read-graph
 * runtime.
 *
 * The new rule is compared with the rule the runtime holds: one configured for
 * the layer, the recorded one that start-up installed, the runtime's own
 * (every address owns its drafts), or the one installed before. In one
 * synchronous step, every working-memory read graph with a row whose agent
 * owns other addresses under the new rule is marked dirty in the mirror, and
 * its stored mark is owed, also when the mirror already held it dirty (its
 * stored row may still say ready); the record is removed when the identity
 * changes, and the rule is installed. So
 * no reader sees the new owner with a read graph built for the old one, nor
 * the old rule beside the new default, and no later start keeps a read graph
 * under the old record.
 *
 * Each mark is then stored, from the stored row and under the read graph's
 * lock, one installation at a time. A mark that cannot be stored stays owed:
 * the mirror keeps the read graph out of service, and every later
 * installation stores the owed marks first. Once none is owed, the store is
 * flushed and the identity recorded. A mark the store took before its backend
 * restarted, which no flush made durable, is owed again. A store without a
 * read-graph layer is left as it is.
 */
export async function installWorkingMemoryIdentity(
  context: Pick<ReadGraphJobContext, 'dataDir' | 'signal' | 'source'> & { readonly store: TripleStore },
  node: WorkingMemoryNodeIdentity,
): Promise<WorkingMemoryIdentityInstall> {
  const runtime = readGraphRuntimeOf(context.store);
  if (!runtime) return { marked: [], recorded: false };
  const recording = recordingOf(runtime);
  const dirs = recordingDirectories(runtime, context.dataDir);
  const rule = workingMemoryIdentityRule(node);
  // Nothing is awaited from here until the rule, the marks and the record agree.
  const { marked, moved } = markWorkingMemoryReadGraphsDirty(runtime, runtime.workingMemoryIdentity, rule);
  if (moved.length > 0 || recording.node === undefined || !sameIdentity(recording.node, node)) {
    recording.recorded = false;
    // A record that cannot be removed holds the working-memory read graphs until a later turn removes it.
    removeRecordsOrHold(runtime, dirs);
  }
  runtime.workingMemoryIdentity = rule;
  recording.node = node;
  for (const readGraph of moved) recording.owed.add(readGraph);
  const turn = recording.queue.then(() => storeMarksAndRecord(context, runtime, recording));
  recording.queue = turn.then(() => undefined, () => undefined);
  return { marked, recorded: await turn };
}

/**
 * The data directories a backend's identity is recorded in: the runtime's
 * (`./data-directories.ts`), which its start-ups added, whichever directory an
 * installation names, so that every record start-up may read covers the
 * backend's read graphs. Without one, the first directory an installation
 * names is added.
 */
function recordingDirectories(runtime: ReadGraphBackendRuntime, named: string | undefined): string[] {
  const noted = readGraphDataDirectories(runtime);
  if (noted.length > 0) return [...noted];
  if (named === undefined) return [];
  addReadGraphDataDirectory(runtime, named);
  return [named];
}

/**
 * Store every owed mark, then record the runtime's identity once none is owed
 * and the store has made the marks durable, start-up's own included. Returns
 * whether the record names that identity.
 */
async function storeMarksAndRecord(
  context: Pick<ReadGraphJobContext, 'dataDir' | 'signal' | 'source'> & { readonly store: TripleStore },
  runtime: ReadGraphBackendRuntime,
  recording: IdentityRecording,
): Promise<boolean> {
  // A mark the store took before its backend restarted, which no flush made durable, may be undone: it is owed again.
  const generation = recoveryGeneration(context.store, runtime);
  oweUndoneMarks(recording, generation);
  const records = recordingDirectories(runtime, context.dataDir).length > 0;
  // A mark owed by an installation that comes meanwhile is stored here too.
  for (const readGraph of recording.owed) {
    try {
      await markReadGraphDirty(context, readGraph);
      recording.owed.delete(readGraph);
      // Its durability matters only to a record, which needs a data directory.
      if (records) recording.unflushed.set(readGraph, generation);
    } catch {
      // The stored row did not take the mark: this process still does not serve the read graph.
      const current = runtime.mirror.get(readGraph);
      const dirty = current === undefined || current.state === 'dirty' ? undefined : nextReadGraphState(current, { kind: 'mark-dirty' });
      if (dirty !== undefined) runtime.mirror.set(dirty);
    }
  }
  // A record that could not be removed: try again, and keep the working-memory read graphs held while it stays.
  if (recording.stale.size > 0 && !removeRecordsOrHold(runtime, [...recording.stale])) return false;
  const dirs = recordingDirectories(runtime, context.dataDir);
  if (recording.owed.size > 0 || dirs.length === 0 || recording.node === undefined) return false;
  if (recording.recorded) return true;
  const node = recording.node;
  try {
    if (!removeRecordsOrHold(runtime, dirs)) return false;
    await context.store.flush?.();
    // The flush made durable the marks the backend still holds: those stored since its last restart.
    if (oweUndoneMarks(recording, recoveryGeneration(context.store, runtime))) return false;
    recording.unflushed.clear();
    // An installation that came meanwhile records its own identity, once its marks are stored.
    if (recording.node !== node || recording.owed.size > 0) return false;
    // A data directory a later start-up named meanwhile is recorded in too.
    for (const dir of recordingDirectories(runtime, context.dataDir)) recordWorkingMemoryIdentity(dir, node);
  } catch {
    return false;
  }
  recording.recorded = true;
  return true;
}

/** The runtime's recovery generation, once it has seen any restart of its backend. */
function recoveryGeneration(store: TripleStore, runtime: ReadGraphBackendRuntime): number {
  syncReadGraphRuntimeWithRecovery(store, runtime);
  return readGraphRecoveryGeneration(store, runtime);
}

/** Owe again each mark stored at another recovery generation than `generation`. Returns whether there was one. */
function oweUndoneMarks(recording: IdentityRecording, generation: number): boolean {
  let undone = false;
  for (const [readGraph, storedAt] of recording.unflushed) {
    if (storedAt === generation) continue;
    recording.unflushed.delete(readGraph);
    recording.owed.add(readGraph);
    undone = true;
  }
  return undone;
}

/** Whether `agent` owns other addresses under `after` than under `before`. */
function ownsOtherAddresses(before: WorkingMemoryIdentityRule, after: WorkingMemoryIdentityRule, agent: string): boolean {
  const was = before.addressesOf(agent);
  const now = after.addressesOf(agent);
  return was.length !== now.length || was.some((address) => !now.includes(address));
}

/**
 * The working-memory read graphs that have a row and whose agent owns other
 * addresses under `after` than under `before` (`moved`), and those of them
 * this marks dirty in the mirror, which did not hold them dirty yet (`marked`).
 */
function markWorkingMemoryReadGraphsDirty(
  runtime: ReadGraphBackendRuntime,
  before: WorkingMemoryIdentityRule,
  after: WorkingMemoryIdentityRule,
): { readonly marked: string[]; readonly moved: string[] } {
  const marked: string[] = [];
  const moved: string[] = [];
  for (const row of runtime.mirror.rows()) {
    const key = parseReadGraphIri(row.readGraph);
    if (key?.layer !== MemoryLayer.WorkingMemory || !ownsOtherAddresses(before, after, key.agentAddress)) continue;
    moved.push(row.readGraph);
    if (row.state === 'dirty') continue;
    const dirty = nextReadGraphState(row, { kind: 'mark-dirty' });
    if (dirty === undefined) continue;
    runtime.mirror.set(dirty);
    marked.push(row.readGraph);
  }
  return { marked, moved };
}
