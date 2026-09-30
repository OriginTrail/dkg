/**
 * Managed Oxigraph, caller aborts: REAL `oxigraph-server`, NO mocks.
 *
 * On the daemon-managed backend a store read whose caller stops waiting after
 * dispatch used to be retained for a supervised restart at the client deadline,
 * even when the abandoned query had long since finished: a caller with a short
 * budget of its own got a healthy server SIGKILLed 30 s later. (Once the client
 * has aborted the fetch it cannot tell a finished evaluation from a running
 * one: a streamed SELECT stops when it next writes to the closed socket, but a
 * blocking evaluation, an aggregate or an ORDER BY, sends nothing until it is
 * done and keeps evaluating.) The store now leaves a request running when its
 * caller leaves, and withdraws the recovery when the server visibly finishes.
 * From the first byte of the answer on, though, it reads and buffers nothing
 * beyond a small budget for a caller who has left: a STREAMED read would
 * otherwise keep the server producing, and the client buffering, for the whole
 * client deadline.
 *
 * This suite runs the production wiring end to end: `startManagedOxigraph` spawns
 * a real, checksum-pinned Oxigraph binary and hands back the managed store
 * config, whose recovery capability is the real supervisor
 * (`handle.requestRestart`). The store talks to it over real HTTP, real queries
 * run for real, and a restart is a real SIGKILL and respawn. It asserts:
 *   - a read the caller abandons mid-flight, which the server then finishes
 *     inside the client deadline, does NOT restart the server;
 *   - a STREAMED read the caller abandons is not read on beyond a small budget
 *     (the bytes the client reads after the caller left stay within a small
 *     bound, and the server stops producing), whether the caller leaves while
 *     the answer streams or before it has started;
 *   - a streamed read whose caller leaves mid-body, and whose answer is then
 *     short but slow to finish (the server is silent for seconds, so it cannot
 *     notice a closed connection), does NOT restart the server either;
 *   - a read that genuinely overruns the client deadline still restarts the
 *     server, whether or not its caller had already given up, and the store
 *     recovers.
 *
 * The binary is resolved by the product's own resolver into a scratch cache: it
 * is downloaded once (pinned release, sha256-verified) unless
 * DKG_TEST_OXIGRAPH_BINARY names an existing binary, which is copied in and
 * still has to match the pinned checksum.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTripleStore,
  isStoreOperationTimeoutError,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { OXIGRAPH_VERSION } from '../src/daemon/oxigraph-binary.js';
import { startManagedOxigraph } from '../src/daemon/oxigraph-managed.js';
import type { OxigraphServerHandle } from '../src/daemon/oxigraph-server.js';
import { freePort, sleep, waitForCondition } from './fixtures/oxigraph-server-real-fixture.js';

const CLIENT_TIMEOUT_MS = 6_000;
const ABORT_AFTER_MS = 60;
const TRIPLES = 400;
const RESTART_LINE = 'terminating server for supervised recovery';
// A caller that has left may cost the client at most the store's drain budget
// (1 MiB, plus a chunk) of what remains of its answer. This bound is four times
// the budget: generous enough that it never flakes, while an abandoned answer
// that is read on runs to tens of MB within a second (about 35 MB/s).
const MAX_READ_AFTER_ABANDON_BYTES = 4 * 1024 * 1024;
// A streamed evaluation that is still being produced burns about 0.7 CPU-seconds
// per second; an idle server burns none. The quiet window starts a second after
// the abandon, and must end before the client deadline restarts the server.
const CPU_SETTLE_MS = 1_000;
const CPU_WINDOW_MS = 3_000;
const MAX_SERVER_CPU_IN_WINDOW_S = 1.5;

let root: string;
let handle: OxigraphServerHandle;
let store: TripleStore;
const logLines: string[] = [];
const spawnedPids: Array<number | undefined> = [];

/** `arms` independent LIMIT-ed sub-selects joined without a shared variable: limit^arms rows. */
function crossProductPattern(limit: number, arms: number): { vars: string[]; where: string } {
  const vars = ['a', 'b', 'c', 'd'].slice(0, arms);
  // The managed server has no union default graph: read through GRAPH.
  const groups = vars.map(
    (v, i) => `{ SELECT ?${v} WHERE { GRAPH ?g${i} { ?${v} ?p${i} ?o${i} } } LIMIT ${limit} }`,
  );
  return { vars, where: groups.join(' ') };
}

/** A blocking aggregate over the cross product: nothing is sent until it is done. */
function crossProduct(limit: number, arms: number): string {
  return `SELECT (COUNT(*) AS ?n) WHERE { ${crossProductPattern(limit, arms).where} }`;
}

/** The same rows, streamed to the client as they are produced. */
function streamedCrossProduct(limit: number, arms: number): string {
  const { vars, where } = crossProductPattern(limit, arms);
  return `SELECT ${vars.map((v) => `?${v}`).join(' ')} WHERE { ${where} }`;
}

/** The same rows, but ordered: nothing is sent until they are all sorted, then a large answer. */
function sortedCrossProduct(limit: number, arms: number): string {
  return `${streamedCrossProduct(limit, arms)} ORDER BY ?a`;
}

/**
 * A streamed answer that starts at once and then goes quiet: a fast branch
 * returns 3600 rows (about 320 KB, enough for the server to send its headers and
 * the first chunks) and a slow branch scans a `limit`^3 cross product for rows
 * that never match, so the answer ends only when that scan does. Once the first
 * rows are out the server writes nothing, and cannot notice a closed connection.
 */
function slowTailQuery(limit: number): string {
  const arm = (v: string, i: number, n: number) =>
    `{ SELECT ?${v} WHERE { GRAPH ?g${i} { ?${v} ?p${i} ?o${i} } } LIMIT ${n} }`;
  return `SELECT ?x ?y WHERE {
    { SELECT ?x ?y WHERE { ${arm('x', 5, 60)} ${arm('y', 6, 60)} } }
    UNION
    { SELECT (?a AS ?x) (?b AS ?y) WHERE {
      ${arm('a', 1, limit)} ${arm('b', 2, limit)} ${arm('c', 3, limit)}
      FILTER(STRLEN(STR(?a)) + STRLEN(STR(?b)) + STRLEN(STR(?c)) < 3)
    } }
  }`;
}

async function timedQuery(sparql: string): Promise<number> {
  const started = Date.now();
  await store.query(sparql);
  return Date.now() - started;
}

/** The smallest three-way cross product that takes at least `minMs` to answer. */
async function calibrate(minMs: number): Promise<number> {
  let limit = 60;
  for (let step = 0; step < 24; step += 1) {
    const elapsed = await timedQuery(crossProduct(limit, 3));
    if (elapsed >= minMs) return limit;
    limit = Math.min(TRIPLES, Math.ceil(limit * 1.4));
  }
  throw new Error('no cross-product size took long enough; the store is too small');
}

/**
 * A full read of the slow-tail query through the store: when its first byte
 * arrived, and how long the whole answer took.
 */
async function timeSlowTail(limit: number): Promise<{ firstByteMs: number; totalMs: number }> {
  const metered = meterQueryResponses();
  const started = Date.now();
  let firstByteMs = Number.POSITIVE_INFINITY;
  const poll = setInterval(() => {
    if (firstByteMs === Number.POSITIVE_INFINITY && metered.bytes() > 0) firstByteMs = Date.now() - started;
  }, 5);
  try {
    await store.query(slowTailQuery(limit));
  } finally {
    clearInterval(poll);
    metered.stop();
  }
  return { firstByteMs, totalMs: Date.now() - started };
}

/**
 * The smallest slow-tail query whose first rows arrive at once and whose answer
 * then takes 1.2 s or more (and still well inside the client deadline). Oxigraph
 * plans a UNION differently from one size to the next, and for some sizes runs
 * the slow branch first, so it sends nothing until the end: those sizes do not
 * have the shape this test needs, and are skipped.
 */
async function calibrateSlowTail(): Promise<number> {
  for (let limit = 60; limit <= TRIPLES; limit += 2) {
    const { firstByteMs, totalMs } = await timeSlowTail(limit);
    if (totalMs > CLIENT_TIMEOUT_MS / 2) break;
    if (firstByteMs < 300 && totalMs >= 1_200) return limit;
  }
  throw new Error('no slow-tail size answered early and took long enough on this machine');
}

/** Start `sparql`, disconnect the caller `ABORT_AFTER_MS` in, and return its outcome. */
async function abandon(sparql: string): Promise<unknown> {
  const caller = new AbortController();
  const outcome = store.query(sparql, { signal: caller.signal }).then(
    () => new Error('the read finished before its caller left'),
    (error: unknown) => error,
  );
  await sleep(ABORT_AFTER_MS);
  caller.abort(new Error('caller budget exhausted'));
  return await outcome;
}

const restarts = () => handle.getRecoveryState().generation;

/**
 * Count every response body byte the store's reads pull off the network. The
 * wrapper reads the real body only as fast as the store's consumer does (no
 * read-ahead), and passes a cancel through to it, so what it counts is what the
 * store actually read, and cancelling it closes the real connection.
 */
function meterQueryResponses(): { readonly bytes: () => number; readonly stop: () => void } {
  const realFetch = globalThis.fetch;
  let bytes = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await realFetch(input, init);
    if (init?.method !== 'POST' || response.body === null) return response;
    const reader = response.body.getReader();
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      },
      cancel: (reason) => reader.cancel(reason),
    }, { highWaterMark: 0 }), { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
  return { bytes: () => bytes, stop: () => { globalThis.fetch = realFetch; } };
}

/** CPU seconds a process has used so far (`ps`, macOS and Linux), or undefined where it cannot be read. */
function cpuSeconds(pid: number | undefined): number | undefined {
  if (pid === undefined || process.platform === 'win32') return undefined;
  const result = spawnSync('ps', ['-o', 'cputime=', '-p', String(pid)], { encoding: 'utf8' });
  const text = result.status === 0 ? result.stdout.trim() : '';
  if (text === '') return undefined;
  // [[dd-]hh:]mm:ss[.ss]
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text];
  return Number(days) * 86_400 + clock!.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

const storeAnswers = async (): Promise<boolean> => {
  try {
    return (await store.query('ASK { GRAPH ?g { ?s ?p ?o } }')).type === 'boolean';
  } catch {
    return false;
  }
};

/**
 * A read that is cancelled instead of being seen to finish is still owed a
 * supervised restart at its client deadline, as it always was: nothing shows the
 * server stopped (it may be stalled between writes). Wait for that restart and
 * for the server to be back, so the next test starts from a settled server.
 */
async function settleCancelledRead(dispatchedAt: number, restartsBefore: number): Promise<void> {
  await sleep(Math.max(0, dispatchedAt + CLIENT_TIMEOUT_MS + 500 - Date.now()));
  expect(await waitForCondition(() => restarts() > restartsBefore, 30_000)).toBe(true);
  expect(await waitForCondition(async () => !handle.getRecoveryState().recovering && await storeAnswers(), 60_000)).toBe(true);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'oxi-caller-abort-e2e-'));
  const cacheDir = join(root, 'oxigraph-cache');
  if (process.env.DKG_TEST_OXIGRAPH_BINARY) {
    await mkdir(cacheDir, { recursive: true });
    await copyFile(
      process.env.DKG_TEST_OXIGRAPH_BINARY,
      join(cacheDir, `oxigraph-v${OXIGRAPH_VERSION}${process.platform === 'win32' ? '.exe' : ''}`),
    );
  }
  const managed = await startManagedOxigraph({
    config: {
      store: {
        backend: 'oxigraph-server',
        options: {
          port: await freePort(),
          cacheDir,
          location: join(root, 'oxigraph-data'),
          clientTimeoutMs: CLIENT_TIMEOUT_MS,
        },
      },
    },
    dataDir: root,
    log: (message) => { logLines.push(message); },
    // Record every server process the supervisor launches: a restart is a respawn.
    serverIo: {
      spawn: ((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args);
        spawnedPids.push(child.pid);
        return child;
      }) as typeof spawn,
    },
    readyTimeoutMs: 120_000,
  });
  if (managed === null) throw new Error('the oxigraph-server backend was not started');
  handle = managed.handle;
  store = await createTripleStore(managed.storeConfig);
  await store.insert(Array.from({ length: TRIPLES }, (_, i) => ({
    subject: `urn:caller-abort:s${i}`,
    predicate: 'urn:caller-abort:p',
    object: `"value ${i}"`,
    graph: 'urn:caller-abort:g',
  })));
}, 240_000);

afterAll(async () => {
  await store?.close().catch(() => {});
  await handle?.stop().catch(() => {});
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('managed oxigraph-server: a caller that abandons a dispatched read', () => {
  it('does not restart a healthy server when the abandoned read then completes', async () => {
    const limit = await calibrate(500);
    const sparql = crossProduct(limit, 3);
    const took = await timedQuery(sparql);
    // The premise of the whole test: the read is still running when the caller
    // leaves, and finishes well inside the client deadline.
    expect(took).toBeGreaterThan(ABORT_AFTER_MS * 4);
    expect(took).toBeLessThan(CLIENT_TIMEOUT_MS / 2);

    const restartsBefore = restarts();
    const spawnsBefore = spawnedPids.length;
    const linesBefore = logLines.length;

    // Three callers, each leaving mid-flight, each answered with its own abort.
    for (let i = 0; i < 3; i += 1) {
      expect(await abandon(sparql)).toMatchObject({ message: 'caller budget exhausted' });
    }

    // Past the client deadline the retained recovery would have fired.
    await sleep(CLIENT_TIMEOUT_MS + 3_000);
    expect(restarts()).toBe(restartsBefore);
    expect(spawnedPids).toHaveLength(spawnsBefore);
    expect(logLines.slice(linesBefore).some((line) => line.includes(RESTART_LINE))).toBe(false);
    expect(handle.getRecoveryState().recovering).toBe(false);
    await expect(store.query('ASK { GRAPH ?g { ?s ?p ?o } }'))
      .resolves.toMatchObject({ type: 'boolean', value: true });
  }, 90_000);

  it('reads only a bounded part of a STREAMED answer once its caller has left it mid-body, and the server stops', async () => {
    expect(await waitForCondition(() => !handle.getRecoveryState().recovering, 60_000)).toBe(true);
    const restartsBefore = restarts();
    const metered = meterQueryResponses();
    try {
      // 400^4 rows, streamed as they are produced: about 35 MB/s until the deadline.
      const sparql = streamedCrossProduct(TRIPLES, 4);
      const caller = new AbortController();
      const dispatchedAt = Date.now();
      const outcome = store.query(sparql, { signal: caller.signal }).then(
        () => new Error('the read finished before its caller left'),
        (error: unknown) => error,
      );
      // The answer is under way once the client has read some of it.
      expect(await waitForCondition(() => metered.bytes() > 64 * 1024, 30_000)).toBe(true);
      caller.abort(new Error('caller budget exhausted'));
      expect(await outcome).toMatchObject({ message: 'caller budget exhausted' });
      const readWhenLeft = metered.bytes();

      const serverPid = spawnedPids.at(-1);
      await sleep(CPU_SETTLE_MS);
      const cpuBefore = cpuSeconds(serverPid);
      await sleep(CPU_WINDOW_MS);
      const cpuAfter = cpuSeconds(serverPid);

      // Deterministic: at most the drain budget is read (and none of it kept) for a caller who left.
      expect(metered.bytes() - readWhenLeft).toBeLessThan(MAX_READ_AFTER_ABANDON_BYTES);
      // And the server stopped writing to the closed connection.
      if (cpuBefore !== undefined && cpuAfter !== undefined) {
        expect(cpuAfter - cpuBefore).toBeLessThan(MAX_SERVER_CPU_IN_WINDOW_S);
      }
      await settleCancelledRead(dispatchedAt, restartsBefore);
    } finally { metered.stop(); }
  }, 120_000);

  it('reads only a bounded part of a large answer that starts after its caller left', async () => {
    expect(await waitForCondition(() => !handle.getRecoveryState().recovering, 60_000)).toBe(true);
    const restartsBefore = restarts();
    const metered = meterQueryResponses();
    try {
      // 45^3 = 91125 sorted rows (about 12 MB): nothing is sent until the sort is
      // done, so the caller leaves before the first byte, and then a large answer starts.
      const sparql = sortedCrossProduct(45, 3);
      const caller = new AbortController();
      const dispatchedAt = Date.now();
      const outcome = store.query(sparql, { signal: caller.signal }).then(
        () => new Error('the read finished before its caller left'),
        (error: unknown) => error,
      );
      await sleep(ABORT_AFTER_MS);
      expect(metered.bytes()).toBe(0);
      caller.abort(new Error('caller budget exhausted'));
      expect(await outcome).toMatchObject({ message: 'caller budget exhausted' });

      // The answer starts (the premise: it began after the caller left), a small
      // part of it is read and thrown away, and the rest is cancelled. A client
      // that read it all would have read about 12 MB by now.
      expect(await waitForCondition(() => metered.bytes() > 0, CLIENT_TIMEOUT_MS)).toBe(true);
      await sleep(2_000);
      expect(metered.bytes()).toBeLessThan(MAX_READ_AFTER_ABANDON_BYTES);
      await settleCancelledRead(dispatchedAt, restartsBefore);
    } finally { metered.stop(); }
  }, 120_000);

  it('does not restart a healthy server when the caller leaves a streamed read mid-body and the rest is short but slow', async () => {
    expect(await waitForCondition(() => !handle.getRecoveryState().recovering, 60_000)).toBe(true);
    // The premise: the answer starts at once, the tail is slow (the read is
    // still running when the caller leaves) and still finishes well inside the
    // client deadline.
    const limit = await calibrateSlowTail();

    const restartsBefore = restarts();
    const spawnsBefore = spawnedPids.length;
    const linesBefore = logLines.length;
    const metered = meterQueryResponses();
    try {
      const caller = new AbortController();
      const outcome = store.query(slowTailQuery(limit), { signal: caller.signal }).then(
        () => new Error('the read finished before its caller left'),
        (error: unknown) => error,
      );
      // The answer is under way: the server has sent headers and the first rows,
      // and is now silent while it scans for the rest.
      expect(await waitForCondition(() => metered.bytes() > 64 * 1024, 30_000)).toBe(true);
      caller.abort(new Error('caller budget exhausted'));
      expect(await outcome).toMatchObject({ message: 'caller budget exhausted' });
      const readWhenLeft = metered.bytes();

      // Past the client deadline a retained recovery would have fired.
      await sleep(CLIENT_TIMEOUT_MS + 3_000);
      expect(restarts()).toBe(restartsBefore);
      expect(spawnedPids).toHaveLength(spawnsBefore);
      expect(logLines.slice(linesBefore).some((line) => line.includes(RESTART_LINE))).toBe(false);
      expect(handle.getRecoveryState().recovering).toBe(false);
      // The rest of the answer was small: it was read out, and none of it kept.
      expect(metered.bytes() - readWhenLeft).toBeLessThan(MAX_READ_AFTER_ABANDON_BYTES);
      await expect(storeAnswers()).resolves.toBe(true);
    } finally { metered.stop(); }
  }, 120_000);

  it('still restarts the server when an abandoned read overruns the client deadline', async () => {
    // Settle any recovery left over from an earlier test before measuring.
    expect(await waitForCondition(() => !handle.getRecoveryState().recovering, 60_000)).toBe(true);
    const restartsBefore = restarts();
    const spawnsBefore = spawnedPids.length;
    const linesBefore = logLines.length;
    // 400^4 rows: no evaluation finishes this inside any deadline here.
    const runaway = crossProduct(TRIPLES, 4);

    expect(await abandon(runaway)).toMatchObject({ message: 'caller budget exhausted' });
    // The caller's own abort restarts nothing; only the missed deadline does.
    expect(logLines.slice(linesBefore).some((line) => line.includes(RESTART_LINE))).toBe(false);

    expect(await waitForCondition(() => restarts() > restartsBefore, CLIENT_TIMEOUT_MS + 60_000)).toBe(true);
    expect(logLines.slice(linesBefore).some((line) => line.includes(RESTART_LINE))).toBe(true);
    expect(await waitForCondition(() => spawnedPids.length > spawnsBefore, 30_000)).toBe(true);

    // The supervisor brought a fresh server up, and the data survived it.
    expect(await waitForCondition(async () => {
      try {
        const result = await store.query('SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }');
        return result.type === 'bindings' && String(result.bindings[0]?.n).includes(`${TRIPLES}`);
      } catch {
        return false;
      }
    }, 60_000)).toBe(true);
  }, 180_000);

  it('still restarts the server when a read that nobody abandoned overruns the client deadline', async () => {
    // Settle any recovery left over from the previous test before measuring.
    expect(await waitForCondition(() => !handle.getRecoveryState().recovering, 60_000)).toBe(true);
    const restartsBefore = restarts();
    const linesBefore = logLines.length;

    const failure = await store.query(crossProduct(TRIPLES, 4)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isStoreOperationTimeoutError(failure)).toBe(true);
    expect(failure).toMatchObject({ backend: 'oxigraph-server', timeoutMs: CLIENT_TIMEOUT_MS });

    expect(await waitForCondition(() => restarts() > restartsBefore, 30_000)).toBe(true);
    expect(logLines.slice(linesBefore).some((line) => line.includes(RESTART_LINE))).toBe(true);
    expect(await waitForCondition(async () => {
      try {
        return (await store.query('ASK { GRAPH ?g { ?s ?p ?o } }')).type === 'boolean';
      } catch {
        return false;
      }
    }, 60_000)).toBe(true);
  }, 180_000);
});
