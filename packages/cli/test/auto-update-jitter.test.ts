import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveUpdateJitterMs,
  pickUpdateHoldoffMs,
  awaitUpdateHoldoff,
  createUpdateHoldoffGate,
  describeUpdateHold,
  MAX_HOLDOFF_OVERDUE_MS,
  UPDATE_JITTER_ENV,
  type UpdateHoldoffGateConfig,
  type UpdateHoldoffRecord,
  type UpdateHoldoffStep,
} from '../src/daemon/auto-update-jitter.js';
import {
  createFileUpdateHoldoffStore,
  parseUpdateHoldoffRecord,
  UPDATE_HOLDOFF_FILE,
  type UpdateHoldoffFs,
} from '../src/daemon/auto-update-holdoff-store.js';
import { createDaemonUpdateHoldoffGate } from '../src/daemon/auto-update-runner.js';

describe('resolveUpdateJitterMs', () => {
  it('uses the configured minutes when set', () => {
    expect(resolveUpdateJitterMs(10, 3, {})).toBe(10 * 60_000);
  });

  it('falls back to the poll interval when config is undefined (self-scaling)', () => {
    expect(resolveUpdateJitterMs(undefined, 30, {})).toBe(30 * 60_000);
  });

  it('env override wins over config and interval', () => {
    expect(resolveUpdateJitterMs(10, 3, { [UPDATE_JITTER_ENV]: '20' })).toBe(20 * 60_000);
  });

  it('0 disables via config or env', () => {
    expect(resolveUpdateJitterMs(0, 30, {})).toBe(0);
    expect(resolveUpdateJitterMs(10, 3, { [UPDATE_JITTER_ENV]: '0' })).toBe(0);
  });

  it('ignores an invalid / negative env value (falls back to config)', () => {
    expect(resolveUpdateJitterMs(5, 3, { [UPDATE_JITTER_ENV]: 'abc' })).toBe(5 * 60_000);
    expect(resolveUpdateJitterMs(5, 3, { [UPDATE_JITTER_ENV]: '-2' })).toBe(5 * 60_000);
  });

  it('clamps to a 12h maximum', () => {
    expect(resolveUpdateJitterMs(100_000, 3, {})).toBe(12 * 60 * 60_000);
  });

  it('treats a non-positive interval fallback as disabled', () => {
    expect(resolveUpdateJitterMs(undefined, 0, {})).toBe(0);
  });
});

describe('pickUpdateHoldoffMs', () => {
  it('returns 0 when jitter is disabled / non-positive', () => {
    expect(pickUpdateHoldoffMs(0)).toBe(0);
    expect(pickUpdateHoldoffMs(-1)).toBe(0);
  });

  it('returns a value in [0, jitterMs) for a valid rng', () => {
    expect(pickUpdateHoldoffMs(600_000, () => 0)).toBe(0);
    expect(pickUpdateHoldoffMs(600_000, () => 0.5)).toBe(300_000);
    expect(pickUpdateHoldoffMs(600_000, () => 0.999999)).toBeLessThan(600_000);
  });

  it('guards against a misbehaving rng (NaN / out-of-range)', () => {
    expect(pickUpdateHoldoffMs(600_000, () => Number.NaN)).toBe(0);
    expect(pickUpdateHoldoffMs(600_000, () => 1)).toBe(0);
    expect(pickUpdateHoldoffMs(600_000, () => -0.5)).toBe(0);
  });
});

describe('awaitUpdateHoldoff', () => {
  it('proceeds immediately without sleeping when jitter is disabled', async () => {
    const sleep = vi.fn(async () => {});
    const onHold = vi.fn();
    const decision = await awaitUpdateHoldoff({
      jitterMs: 0,
      isShuttingDown: () => false,
      onHold,
      sleep,
    });
    expect(decision).toBe('proceed');
    expect(sleep).not.toHaveBeenCalled();
    expect(onHold).not.toHaveBeenCalled();
  });

  it('sleeps the picked hold-off and reports the window via onHold, then proceeds', async () => {
    const sleep = vi.fn(async () => {});
    const onHold = vi.fn();
    const decision = await awaitUpdateHoldoff({
      jitterMs: 600_000,
      isShuttingDown: () => false,
      onHold,
      sleep,
      rng: () => 0.5,
    });
    expect(decision).toBe('proceed');
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(300_000);
    expect(onHold).toHaveBeenCalledWith(300_000, false);
  });

  it('aborts when the daemon began shutting down DURING the hold-off', async () => {
    let shuttingDown = false;
    // Flip the flag while the (fake) sleep is "in flight" — the shutdown bail
    // must be evaluated AFTER the wait, not before.
    const sleep = vi.fn(async () => {
      shuttingDown = true;
    });
    const decision = await awaitUpdateHoldoff({
      jitterMs: 600_000,
      isShuttingDown: () => shuttingDown,
      sleep,
      rng: () => 0.5,
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(decision).toBe('abort-shutdown');
  });

  it('with persistence, resumes the stored deadline for the same target instead of drawing', async () => {
    const store = {
      read: vi.fn(async (): Promise<UpdateHoldoffRecord | null> => ({ target: 'c1', deadlineEpochMs: 1_000 + 120_000 })),
      write: vi.fn(async (_record: UpdateHoldoffRecord) => {}),
      clear: vi.fn(async () => {}),
    };
    const rng = vi.fn(() => 0.5);
    const sleep = vi.fn(async () => {});
    const onHold = vi.fn();
    const decision = await awaitUpdateHoldoff({
      jitterMs: 600_000,
      isShuttingDown: () => false,
      onHold,
      sleep,
      rng,
      now: () => 1_000,
      persistence: { target: 'c1', store },
    });
    expect(decision).toBe('proceed');
    expect(rng).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledWith(120_000);
    expect(onHold).toHaveBeenCalledWith(120_000, true);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('aborts even with jitter disabled if already shutting down (never applies during shutdown)', async () => {
    const sleep = vi.fn(async () => {});
    const decision = await awaitUpdateHoldoff({
      jitterMs: 0,
      isShuttingDown: () => true,
      sleep,
    });
    expect(decision).toBe('abort-shutdown');
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('createUpdateHoldoffGate (the shared rollout gate)', () => {
  // Typed harness — the deps keep the real UpdateHoldoffGateConfig / Step types
  // so drift between the gate contract and the fixtures is a compile error.
  function harness(opts: {
    jitterMs?: number;
    isShuttingDown?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    revalidate?: () => Promise<string | null>;
    apply?: (t: string) => Promise<void>;
  } = {}) {
    const calls: string[] = [];
    const log = vi.fn((m: string) => { calls.push(`log:${m}`); });
    const setUpdating = vi.fn((v: boolean) => { calls.push(`setUpdating:${v}`); });
    const sleep = vi.fn(opts.sleep ?? (async () => { calls.push('sleep'); }));
    const revalidate = vi.fn(opts.revalidate ?? (async () => { calls.push('revalidate'); return 'v-fresh' as string | null; }));
    const apply = vi.fn(opts.apply ?? (async (t: string) => { calls.push(`apply:${t}`); }));
    const config: UpdateHoldoffGateConfig = {
      jitterMs: opts.jitterMs ?? 600_000,
      isShuttingDown: opts.isShuttingDown ?? (() => false),
      setUpdating,
      log,
      rng: () => 0.5,
      sleep,
    };
    const step: UpdateHoldoffStep<string> = {
      detectedTarget: 'v-detected',
      onHold: () => calls.push('onHold'),
      revalidate,
      apply,
      shutdownMessage: 'SHUTDOWN',
      supersededMessage: 'SUPERSEDED',
    };
    return { gate: createUpdateHoldoffGate(config), step, calls, log, setUpdating, sleep, revalidate, apply };
  }

  it('runs the gate in order and applies the REVALIDATED target (not the detected one)', async () => {
    const { gate, step, calls, apply } = harness();
    await gate.run(step);
    expect(calls).toEqual([
      'onHold', 'sleep', 'revalidate', 'setUpdating:true', 'apply:v-fresh', 'setUpdating:false',
    ]);
    expect(apply).toHaveBeenCalledWith('v-fresh');
  });

  it('holds single-flight WHILE a hold-off is in flight — a second tick during the wait is a no-op', async () => {
    // A hold-off that outlasts the poll interval must still block a second tick.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const revalidate = vi.fn(async () => 'v-fresh' as string | null);
    const apply = vi.fn(async () => {});
    const { gate, step } = harness({ sleep: () => held, revalidate, apply });

    const first = gate.run(step); // enters, sets pending, awaits the un-resolved hold-off
    await Promise.resolve();
    // Second concurrent tick while the first rollout is mid-hold-off:
    await gate.run(step);
    expect(revalidate, 'second tick must not start a second rollout').not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();

    release(); // let the first hold-off complete
    await first;
    expect(revalidate).toHaveBeenCalledTimes(1); // exactly ONE rollout ran
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does NOT apply a target withdrawn during the hold-off (revalidate -> null)', async () => {
    const { gate, step, apply, setUpdating, log } = harness({ revalidate: async () => null });
    await gate.run(step);
    expect(apply).not.toHaveBeenCalled();
    expect(setUpdating).not.toHaveBeenCalledWith(true);
    expect(log).toHaveBeenCalledWith('SUPERSEDED');
  });

  it('aborts before revalidate/apply when shutting down during the hold-off', async () => {
    let sd = false;
    const { gate, step, revalidate, apply, log } = harness({
      isShuttingDown: () => sd,
      sleep: async () => { sd = true; },
    });
    await gate.run(step);
    expect(revalidate).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('SHUTDOWN');
  });

  it('aborts AFTER revalidation if shutdown began during the (async) revalidate call', async () => {
    // The hold-off completes with shutdown=false, so revalidate runs; shutdown
    // then flips DURING revalidate. The gate must re-check and NOT apply.
    let sd = false;
    const { gate, step, apply, setUpdating, log } = harness({
      isShuttingDown: () => sd,
      revalidate: async () => { sd = true; return 'v-fresh'; },
    });
    await gate.run(step);
    expect(apply).not.toHaveBeenCalled();
    expect(setUpdating).not.toHaveBeenCalledWith(true);
    expect(log).toHaveBeenCalledWith('SHUTDOWN');
  });

  it('clears isUpdating (and recovers single-flight) even if apply throws', async () => {
    const { gate, step, setUpdating } = harness({ apply: async () => { throw new Error('boom'); } });
    await expect(gate.run(step)).rejects.toThrow('boom');
    expect(setUpdating).toHaveBeenLastCalledWith(false);
    // pending was cleared in finally, so the gate is usable again:
    const ok = vi.fn(async () => {});
    await gate.run({ ...step, apply: ok });
    expect(ok).toHaveBeenCalledOnce();
  });

  it('applies with no hold-off log/sleep when jitter is disabled', async () => {
    const { gate, step, calls } = harness({ jitterMs: 0 });
    await gate.run(step);
    expect(calls).toEqual(['revalidate', 'setUpdating:true', 'apply:v-fresh', 'setUpdating:false']);
  });
});

describe('describeUpdateHold', () => {
  it('words a fresh hold, a resumed hold and an already-passed deadline', () => {
    expect(describeUpdateHold(1_155_000, false))
      .toBe('holding 1155s before applying (rollout jitter — spreads fleet restarts).');
    expect(describeUpdateHold(75_000, true))
      .toBe('resuming the rollout hold-off carried over from before a restart — 75s left before applying.');
    expect(describeUpdateHold(0, true))
      .toBe('rollout hold-off deadline carried over from before a restart has passed — applying now.');
  });
});

// --- Persisted rollout deadline -------------------------------------------
//
// Incident this guards (2026-09-24): a git-mode node with a 30-min jitter window
// drew a 1155s hold, but its supervisor restarted the worker every 6-20 min.
// Each restart aborted the hold and each boot drew a fresh one, so the node
// never applied the fix. The deadline is now persisted per target, and a boot
// resumes whatever is left of it.

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
}

/** In-memory fs seam for the file-backed store. It outlives any single gate,
 *  like the DKG home outlives a daemon process. */
function memoryFs() {
  const files = new Map<string, string>();
  const fs: UpdateHoldoffFs = {
    readFile: async (path) => {
      const data = files.get(path);
      if (data === undefined) throw enoent(path);
      return data;
    },
    writeFile: async (path, data) => { files.set(path, data); },
    rename: async (from, to) => {
      const data = files.get(from);
      if (data === undefined) throw enoent(from);
      files.delete(from);
      files.set(to, data);
    },
    unlink: async (path) => {
      if (!files.delete(path)) throw enoent(path);
    },
  };
  return { files, fs };
}

const RECORD_PATH = `/dkg-home/${UPDATE_HOLDOFF_FILE}`;
const WINDOW_MS = 30 * 60_000;

/**
 * One node: a DKG home (in-memory fs) and a wall clock that survive restarts.
 * `boot()` models a fresh daemon process: a new gate over the same home, with
 * its own shutdown flag. `killAfterMs` makes the supervisor restart the worker
 * that far into any longer hold.
 */
function persistentNode(opts: {
  jitterMs?: number;
  wrapFs?: (fs: UpdateHoldoffFs) => UpdateHoldoffFs;
  persist?: boolean;
} = {}) {
  const mem = memoryFs();
  const clock = { t: 1_790_000_000_000 };
  const store = createFileUpdateHoldoffStore(RECORD_PATH, opts.wrapFs ? opts.wrapFs(mem.fs) : mem.fs);
  const logs: string[] = [];

  function record(): UpdateHoldoffRecord | null {
    const raw = mem.files.get(RECORD_PATH);
    return raw === undefined ? null : parseUpdateHoldoffRecord(raw);
  }

  function boot(b: { rng?: () => number; killAfterMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
    let shuttingDown = false;
    const rng = vi.fn(b.rng ?? (() => 0.5));
    const sleeps: number[] = [];
    const holds: Array<[number, boolean]> = [];
    const setUpdating = vi.fn();
    const sleep = vi.fn(b.sleep ?? (async (ms: number) => {
      sleeps.push(ms);
      if (b.killAfterMs !== undefined && ms > b.killAfterMs) {
        clock.t += b.killAfterMs;
        shuttingDown = true;
        return;
      }
      clock.t += ms;
    }));
    const gate = createUpdateHoldoffGate({
      jitterMs: opts.jitterMs ?? WINDOW_MS,
      isShuttingDown: () => shuttingDown,
      setUpdating,
      log: (m) => logs.push(m),
      store: opts.persist === false ? null : store,
      rng,
      now: () => clock.t,
      sleep,
    });
    const apply = vi.fn(async (_target: string) => {});
    const run = (target: string, overrides: Partial<UpdateHoldoffStep<string>> = {}) =>
      gate.run<string>({
        detectedTarget: target,
        onHold: (ms, resumed) => { holds.push([ms, resumed]); },
        revalidate: async () => target,
        apply,
        shutdownMessage: 'SHUTDOWN',
        supersededMessage: 'SUPERSEDED',
        ...overrides,
      });
    return { gate, run, apply, rng, sleep, sleeps, holds, setUpdating, shutDown: () => { shuttingDown = true; } };
  }

  return { mem, clock, store, logs, record, boot };
}

describe('createUpdateHoldoffGate — persisted rollout deadline', () => {
  it('a restart mid-hold resumes with the remaining time, not a fresh draw', async () => {
    const node = persistentNode();
    const detectedAt = node.clock.t;

    const first = node.boot({ rng: () => 0.5, killAfterMs: 6 * 60_000 });
    await first.run('c1');
    expect(first.holds).toEqual([[900_000, false]]);
    expect(first.apply).not.toHaveBeenCalled();
    expect(node.logs).toEqual(['SHUTDOWN']);
    expect(node.record()).toEqual({ target: 'c1', deadlineEpochMs: detectedAt + 900_000 });

    const second = node.boot({ rng: () => 0.99 });
    await second.run('c1');
    expect(second.rng, 'the deadline is drawn once per target').not.toHaveBeenCalled();
    expect(second.sleeps).toEqual([540_000]);
    expect(second.holds).toEqual([[540_000, true]]);
    expect(second.apply).toHaveBeenCalledWith('c1');
    expect(node.clock.t - detectedAt).toBe(900_000);
    expect(node.record(), 'settled once the apply returned').toBeNull();
  });

  it('a node restarted every 6 minutes still applies at the deadline drawn on first detection', async () => {
    const draw = () => 1155 / 1800; // the incident: 1155s of a 30-min window
    const drawnMs = pickUpdateHoldoffMs(WINDOW_MS, draw);
    const restartEveryMs = 6 * 60_000;

    const node = persistentNode();
    const detectedAt = node.clock.t;
    const rngCalls: number[] = [];
    let boots = 0;
    for (; boots < 10; boots++) {
      const b = node.boot({ rng: () => { rngCalls.push(boots); return draw(); }, killAfterMs: restartEveryMs });
      await b.run('c1');
      if (b.apply.mock.calls.length > 0) break;
    }
    expect(boots, 'applied on the 4th boot (3 restarts mid-hold)').toBe(3);
    expect(rngCalls).toEqual([0]);
    expect(node.clock.t - detectedAt).toBe(drawnMs);

    // Without persistence (the old behaviour) the same node never gets there.
    const legacy = persistentNode({ persist: false });
    for (let i = 0; i < 10; i++) {
      const b = legacy.boot({ rng: draw, killAfterMs: restartEveryMs });
      await b.run('c1');
      expect(b.apply).not.toHaveBeenCalled();
    }
  });

  it('an expired deadline applies immediately', async () => {
    const node = persistentNode();
    await node.store.write({ target: 'c1', deadlineEpochMs: node.clock.t - 60_000 });

    const b = node.boot();
    await b.run('c1');
    expect(b.rng).not.toHaveBeenCalled();
    expect(b.sleep).not.toHaveBeenCalled();
    expect(b.holds).toEqual([[0, true]]);
    expect(b.apply).toHaveBeenCalledWith('c1');
  });

  it('a changed target redraws and replaces the record', async () => {
    const node = persistentNode();
    await node.store.write({ target: 'c1', deadlineEpochMs: node.clock.t + 60_000 });
    const start = node.clock.t;

    const b = node.boot({ rng: () => 0.25, killAfterMs: 0 }); // stop inside the hold to inspect the record
    await b.run('c2');
    expect(b.rng).toHaveBeenCalledOnce();
    expect(b.holds).toEqual([[450_000, false]]);
    expect(node.record()).toEqual({ target: 'c2', deadlineEpochMs: start + 450_000 });
  });

  it.each([
    ['truncated JSON', '{"target":"c1","deadl'],
    ['wrong field types', JSON.stringify({ target: 42, deadlineEpochMs: 'soon' })],
    ['empty target', JSON.stringify({ target: '', deadlineEpochMs: 1 })],
    ['JSON null', 'null'],
  ])('a corrupt record (%s) falls back to a fresh draw without throwing', async (_label, raw) => {
    const node = persistentNode();
    node.mem.files.set(RECORD_PATH, raw);
    const start = node.clock.t;

    const b = node.boot({ rng: () => 0.5, killAfterMs: 0 });
    await expect(b.run('c1')).resolves.toBeUndefined();
    expect(b.rng).toHaveBeenCalledOnce();
    expect(b.holds).toEqual([[900_000, false]]);
    expect(node.logs.some((m) => m.includes('ignoring unreadable rollout hold-off record'))).toBe(true);
    expect(node.record(), 'replaced by a well-formed record').toEqual({ target: 'c1', deadlineEpochMs: start + 900_000 });
  });

  it('an unreadable, unwritable home still holds and applies (in memory) without throwing', async () => {
    const node = persistentNode({
      wrapFs: (fs) => ({
        ...fs,
        readFile: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
        writeFile: async () => { throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }); },
      }),
    });

    const b = node.boot({ rng: () => 0.5 });
    await expect(b.run('c1')).resolves.toBeUndefined();
    expect(b.sleeps).toEqual([900_000]);
    expect(b.apply).toHaveBeenCalledWith('c1');
    expect(node.logs.some((m) => m.includes('EACCES'))).toBe(true);
    expect(node.logs.some((m) => m.includes('could not persist the rollout hold-off deadline'))).toBe(true);
  });

  it('shutdown during the hold aborts cleanly and keeps the record for the next boot', async () => {
    const node = persistentNode();
    const revalidate = vi.fn(async () => 'c1' as string | null);

    const b = node.boot({ killAfterMs: 60_000 });
    await b.run('c1', { revalidate });
    expect(revalidate).not.toHaveBeenCalled();
    expect(b.apply).not.toHaveBeenCalled();
    expect(b.setUpdating).not.toHaveBeenCalled();
    expect(node.logs).toEqual(['SHUTDOWN']);
    expect(node.record()?.target).toBe('c1');
  });

  it('a restart during the apply keeps the record, so the next boot retries without a new hold', async () => {
    const node = persistentNode();
    const first = node.boot();
    // The apply is cut short by the restart (supervisor kill mid-build, or the
    // supervised restart after a successful install).
    await first.run('c1', { apply: async () => { first.shutDown(); } });
    expect(node.record()?.target).toBe('c1');

    const second = node.boot();
    await second.run('c1');
    expect(second.rng).not.toHaveBeenCalled();
    expect(second.sleep).not.toHaveBeenCalled();
    expect(second.apply).toHaveBeenCalledWith('c1');
  });

  it('drops the record when an apply returns without restarting (failed build), so the next detection redraws', async () => {
    const node = persistentNode();
    const b = node.boot();
    await expect(b.run('c1', { apply: async () => { throw new Error('build failed'); } })).rejects.toThrow('build failed');
    expect(node.record()).toBeNull();
  });

  it('drops the record when the target is withdrawn or caught up during the hold (revalidate -> null)', async () => {
    const node = persistentNode();
    const b = node.boot();
    await b.run('c1', { revalidate: async () => null });
    expect(node.logs).toEqual(['SUPERSEDED']);
    expect(b.apply).not.toHaveBeenCalled();
    expect(node.record()).toBeNull();
  });

  it('records a newer target found by revalidate as already due, so a restart mid-apply retries it at once', async () => {
    const node = persistentNode();
    const first = node.boot();
    let duringApply: UpdateHoldoffRecord | null = null;
    await first.run('c1', {
      revalidate: async () => 'c2',
      apply: async () => { duringApply = node.record(); first.shutDown(); },
    });
    expect(duringApply).toEqual({ target: 'c2', deadlineEpochMs: node.clock.t });

    const second = node.boot();
    await second.run('c2');
    expect(second.rng).not.toHaveBeenCalled();
    expect(second.sleep).not.toHaveBeenCalled();
    expect(second.apply).toHaveBeenCalledWith('c2');
  });

  it('redraws when the persisted deadline lies beyond the current window (window lowered, or clock moved back)', async () => {
    const node = persistentNode({ jitterMs: 5 * 60_000 });
    await node.store.write({ target: 'c1', deadlineEpochMs: node.clock.t + 20 * 60_000 });

    const b = node.boot({ rng: () => 0.5, killAfterMs: 0 });
    await b.run('c1');
    expect(b.rng).toHaveBeenCalledOnce();
    expect(b.holds).toEqual([[150_000, false]]);
  });

  it('honours a deadline up to MAX_HOLDOFF_OVERDUE_MS overdue and redraws an older one', async () => {
    const atCap = persistentNode();
    await atCap.store.write({ target: 'c1', deadlineEpochMs: atCap.clock.t - MAX_HOLDOFF_OVERDUE_MS });
    const onTime = atCap.boot();
    await onTime.run('c1');
    expect(onTime.holds).toEqual([[0, true]]);
    expect(onTime.apply).toHaveBeenCalledOnce();

    const stale = persistentNode();
    await stale.store.write({ target: 'c1', deadlineEpochMs: stale.clock.t - MAX_HOLDOFF_OVERDUE_MS - 1 });
    const redrawn = stale.boot({ rng: () => 0.5, killAfterMs: 0 });
    await redrawn.run('c1');
    expect(redrawn.rng).toHaveBeenCalledOnce();
    expect(redrawn.holds).toEqual([[900_000, false]]);
  });

  it('clearHold drops the record, except while an in-flight run owns it', async () => {
    const node = persistentNode();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const b = node.boot({ sleep: () => held });

    const running = b.run('c1');
    await vi.waitFor(() => expect(node.record()?.target).toBe('c1'));
    await b.gate.clearHold();
    expect(node.record()?.target, 'the in-flight run owns the record').toBe('c1');
    release();
    await running;
    expect(node.record()).toBeNull();

    await node.store.write({ target: 'c9', deadlineEpochMs: node.clock.t });
    await b.gate.clearHold();
    expect(node.record()).toBeNull();
    await expect(b.gate.clearHold(), 'idempotent when there is no record').resolves.toBeUndefined();
  });

  it('a clearHold that starts before a run cannot delete the deadline that run writes', async () => {
    // clearHold's unlink stalls until released. Without serialization the run
    // reads the old record, writes its own, and the stalled unlink then deletes
    // it, so a restart during the hold would draw a fresh hold again.
    let unlinkEntered!: () => void;
    const entered = new Promise<void>((r) => { unlinkEntered = r; });
    let releaseUnlink!: () => void;
    const unlinkReleased = new Promise<void>((r) => { releaseUnlink = r; });
    const node = persistentNode({
      wrapFs: (fs) => ({
        ...fs,
        unlink: async (path) => {
          unlinkEntered();
          await unlinkReleased;
          return fs.unlink(path);
        },
      }),
    });
    await node.store.write({ target: 'c-old', deadlineEpochMs: node.clock.t });
    let releaseHold!: () => void;
    const held = new Promise<void>((r) => { releaseHold = r; });
    const first = node.boot({ sleep: () => held });

    const clearing = first.gate.clearHold();
    await entered; // the clear is in flight
    const running = first.run('c1');
    // Let the run get as far as it can (the in-memory fs is all microtasks)
    // before the stalled unlink completes.
    await new Promise<void>((r) => { setImmediate(r); });
    releaseUnlink();
    await clearing;
    await vi.waitFor(() => expect(node.record()?.target).toBe('c1'));
    expect(node.record()).toEqual({ target: 'c1', deadlineEpochMs: node.clock.t + 900_000 });

    // The daemon restarts during that hold: the next boot resumes c1's deadline.
    const second = node.boot({ rng: () => 0.99 });
    await second.run('c1');
    expect(second.rng).not.toHaveBeenCalled();
    expect(second.holds).toEqual([[900_000, true]]);
    expect(second.apply).toHaveBeenCalledWith('c1');

    releaseHold();
    await running;
  });

  it('writes no record when jitter is disabled', async () => {
    const node = persistentNode({ jitterMs: 0 });
    const b = node.boot();
    await b.run('c1', { revalidate: async () => 'c2' });
    expect(b.apply).toHaveBeenCalledWith('c2');
    expect(node.mem.files.size).toBe(0);
  });
});

describe('createFileUpdateHoldoffStore', () => {
  it('round-trips a record through the real filesystem and leaves no temp file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-update-holdoff-'));
    try {
      const store = createFileUpdateHoldoffStore(join(dir, UPDATE_HOLDOFF_FILE));
      expect(await store.read()).toBeNull();
      await store.write({ target: 'abc123', deadlineEpochMs: 1_000 });
      await store.write({ target: 'def456', deadlineEpochMs: 2_000 });
      expect(await store.read()).toEqual({ target: 'def456', deadlineEpochMs: 2_000 });
      expect(await readdir(dir)).toEqual([UPDATE_HOLDOFF_FILE]);
      await store.clear();
      await store.clear();
      expect(await store.read()).toBeNull();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws on a malformed record so the gate can log it, and returns null only when absent', async () => {
    const mem = memoryFs();
    const store = createFileUpdateHoldoffStore(RECORD_PATH, mem.fs);
    expect(await store.read()).toBeNull();
    mem.files.set(RECORD_PATH, '{"target":');
    await expect(store.read()).rejects.toThrow();
  });

  it('removes the temp file and surfaces the error when the rename fails', async () => {
    const mem = memoryFs();
    const store = createFileUpdateHoldoffStore(RECORD_PATH, {
      ...mem.fs,
      rename: async () => { throw new Error('EXDEV: cross-device link not permitted'); },
    });
    await expect(store.write({ target: 'c1', deadlineEpochMs: 1 })).rejects.toThrow('EXDEV');
    expect([...mem.files.keys()]).toEqual([]);
  });
});

describe('createDaemonUpdateHoldoffGate (the gate lifecycle.ts builds for git and npm modes)', () => {
  it('keeps the deadline in <DKG home>/.update-holdoff.json, so the next boot resumes it', async () => {
    vi.stubEnv(UPDATE_JITTER_ENV, undefined);
    const home = await mkdtemp(join(tmpdir(), 'dkg-home-holdoff-'));
    const clock = { t: 1_790_000_000_000 };
    const au = { updateJitterMinutes: 30, checkIntervalMinutes: 3 };
    function boot(rng: () => number, killAfterMs?: number) {
      let shuttingDown = false;
      const sleeps: number[] = [];
      const gate = createDaemonUpdateHoldoffGate(
        { au, dkgHome: home, isShuttingDown: () => shuttingDown, setUpdating: () => {}, log: () => {} },
        {
          rng,
          now: () => clock.t,
          sleep: async (ms) => {
            sleeps.push(ms);
            if (killAfterMs !== undefined && ms > killAfterMs) {
              clock.t += killAfterMs;
              shuttingDown = true;
              return;
            }
            clock.t += ms;
          },
        },
      );
      const apply = vi.fn(async (_target: string) => {});
      const run = () => gate.run<string>({
        detectedTarget: 'c1',
        onHold: () => {},
        revalidate: async () => 'c1',
        apply,
        shutdownMessage: 'SHUTDOWN',
        supersededMessage: 'SUPERSEDED',
      });
      return { run, apply, sleeps };
    }

    try {
      const detectedAt = clock.t;
      const first = boot(() => 0.5, 6 * 60_000);
      await first.run();
      expect(first.apply).not.toHaveBeenCalled();
      const raw = await readFile(join(home, UPDATE_HOLDOFF_FILE), 'utf-8');
      expect(parseUpdateHoldoffRecord(raw)).toEqual({ target: 'c1', deadlineEpochMs: detectedAt + 900_000 });

      const rng = vi.fn(() => 0.99);
      const second = boot(rng);
      await second.run();
      expect(rng).not.toHaveBeenCalled();
      expect(second.sleeps).toEqual([540_000]);
      expect(second.apply).toHaveBeenCalledWith('c1');
      expect(await readdir(home)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('is how lifecycle.ts builds both auto-update gates (git and npm), rooted at the DKG home', () => {
    // runDaemonInner cannot be driven to its auto-update section in a unit test,
    // so guard the call sites: a gate built any other way would lose the
    // persisted deadline and bring back the restart starvation.
    const src = readFileSync(new URL('../src/daemon/lifecycle.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/\bcreateUpdateHoldoffGate\s*\(/);
    expect(src.match(/\bcreateDaemonUpdateHoldoffGate\(\{[^}]*dkgHome: dkgDir\(\)/g)).toHaveLength(2);
  });
});
