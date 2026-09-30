/**
 * Managed Oxigraph, caller aborts: REAL `oxigraph-server`, NO mocks.
 *
 * On the daemon-managed backend a store read whose caller stops waiting after
 * dispatch used to be retained for a supervised restart at the client deadline
 * (Oxigraph 0.5 keeps evaluating a query when the HTTP connection closes), even
 * when the abandoned query had long since finished. A caller with a short budget
 * of its own therefore got a healthy server SIGKILLed 30 s later.
 *
 * This suite runs the production wiring end to end: `startManagedOxigraph` spawns
 * a real, checksum-pinned Oxigraph binary and hands back the managed store
 * config, whose recovery capability is the real supervisor
 * (`handle.requestRestart`). The store talks to it over real HTTP, real queries
 * run for real, and a restart is a real SIGKILL and respawn. It asserts:
 *   - a read the caller abandons mid-flight, which the server then finishes
 *     inside the client deadline, does NOT restart the server;
 *   - a read that genuinely overruns the client deadline still does, whether or
 *     not its caller had already given up, and the store recovers.
 *
 * The binary is resolved by the product's own resolver into a scratch cache: it
 * is downloaded once (pinned release, sha256-verified) unless
 * DKG_TEST_OXIGRAPH_BINARY names an existing binary, which is copied in and
 * still has to match the pinned checksum.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
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

let root: string;
let handle: OxigraphServerHandle;
let store: TripleStore;
const logLines: string[] = [];
const spawnedPids: Array<number | undefined> = [];

/** A cross product of `arms` independent LIMIT-ed sub-selects: limit^arms rows. */
function crossProduct(limit: number, arms: number): string {
  const vars = ['a', 'b', 'c', 'd'].slice(0, arms);
  // The managed server has no union default graph: read through GRAPH.
  const groups = vars.map(
    (v, i) => `{ SELECT ?${v} WHERE { GRAPH ?g${i} { ?${v} ?p${i} ?o${i} } } LIMIT ${limit} }`,
  );
  return `SELECT (COUNT(*) AS ?n) WHERE { ${groups.join(' ')} }`;
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
