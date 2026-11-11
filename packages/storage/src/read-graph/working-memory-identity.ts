// SPDX-License-Identifier: Apache-2.0

/**
 * The node's working-memory identity rule on a backend's read-graph runtime,
 * and the record of the identity its working-memory read graphs are kept under.
 *
 * The rule decides which agent owns the drafts written under an address: each
 * agent owns its own, and the node's default agent also those written under
 * the node's peer ID. A working-memory read graph holds the drafts of the
 * addresses its agent owns, so it is valid only under the rule it was built
 * and maintained under. The record, a file in the node's data directory, lets
 * a later start keep those read graphs when the identity is the same.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryLayer, parseReadGraphIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '../triple-store.js';
import { workingMemoryIdentityRule, type WorkingMemoryIdentityRule } from './membership.js';
import { readGraphRuntimeOf } from './read-graph-store.js';
import { markReadGraphDirty, type ReadGraphJobContext } from './rebuild.js';
import type { ReadGraphBackendRuntime } from './runtime.js';
import { nextReadGraphState } from './state.js';

/** The node as its working-memory identity rule sees it. Either value may be absent. */
export interface WorkingMemoryNodeIdentity {
  readonly defaultAgentAddress?: string;
  readonly peerId?: string;
}

/** The record, in the node's data directory, of the identity its working-memory read graphs are kept under. */
export const READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE = 'read-graph-working-memory-identity.json';

const DATA_DIRS = new WeakMap<ReadGraphBackendRuntime, string>();

/** Note the data directory of the node that starts read graphs on a backend: identity changes are recorded there. */
export function noteReadGraphDataDir(runtime: ReadGraphBackendRuntime, dataDir: string): void {
  DATA_DIRS.set(runtime, dataDir);
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

function recordWorkingMemoryIdentity(dataDir: string, node: WorkingMemoryNodeIdentity): void {
  const path = join(dataDir, READ_GRAPH_WORKING_MEMORY_IDENTITY_FILE);
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify({ defaultAgentAddress: node.defaultAgentAddress, peerId: node.peerId })}\n`);
  renameSync(next, path);
}

/** What one installation did. */
export interface WorkingMemoryIdentityInstall {
  /** The working-memory read graphs marked dirty because their agent owns other addresses under the new rule. */
  readonly marked: readonly string[];
  /** Whether every mark was stored and the identity recorded. When not, the next start compares again. */
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
 * the rule is installed. So no reader sees the new owner with a read graph
 * built for the old one, nor the old rule beside the new default.
 *
 * Each mark is then stored, from the stored row and under the read graph's
 * lock. Once all are stored, the identity is recorded in the node's data
 * directory. A mark that cannot be stored leaves the record as it was, so the
 * next start compares again, and the mirror keeps the read graph dirty, so it
 * is not served meanwhile; the builder marks it again from the stored row
 * before it plans. A store without a read-graph layer is left as it is.
 */
export async function installWorkingMemoryIdentity(
  context: Pick<ReadGraphJobContext, 'dataDir' | 'signal' | 'source'> & { readonly store: TripleStore },
  node: WorkingMemoryNodeIdentity,
): Promise<WorkingMemoryIdentityInstall> {
  const runtime = readGraphRuntimeOf(context.store);
  if (!runtime) return { marked: [], recorded: false };
  const rule = workingMemoryIdentityRule(node);
  // Nothing is awaited from here until both are visible.
  const marked = markWorkingMemoryReadGraphsDirty(runtime, runtime.workingMemoryIdentity, rule);
  runtime.workingMemoryIdentity = rule;
  let stored = true;
  for (const readGraph of marked) {
    try {
      await markReadGraphDirty(context, readGraph);
    } catch {
      stored = false;
      // The store kept its row, and the mirror followed it: this process still does not serve the read graph.
      const current = runtime.mirror.get(readGraph);
      const dirty = current === undefined || current.state === 'dirty' ? undefined : nextReadGraphState(current, { kind: 'mark-dirty' });
      if (dirty !== undefined) runtime.mirror.set(dirty);
    }
  }
  const dataDir = context.dataDir ?? DATA_DIRS.get(runtime);
  if (!stored || dataDir === undefined) return { marked, recorded: false };
  recordWorkingMemoryIdentity(dataDir, node);
  return { marked, recorded: true };
}

/** Whether `agent` owns other addresses under `after` than under `before`. */
function ownsOtherAddresses(before: WorkingMemoryIdentityRule, after: WorkingMemoryIdentityRule, agent: string): boolean {
  const was = before.addressesOf(agent);
  const now = after.addressesOf(agent);
  return was.length !== now.length || was.some((address) => !now.includes(address));
}

/**
 * Mark dirty, in the mirror, the working-memory read graphs that have a row and
 * whose agent owns other addresses under `after` than under `before`.
 */
function markWorkingMemoryReadGraphsDirty(
  runtime: ReadGraphBackendRuntime,
  before: WorkingMemoryIdentityRule,
  after: WorkingMemoryIdentityRule,
): string[] {
  const marked: string[] = [];
  for (const row of runtime.mirror.rows()) {
    const key = parseReadGraphIri(row.readGraph);
    if (key?.layer !== MemoryLayer.WorkingMemory || row.state === 'dirty' || !ownsOtherAddresses(before, after, key.agentAddress)) continue;
    const dirty = nextReadGraphState(row, { kind: 'mark-dirty' });
    if (dirty === undefined) continue;
    runtime.mirror.set(dirty);
    marked.push(row.readGraph);
  }
  return marked;
}
