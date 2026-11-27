import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { expect } from 'vitest';
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import { matchesGraphNameTest, readGraphMembership, workingMemoryIdentityRule } from '../../src/read-graph/membership.js';
import type { TripleStore } from '../../src/triple-store.js';
import { KILL_AT_COMMIT_AGENT, killAtCommitHolders, killAtCommitMember } from './read-graph-kill-fixture.js';
import { killWriterOnLine } from './killed-writer-process.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const WRITER = fileURLToPath(new URL('./read-graph-kill-writer.ts', import.meta.url));

/**
 * Where a kill lands: `delayMs` after the layer handed the target write's request to the store,
 * or `delayMs` after the writer saw the write return.
 */
export interface KillPoint {
  readonly write: number;
  readonly after: 'request' | 'return';
  readonly delayMs: number;
}

/** A kill point, and whether the writer had printed that the target write returned when it died. */
export interface KilledWrite extends KillPoint {
  readonly returned: boolean;
}

/**
 * Run the writer up to write `point.write` and kill it with SIGKILL at `point`. The writer starts
 * no write after the target, so the kill interrupts the target write or follows it, and no other.
 */
export async function killWriterAt(env: Readonly<Record<string, string>>, point: KillPoint): Promise<KilledWrite> {
  const child = spawn(process.execPath, ['--import', 'tsx', WRITER], {
    cwd: REPO, env: { ...process.env, ...env, DKG_KILL_TARGET: String(point.write) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const arming = `${point.after === 'request' ? 'to-store' : 'returned'} ${point.write}`;
  const lines = await killWriterOnLine(child, line => line === arming, point.delayMs, 'The writer');
  const last: Record<string, number> = { sending: -1, 'to-store': -1, returned: -1 };
  for (const line of lines) {
    const [event = '', n] = line.split(' ');
    if (Object.hasOwn(last, event)) last[event] = Number(n);
  }
  // The kill was timed from the target write itself, and the writer started nothing after it.
  expect(last.sending, 'the last write the writer started').toBe(point.write);
  expect(last['to-store'], 'the last write the layer handed to the store').toBe(point.write);
  return { ...point, returned: last.returned === point.write };
}

/** The context graph's verifiable-memory read graph, the union of its members as triple sets, and each member graph's size. */
export async function readGraphAndMembers(adapter: TripleStore, contextGraphId: string) {
  const root = `did:dkg:context-graph:${contextGraphId}`;
  const key = { scope: readScope(contextGraphId), layer: MemoryLayer.VerifiableMemory } as const;
  const readGraph = readGraphIri(key);
  const membership = readGraphMembership(key, { contextGraphId, subGraphNames: [], childContextGraphRoots: [] },
    workingMemoryIdentityRule({ defaultAgentAddress: KILL_AT_COMMIT_AGENT }));
  // sparql-scan-allow: R2 -- the graphs of one test context graph, freshly created for this check
  const result = await adapter.query(`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${root}")) }`);
  const rows = result.type === 'bindings' ? result.bindings : [];
  const triple = (row: Record<string, string>) => `${row.s} ${row.p} ${row.o}`;
  const memberRows = rows.filter(row => row.g !== readGraph && matchesGraphNameTest(membership, row.g!));
  const memberSizes: Record<string, number> = {};
  for (const row of memberRows) memberSizes[row.g!] = (memberSizes[row.g!] ?? 0) + 1;
  return {
    readGraph: [...new Set(rows.filter(row => row.g === readGraph).map(triple))].sort(),
    members: [...new Set(memberRows.map(triple))].sort(),
    memberSizes,
  };
}

/** A kill, and which side of its target write the store was left on. */
export interface KillOutcome extends KilledWrite {
  readonly state: 'before' | 'after';
  readonly triples: number;
}

/**
 * After a kill, the store holds the state just before the target write or just after it: each
 * member graph holds the whole batch or none of it, as the writes up to that point leave it, and
 * the read graph holds exactly the union of its members. A writer that saw the write return
 * leaves the state after it.
 */
export async function expectKillOutcome(
  adapter: TripleStore,
  contextGraphId: string,
  killed: KilledWrite,
  batchSize: number,
): Promise<KillOutcome> {
  const label = `a kill ${killed.delayMs} ms after the ${killed.after} of write ${killed.write}`;
  const { readGraph, members, memberSizes } = await readGraphAndMembers(adapter, contextGraphId);
  const sizesOf = (holders: readonly number[]) =>
    Object.fromEntries(holders.map(member => [killAtCommitMember(contextGraphId, member), batchSize]));
  const before = sizesOf(killAtCommitHolders(killed.write));
  const after = sizesOf(killAtCommitHolders(killed.write + 1));
  expect(killed.returned ? [after] : [before, after], `${label}: what each member graph holds`).toContainEqual(memberSizes);
  expect(readGraph.length, `${label}: read graph size`).toBe(members.length);
  expect(readGraph, `${label}: the read graph`).toEqual(members);
  return { ...killed, state: isDeepStrictEqual(memberSizes, after) ? 'after' : 'before', triples: readGraph.length };
}

/**
 * Kill points. Soon after the target write's request went to the store, for each write of the
 * cycle; later in the request, for a delete that leaves a copy and the delete of the last copy;
 * and once the writer has seen a write return: a delete that leaves a copy, the delete of the
 * last copy, and the insert after it.
 */
export const KILL_POINTS: readonly KillPoint[] = [
  { write: 0, after: 'request', delayMs: 0 }, { write: 1, after: 'request', delayMs: 2 },
  { write: 2, after: 'request', delayMs: 5 }, { write: 3, after: 'request', delayMs: 15 },
  { write: 4, after: 'request', delayMs: 1 }, { write: 5, after: 'request', delayMs: 30 },
  { write: 2, after: 'request', delayMs: 100 }, { write: 5, after: 'request', delayMs: 200 },
  { write: 4, after: 'return', delayMs: 0 }, { write: 5, after: 'return', delayMs: 0 },
  { write: 6, after: 'return', delayMs: 0 },
];

/**
 * The lane's evidence that it interrupts writes: once every kill point has run, at least one
 * kill timed from a request left the writer without that write's return.
 */
export function expectSomeWriteInterrupted(outcomes: readonly KillOutcome[], skip: (note: string) => void): void {
  const atRequest = outcomes.filter(outcome => outcome.after === 'request');
  if (atRequest.length < KILL_POINTS.filter(point => point.after === 'request').length) {
    skip('needs the outcome of every kill point timed from a request');
    return;
  }
  expect(atRequest.some(outcome => !outcome.returned), JSON.stringify(atRequest)).toBe(true);
}
