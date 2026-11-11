import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import { matchesGraphNameTest, readGraphMembership, workingMemoryIdentityRule } from '../../src/read-graph/membership.js';
import type { TripleStore } from '../../src/triple-store.js';
import { KILL_AT_COMMIT_AGENT } from './read-graph-kill-fixture.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const WRITER = fileURLToPath(new URL('./read-graph-kill-writer.ts', import.meta.url));

/** What one killed writer had announced when it died. */
export interface KilledWrite {
  /** The write it was killed during, or after. */
  readonly write: number;
  /** Whether it had printed that the write returned. */
  readonly returned: boolean;
}

/**
 * Run the writer until it announces write `killAt`, wait `delayMs`, and kill it with SIGKILL:
 * with a delay of a few milliseconds the write is usually in flight, sometimes already
 * committed by the store, sometimes not yet sent.
 */
export async function killWriterAt(
  env: Readonly<Record<string, string>>,
  killAt: number,
  delayMs: number,
): Promise<KilledWrite> {
  const child = spawn(process.execPath, ['--import', 'tsx', WRITER], {
    cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  let returned = -1;
  let killed = false;
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-20_000); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 120_000);
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    for (let end = output.indexOf('\n'); end >= 0; end = output.indexOf('\n')) {
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      const committed = /^committed (\d+)$/.exec(line);
      if (committed) returned = Number(committed[1]);
      if (!killed && line.startsWith(`sending ${killAt} `)) {
        killed = true;
        setTimeout(() => child.kill('SIGKILL'), delayMs);
      }
    }
  });
  try {
    const { code, signal } = await exited;
    if (signal !== 'SIGKILL' || !killed) throw new Error(`The writer stopped by itself (code ${code}, signal ${signal}): ${stderr}`);
  } finally { clearTimeout(deadline); }
  return { write: killAt, returned: returned >= killAt };
}

/** The context graph's verifiable-memory read graph and the union of its members, as triple sets. */
export async function readGraphAndMembers(adapter: TripleStore, contextGraphId: string) {
  const root = `did:dkg:context-graph:${contextGraphId}`;
  const key = { scope: readScope(contextGraphId), layer: MemoryLayer.VerifiableMemory };
  const readGraph = readGraphIri(key);
  const membership = readGraphMembership(key, { contextGraphId, subGraphNames: [], childContextGraphRoots: [] },
    workingMemoryIdentityRule({ defaultAgentAddress: KILL_AT_COMMIT_AGENT }));
  // sparql-scan-allow: R2 -- the graphs of one test context graph, freshly created for this check
  const result = await adapter.query(`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${root}")) }`);
  const rows = result.type === 'bindings' ? result.bindings : [];
  const triple = (row: Record<string, string>) => `${row.s} ${row.p} ${row.o}`;
  return {
    readGraph: [...new Set(rows.filter(row => row.g === readGraph).map(triple))].sort(),
    members: [...new Set(rows.filter(row => row.g !== readGraph && matchesGraphNameTest(membership, row.g!)).map(triple))].sort(),
  };
}

/** After a kill, the read graph holds exactly the union of its members. */
export async function expectReadGraphEqualsMembers(adapter: TripleStore, contextGraphId: string, after: string) {
  const { readGraph, members } = await readGraphAndMembers(adapter, contextGraphId);
  expect(readGraph.length, `${after}: read graph size`).toBe(members.length);
  expect(readGraph, after).toEqual(members);
  return members.length;
}

/** Kill points: which write, and how long after its announcement. */
export const KILL_POINTS: ReadonlyArray<{ readonly write: number; readonly delayMs: number }> = [
  { write: 0, delayMs: 2 }, { write: 1, delayMs: 5 }, { write: 2, delayMs: 15 },
  { write: 3, delayMs: 30 }, { write: 4, delayMs: 0 }, { write: 5, delayMs: 60 },
  // Later kills, so some land after the store has committed the write.
  { write: 6, delayMs: 150 }, { write: 7, delayMs: 400 },
];
