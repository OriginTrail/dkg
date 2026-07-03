import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { OxigraphWorkerStore, type Quad } from '../src/index.js';

// Regression tests for unexpected-worker-exit recovery. The production
// failure: ERR_WORKER_OUT_OF_MEMORY kills ONLY the worker thread, the daemon
// process keeps running, and the old adapter latched `workerExited` forever —
// a testnet node served HTTP for DAYS with a dead store (green /api/status,
// 503 on every write). The fix auto-respawns the worker on an exit that was
// NOT initiated by close(); these tests kill the REAL worker thread (no
// mocks) by reaching into the private `worker` field and calling terminate(),
// which raises the exact same 'exit'-without-close signal as an OOM kill.
//
// Like the resilience suite next door, this needs the compiled worker
// artifact (`dist/adapters/oxigraph-worker-impl.js`); if it's missing we fail
// loudly with the remediation hint rather than silently skip.
function makeStore(persistPath?: string, opts?: { operationTimeoutMs?: number }): OxigraphWorkerStore {
  try {
    return new OxigraphWorkerStore(persistPath, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/oxigraph-worker-impl/.test(msg)) {
      throw new Error(
        `oxigraph-worker adapter is not runnable — run ` +
          `\`pnpm --filter @origintrail-official/dkg-storage build\` first. Underlying: ${msg}`,
      );
    }
    throw err;
  }
}

// The recovery machinery is intentionally private (nothing outside the
// adapter should steer it), so the tests reach in through one typed seam
// instead of scattering `as any` casts around. `lifecycle` is the explicit
// state field the respawn/close/in-memory-loss logic keys off (see the
// WorkerLifecycle model in the adapter); asserting on it pins the state model.
type WorkerLifecycle =
  | 'initializing'
  | 'live'
  | 'respawning'
  | 'closing'
  | 'closed'
  | 'gave_up'
  | 'in_memory_lost';
function internals(store: OxigraphWorkerStore): {
  worker: Worker;
  lifecycle: WorkerLifecycle;
  closePromise: Promise<void> | null;
  respawnPromise: Promise<void> | null;
  consecutiveRespawnFailures: number;
} {
  return store as unknown as {
    worker: Worker;
    lifecycle: WorkerLifecycle;
    closePromise: Promise<void> | null;
    respawnPromise: Promise<void> | null;
    consecutiveRespawnFailures: number;
  };
}

/**
 * Simulate an OOM-style death of the CURRENT worker thread: terminate() while
 * closePromise is null fires the same 'exit' event a crashed thread does.
 * Awaiting terminate() guarantees the store's own 'exit' handler already ran
 * (it was registered first, and 'exit' listeners run synchronously at emit),
 * so on return the respawn has been scheduled — or already completed, for the
 * immediate first attempt.
 */
async function killWorker(store: OxigraphWorkerStore): Promise<void> {
  await internals(store).worker.terminate();
}

function quads(n: number, graph = 'urn:test:g'): Quad[] {
  const out: Quad[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = {
      subject: `urn:test:s:${i}`,
      predicate: 'http://schema.org/name',
      object: `"v${i}"`,
      graph,
    };
  }
  return out;
}

describe('OxigraphWorkerStore respawn after unexpected worker exit', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oxigraph-worker-respawn-'));
    path = join(dir, 'store.nq');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('recovers from an unexpected worker death — subsequent ops succeed on a respawned worker', async () => {
    const store = makeStore(path);
    try {
      await store.insert(quads(10));
      // insert() only schedules the worker's 50ms debounced flush; force the
      // data to disk so the respawned worker hydrates it back.
      await store.flush();

      const before = internals(store).worker;
      await killWorker(store);

      // Same store OBJECT (every daemon alias keeps working), new thread.
      expect(internals(store).worker).not.toBe(before);

      // Reads see the persisted data again — the exact op that used to fail
      // forever with "the store is closed".
      expect(await store.countQuads('urn:test:g')).toBe(10);
      // A disk-persisted store recovers fully: the state model is back to 'live'
      // (this is the branch finding 1 deliberately keeps auto-respawning).
      expect(internals(store).lifecycle).toBe('live');
      // And writes work too: the store is fully live, not read-only.
      await store.insert(quads(5, 'urn:test:g2'));
      expect(await store.countQuads('urn:test:g2')).toBe(5);
    } finally {
      await store.close().catch(() => {});
    }
  });

  it('rejects an in-flight op at kill time with the retryable "restarted — retry" message', async () => {
    const store = makeStore(path);
    try {
      // A 50k insert occupies the single worker thread for hundreds of ms, so
      // terminating right after posting is guaranteed to catch it in flight.
      const inflight = store.insert(quads(50_000));
      await killWorker(store);
      // The outcome of the killed op is genuinely unknown (the thread died
      // mid-processing), so the caller gets a RETRYABLE error, not "closed".
      await expect(inflight).rejects.toThrow(/oxigraph-worker restarted — retry/);
      // ...and a retry against the same store object then succeeds.
      await expect(store.insert(quads(10))).resolves.toBeUndefined();
      expect(await store.countQuads('urn:test:g')).toBe(10);
    } finally {
      await store.close().catch(() => {});
    }
  });

  it('parks ops issued during a respawn backoff instead of failing them', async () => {
    const store = makeStore(path);
    try {
      await store.insert(quads(10));
      await store.flush();

      // First kill → immediate respawn (backoff tier 0). Kill the replacement
      // BEFORE it serves any op, so the second respawn sits in the 1s backoff
      // tier — that's the window where new ops must park, not fail.
      await killWorker(store);
      await killWorker(store);
      expect(internals(store).respawnPromise).not.toBeNull();

      // Issued mid-backoff: the op waits for the replacement worker and then
      // succeeds against the disk-persisted state (slightly slower success,
      // never a spurious "store is closed").
      expect(await store.countQuads('urn:test:g')).toBe(10);
      expect(internals(store).respawnPromise).toBeNull();
    } finally {
      await store.close().catch(() => {});
    }
  }, 15_000);

  it('a successful op resets the crash-loop counter', async () => {
    const store = makeStore(path);
    try {
      await store.insert(quads(3));
      await store.flush();
      await killWorker(store);
      // The respawn consumed one attempt...
      expect(internals(store).consecutiveRespawnFailures).toBe(1);
      // ...and the first successful reply proves the worker healthy, ending
      // the accounting window (occasional crashes days apart never accumulate
      // toward the give-up bound).
      expect(await store.countQuads('urn:test:g')).toBe(3);
      expect(internals(store).consecutiveRespawnFailures).toBe(0);
    } finally {
      await store.close().catch(() => {});
    }
  });

  it('close() does NOT respawn — the exit stays intentional and ops fail closed', async () => {
    const store = makeStore(path);
    await store.insert(quads(5));
    const lastWorker = internals(store).worker;
    await store.close();

    // Give any (buggy) respawn scheduling a chance to run before asserting.
    await new Promise((r) => setTimeout(r, 50));
    expect(internals(store).respawnPromise).toBeNull();
    expect(internals(store).worker).toBe(lastWorker);

    // Post-close ops fail exactly as before this fix — fast and permanent.
    await expect(store.countQuads('urn:test:g')).rejects.toThrow(/store is closed/);
    await expect(store.insert(quads(1))).rejects.toThrow(/store is closed/);
  });

  it('gives up after MAX consecutive dead-on-arrival respawns and latches closed with guidance', async () => {
    const store = makeStore(path);
    try {
      await store.insert(quads(2));
      await store.flush();
      // Simulate a genuine crash loop without waiting out the real 1s/5s/30s
      // backoff ladder: pre-load the consecutive-failure counter to the bound,
      // so the very next unexpected exit hits the give-up branch immediately.
      internals(store).consecutiveRespawnFailures = 5;
      await killWorker(store);

      // Latched closed — same fail-fast as the pre-recovery behaviour, but the
      // error now tells the operator WHY and what to do about it.
      const err: any = await store.countQuads('urn:test:g').then(() => null, (e) => e);
      expect(err).toBeTruthy();
      expect(err.message).toMatch(/store is closed/);
      expect(err.message).toMatch(/respawn gave up/);
      // No further respawns get armed by later traffic.
      expect(internals(store).respawnPromise).toBeNull();
      // The give-up verdict is now the single, explicit terminal state — no
      // cluster of booleans that could disagree with the fail-fast error above.
      expect(internals(store).lifecycle).toBe('gave_up');
    } finally {
      // close() on a latched store must still resolve (idempotent teardown).
      await expect(store.close()).resolves.toBeUndefined();
    }
  });

  it('close() during a respawn backoff wins — the store stays closed', async () => {
    const store = makeStore(path);
    await store.insert(quads(4));
    await store.flush();
    // Double-kill parks the second respawn in the 1s backoff tier (as above).
    await killWorker(store);
    await killWorker(store);
    expect(internals(store).respawnPromise).not.toBeNull();

    // An operator close arriving mid-backoff must never be resurrected by the
    // supervisor: the pending respawn bails out when it wakes.
    await expect(store.close()).resolves.toBeUndefined();
    // Wait out the backoff so a buggy respawn would have fired by now.
    await new Promise((r) => setTimeout(r, 1_500));
    await expect(store.countQuads('urn:test:g')).rejects.toThrow(/store is closed/);
  }, 15_000);
});

// Finding 1 (🔴): an IN-MEMORY store (constructed with NO persistPath) has no
// disk to reload from, so respawning after an unexpected worker exit would come
// up EMPTY yet look perfectly healthy — every row written before the crash
// silently gone (confirmed live: pre-crash data vanished). The fix is to FAIL
// CLOSED on such a store instead of respawning: the worker's data is
// unrecoverable, so subsequent ops must reject with a clear data-loss error,
// never return a wrong-but-plausible empty result. These tests use the REAL
// worker thread (no mocks) exactly like the persistent-store suite above,
// killing it via terminate() to raise the same 'exit'-without-close signal an
// OOM kill would.
describe('OxigraphWorkerStore in-memory fail-closed on unexpected worker exit', () => {
  it('fails closed with a data-loss error after an in-memory worker crash — never a silent empty result', async () => {
    // No persistPath → in-memory store. This is the exact shape that silently
    // lost data before the fix.
    const store = makeStore(undefined);
    try {
      await store.insert(quads(7));
      // Sanity: the data really is there before the crash.
      expect(await store.countQuads('urn:test:g')).toBe(7);

      const before = internals(store).worker;
      await killWorker(store);

      // The store must NOT respawn (no disk to recover from) — it latches into
      // the terminal in_memory_lost state and never arms a replacement worker.
      expect(internals(store).lifecycle).toBe('in_memory_lost');
      expect(internals(store).respawnPromise).toBeNull();
      expect(internals(store).worker).toBe(before); // no fresh (empty) thread

      // The regression this guards: a read here used to RESOLVE with 0 (an
      // empty respawned store), reporting SUCCESS while all 7 rows were gone.
      // `.then(() => null, e => e)` captures a resolve as null and a reject as
      // the error, so a truthy `err` proves the read rejected rather than
      // silently returning the wrong count.
      const err: any = await store.countQuads('urn:test:g').then(() => null, (e) => e);
      expect(err).toBeTruthy();
      expect(err.message).toMatch(/IN-MEMORY store's worker crashed/);
      expect(err.message).toMatch(/data was lost|cannot be recovered/);

      // Writes fail closed the same way — the store is unusable, not read-only.
      await expect(store.insert(quads(1))).rejects.toThrow(/IN-MEMORY store's worker crashed/);
    } finally {
      // close() on a data-lost store must still resolve (idempotent teardown)
      // and must not resurrect it.
      await expect(store.close()).resolves.toBeUndefined();
    }
  });

  it('the in_memory_lost state is terminal — later traffic never arms a respawn', async () => {
    const store = makeStore(undefined);
    try {
      await store.insert(quads(3));
      await killWorker(store);
      expect(internals(store).lifecycle).toBe('in_memory_lost');

      // Hammer it with a few more ops: each must fail fast, and none may flip
      // the store back to 'respawning'/'live' (the terminal-state guarantee).
      for (let i = 0; i < 3; i += 1) {
        await expect(store.countQuads('urn:test:g')).rejects.toThrow(/cannot be recovered/);
        expect(internals(store).lifecycle).toBe('in_memory_lost');
        expect(internals(store).respawnPromise).toBeNull();
      }
    } finally {
      await store.close().catch(() => {});
    }
  });

  it('otReviewAgent #1408: the spawn→live transition is guarded — a spawn from a terminal state THROWS (never resurrects the store), but the two legal predecessors enter live', async () => {
    // The spawn path (spawnWorker → markSpawnedLive) is the one writer that
    // enters 'live'. It must still enforce terminal permanence: were a future
    // respawn/close code path to call it after close/give-up/in-memory-loss, it
    // has to throw rather than silently reopen the store. Poke the state field
    // directly (decoupled from the real worker) to drive the guard.
    const store = makeStore(undefined);
    const seam = store as unknown as {
      lifecycle: WorkerLifecycle;
      markSpawnedLive: () => void;
    };
    try {
      for (const terminal of ['closed', 'gave_up', 'in_memory_lost'] as const) {
        seam.lifecycle = terminal;
        expect(() => seam.markSpawnedLive()).toThrow(/illegal spawn transition|terminal/i);
        expect(seam.lifecycle).toBe(terminal); // stayed terminal — not resurrected
      }
      // 'closing' is likewise not a legal spawn predecessor.
      seam.lifecycle = 'closing';
      expect(() => seam.markSpawnedLive()).toThrow(/illegal spawn transition/i);
      // The two legal predecessors DO enter 'live'.
      for (const start of ['initializing', 'respawning'] as const) {
        seam.lifecycle = start;
        expect(() => seam.markSpawnedLive()).not.toThrow();
        expect(seam.lifecycle).toBe('live');
      }
    } finally {
      await store.close().catch(() => {});
    }
  });
});
