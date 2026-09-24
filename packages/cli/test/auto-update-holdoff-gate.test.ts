import { describe, it, expect, vi } from 'vitest';
import { pickUpdateHoldoffMs } from '../src/daemon/auto-update-jitter.js';
import {
  createPersistedHoldoffDeadline,
  createVolatileHoldoffDeadline,
  MAX_HOLDOFF_OVERDUE_MS,
  type UpdateHoldoffRecord,
} from '../src/daemon/auto-update-holdoff-deadline.js';
import {
  createUpdateHoldoffGate,
  type UpdateCheckOutcome,
  type UpdateHoldoffGateConfig,
  type UpdateHoldoffStep,
} from '../src/daemon/auto-update-holdoff-gate.js';
import {
  createFileUpdateHoldoffStore,
  parseUpdateHoldoffRecord,
  UPDATE_HOLDOFF_FILE,
  type UpdateHoldoffFs,
} from '../src/daemon/auto-update-holdoff-store.js';
import { memoryFs } from './_helpers/holdoff-memory-fs.js';

const available = (target: string): UpdateCheckOutcome<string> => ({ status: 'available', target });

describe('createUpdateHoldoffGate (the shared rollout gate)', () => {
  const DETECTED: UpdateCheckOutcome<string> = { status: 'available', target: 'v-detected' };
  const FRESH: UpdateCheckOutcome<string> = { status: 'available', target: 'v-fresh' };

  // Typed harness — the deps keep the real UpdateHoldoffGateConfig / Step types
  // so drift between the gate contract and the fixtures is a compile error.
  function harness(opts: {
    jitterMs?: number;
    isShuttingDown?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    revalidate?: () => Promise<UpdateCheckOutcome<string>>;
    apply?: (t: string) => Promise<void>;
  } = {}) {
    const calls: string[] = [];
    const log = vi.fn((m: string) => { calls.push(`log:${m}`); });
    const setUpdating = vi.fn((v: boolean) => { calls.push(`setUpdating:${v}`); });
    const sleep = vi.fn(opts.sleep ?? (async () => { calls.push('sleep'); }));
    const revalidate = vi.fn(opts.revalidate ?? (async () => { calls.push('revalidate'); return FRESH; }));
    const apply = vi.fn(opts.apply ?? (async (t: string) => { calls.push(`apply:${t}`); }));
    const config: UpdateHoldoffGateConfig = {
      deadline: createVolatileHoldoffDeadline({ jitterMs: opts.jitterMs ?? 600_000, rng: () => 0.5 }),
      isShuttingDown: opts.isShuttingDown ?? (() => false),
      setUpdating,
      log,
      sleep,
    };
    const step: UpdateHoldoffStep<string> = {
      onHold: () => { calls.push('onHold'); },
      revalidate,
      apply,
      shutdownMessage: 'SHUTDOWN',
      supersededMessage: 'SUPERSEDED',
      recheckFailedMessage: 'RECHECK_FAILED',
    };
    const gate = createUpdateHoldoffGate(config);
    return { gate, poll: gate.bindRollout(step), step, calls, log, setUpdating, sleep, revalidate, apply };
  }

  it('runs the gate in order and applies the REVALIDATED target (not the detected one)', async () => {
    const { poll, calls, apply } = harness();
    await poll(DETECTED);
    expect(calls).toEqual([
      'onHold', 'sleep', 'revalidate', 'setUpdating:true', 'apply:v-fresh', 'setUpdating:false',
    ]);
    expect(apply).toHaveBeenCalledWith('v-fresh');
  });

  it('holds single-flight WHILE a hold-off is in flight — a second tick during the wait is a no-op', async () => {
    // A hold-off that outlasts the poll interval must still block a second tick.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const revalidate = vi.fn(async () => FRESH);
    const apply = vi.fn(async () => {});
    const { poll } = harness({ sleep: () => held, revalidate, apply });

    const first = poll(DETECTED); // enters, sets pending, awaits the un-resolved hold-off
    await Promise.resolve();
    // Second concurrent tick while the first rollout is mid-hold-off:
    await poll(DETECTED);
    expect(revalidate, 'second tick must not start a second rollout').not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();

    release(); // let the first hold-off complete
    await first;
    expect(revalidate).toHaveBeenCalledTimes(1); // exactly ONE rollout ran
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does NOT apply a target withdrawn during the hold-off (re-check -> none)', async () => {
    const { poll, apply, setUpdating, log } = harness({ revalidate: async () => ({ status: 'none' }) });
    await poll(DETECTED);
    expect(apply).not.toHaveBeenCalled();
    expect(setUpdating).not.toHaveBeenCalledWith(true);
    expect(log).toHaveBeenCalledWith('SUPERSEDED');
  });

  it('aborts before revalidate/apply when shutting down during the hold-off', async () => {
    let sd = false;
    const { poll, revalidate, apply, log } = harness({
      isShuttingDown: () => sd,
      sleep: async () => { sd = true; },
    });
    await poll(DETECTED);
    expect(revalidate).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('SHUTDOWN');
  });

  it('aborts AFTER revalidation if shutdown began during the (async) revalidate call', async () => {
    // The hold-off completes with shutdown=false, so revalidate runs; shutdown
    // then flips DURING revalidate. The gate must re-check and NOT apply.
    let sd = false;
    const { poll, apply, setUpdating, log } = harness({
      isShuttingDown: () => sd,
      revalidate: async () => { sd = true; return FRESH; },
    });
    await poll(DETECTED);
    expect(apply).not.toHaveBeenCalled();
    expect(setUpdating).not.toHaveBeenCalledWith(true);
    expect(log).toHaveBeenCalledWith('SHUTDOWN');
  });

  it('clears isUpdating (and recovers single-flight) even if apply throws', async () => {
    const { gate, poll, step, setUpdating } = harness({ apply: async () => { throw new Error('boom'); } });
    await expect(poll(DETECTED)).rejects.toThrow('boom');
    expect(setUpdating).toHaveBeenLastCalledWith(false);
    // pending was cleared in finally, so the gate is usable again:
    const ok = vi.fn(async () => {});
    await gate.bindRollout({ ...step, apply: ok })(DETECTED);
    expect(ok).toHaveBeenCalledOnce();
  });

  it('does NOT apply when the re-check itself failed', async () => {
    const { poll, apply, setUpdating, log } = harness({ revalidate: async () => ({ status: 'failed' }) });
    await poll(DETECTED);
    expect(apply).not.toHaveBeenCalled();
    expect(setUpdating).not.toHaveBeenCalledWith(true);
    expect(log).toHaveBeenCalledWith('RECHECK_FAILED');
  });

  it('never starts a rollout for a none or failed poll', async () => {
    const { poll, calls } = harness();
    await poll({ status: 'none' });
    await poll({ status: 'failed' });
    expect(calls).toEqual([]);
  });

  it('applies with no hold-off log/sleep when jitter is disabled', async () => {
    const { poll, calls } = harness({ jitterMs: 0 });
    await poll(DETECTED);
    expect(calls).toEqual(['revalidate', 'setUpdating:true', 'apply:v-fresh', 'setUpdating:false']);
  });
});

// --- Persisted rollout deadline -------------------------------------------
//
// Incident this guards (2026-09-24): a git-mode node with a 30-min jitter window
// drew a 1155s hold, but its supervisor restarted the worker every 6-20 min.
// Each restart aborted the hold and each boot drew a fresh one, so the node
// never applied the fix. The deadline is now persisted per target, and a boot
// resumes whatever is left of it.

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
    const jitterMs = opts.jitterMs ?? WINDOW_MS;
    const log = (m: string) => { logs.push(m); };
    const gate = createUpdateHoldoffGate({
      deadline: opts.persist === false
        ? createVolatileHoldoffDeadline({ jitterMs, rng })
        : createPersistedHoldoffDeadline({ store, jitterMs, log, rng, now: () => clock.t }),
      isShuttingDown: () => shuttingDown,
      setUpdating,
      log,
      sleep,
    });
    const apply = vi.fn(async (_target: string) => {});
    // One rollout bound per boot, as each daemon mode does. By default the
    // re-check confirms the detected target; a run can override that or the apply.
    let detected = '';
    let overrides: Pick<Partial<UpdateHoldoffStep<string>>, 'revalidate' | 'apply'> = {};
    const poll = gate.bindRollout<string>({
      onHold: (_target, ms, resumed) => { holds.push([ms, resumed]); },
      revalidate: () => (overrides.revalidate ?? (async () => available(detected)))(),
      apply: (target) => (overrides.apply ?? apply)(target),
      shutdownMessage: 'SHUTDOWN',
      supersededMessage: 'SUPERSEDED',
      recheckFailedMessage: 'RECHECK_FAILED',
    });
    /** A poll that detected `target`. */
    const run = (target: string, runOverrides: typeof overrides = {}) => {
      detected = target;
      overrides = runOverrides;
      return poll(available(target));
    };
    /** A poll that found nothing to apply (up to date / withdrawn). */
    const pollNone = () => poll({ status: 'none' });
    /** A poll whose check itself failed. */
    const pollFailed = () => poll({ status: 'failed' });
    return { run, pollNone, pollFailed, apply, rng, sleep, sleeps, holds, setUpdating, shutDown: () => { shuttingDown = true; } };
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
    const revalidate = vi.fn(async () => available('c1'));

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

  it('drops the record when the target is withdrawn or caught up during the hold (re-check -> none)', async () => {
    const node = persistentNode();
    const b = node.boot();
    await b.run('c1', { revalidate: async () => ({ status: 'none' }) });
    expect(node.logs).toEqual(['SUPERSEDED']);
    expect(b.apply).not.toHaveBeenCalled();
    expect(node.record()).toBeNull();
  });

  it('records a newer target found by revalidate as already due, so a restart mid-apply retries it at once', async () => {
    const node = persistentNode();
    const first = node.boot();
    let duringApply: UpdateHoldoffRecord | null = null;
    await first.run('c1', {
      revalidate: async () => available('c2'),
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

  it('a none poll drops the record, except while an in-flight rollout owns it', async () => {
    const node = persistentNode();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const b = node.boot({ sleep: () => held });

    const running = b.run('c1');
    await vi.waitFor(() => expect(node.record()?.target).toBe('c1'));
    await b.pollNone();
    expect(node.record()?.target, 'the in-flight run owns the record').toBe('c1');
    release();
    await running;
    expect(node.record()).toBeNull();

    await node.store.write({ target: 'c9', deadlineEpochMs: node.clock.t });
    await b.pollNone();
    expect(node.record()).toBeNull();
    await expect(b.pollNone(), 'idempotent when there is no record').resolves.toBeUndefined();

    await node.store.write({ target: 'c9', deadlineEpochMs: node.clock.t });
    await b.pollFailed();
    expect(node.record()?.target, 'a failed check keeps the record').toBe('c9');
  });

  it('a rollout that starts while a none poll is clearing is a no-op, so the clear cannot delete its deadline', async () => {
    // The clear's unlink stalls until released. If the rollout went ahead, it would
    // read the old record, write its own, and the stalled unlink would then
    // delete it, so a restart during the hold would draw a fresh hold again.
    let unlinkEntered!: () => void;
    const entered = new Promise<void>((r) => { unlinkEntered = r; });
    let releaseUnlink!: () => void;
    const unlinkReleased = new Promise<void>((r) => { releaseUnlink = r; });
    let stall = true;
    const node = persistentNode({
      wrapFs: (fs) => ({
        ...fs,
        unlink: async (path) => {
          if (stall) {
            unlinkEntered();
            await unlinkReleased;
          }
          return fs.unlink(path);
        },
      }),
    });
    await node.store.write({ target: 'c-old', deadlineEpochMs: node.clock.t });
    const first = node.boot({ killAfterMs: 0 }); // the run's hold ends in a restart

    const clearing = first.pollNone();
    await entered; // the clear is in flight
    await first.run('c1');
    expect(first.rng, 'the run yielded to the in-flight clear').not.toHaveBeenCalled();
    releaseUnlink();
    await clearing;
    expect(node.record()).toBeNull();
    stall = false;

    // The next poll's run writes its deadline, and nothing deletes it.
    await first.run('c1');
    expect(first.rng).toHaveBeenCalledOnce();
    expect(node.record()).toEqual({ target: 'c1', deadlineEpochMs: node.clock.t + 900_000 });

    // The daemon restarts during that hold: the next boot resumes c1's deadline.
    const second = node.boot({ rng: () => 0.99 });
    await second.run('c1');
    expect(second.rng).not.toHaveBeenCalled();
    expect(second.holds).toEqual([[900_000, true]]);
    expect(second.apply).toHaveBeenCalledWith('c1');
  });

  it('a failed re-check after the hold keeps the deadline; the next poll applies without a new hold', async () => {
    const node = persistentNode();
    const first = node.boot({ rng: () => 0.5 });
    await first.run('c1', { revalidate: async () => ({ status: 'failed' }) });
    expect(first.apply).not.toHaveBeenCalled();
    expect(first.setUpdating).not.toHaveBeenCalled();
    expect(node.logs).toEqual(['RECHECK_FAILED']);
    const deadline = node.record();
    expect(deadline?.target).toBe('c1');
    expect(deadline!.deadlineEpochMs).toBeLessThanOrEqual(node.clock.t);

    await first.run('c1');
    expect(first.rng, 'drawn once, on first detection').toHaveBeenCalledOnce();
    expect(first.holds).toEqual([[900_000, false], [0, true]]);
    expect(first.apply).toHaveBeenCalledWith('c1');
  });

  it('shutdown during the write of a newer target stops before the apply and keeps that target', async () => {
    let writeEntered!: () => void;
    const entered = new Promise<void>((r) => { writeEntered = r; });
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>((r) => { releaseWrite = r; });
    const node = persistentNode({
      wrapFs: (fs) => ({
        ...fs,
        writeFile: async (path, data) => {
          if (data.includes('"c2"')) {
            writeEntered();
            await writeReleased;
          }
          return fs.writeFile(path, data);
        },
      }),
    });
    const b = node.boot();

    const running = b.run('c1', { revalidate: async () => available('c2') });
    await entered;
    b.shutDown(); // SIGTERM while the new target is being recorded
    releaseWrite();
    await running;
    expect(b.apply).not.toHaveBeenCalled();
    expect(b.setUpdating).not.toHaveBeenCalled();
    expect(node.logs).toEqual(['SHUTDOWN']);
    expect(node.record()).toEqual({ target: 'c2', deadlineEpochMs: node.clock.t });
  });

  it('a record that cannot be removed is logged and never breaks the update flow', async () => {
    const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const node = persistentNode({ wrapFs: (fs) => ({ ...fs, unlink: async () => { throw eacces(); } }) });
    const removalFailures = () => node.logs.filter((m) => m.includes('could not remove the rollout hold-off record')).length;

    const b = node.boot();
    await expect(b.run('c1')).resolves.toBeUndefined(); // apply returns, then the clear fails
    expect(b.apply).toHaveBeenCalledWith('c1');
    expect(b.setUpdating).toHaveBeenLastCalledWith(false);
    expect(removalFailures()).toBe(1);

    await expect(b.run('c1', { revalidate: async () => ({ status: 'none' }) })).resolves.toBeUndefined(); // superseded
    expect(removalFailures()).toBe(2);

    await expect(b.pollNone()).resolves.toBeUndefined(); // up-to-date poll
    expect(removalFailures()).toBe(3);

    // Single-flight was released each time: the gate still runs.
    await b.run('c1');
    expect(b.apply).toHaveBeenCalledTimes(2);
  });

  it('a failed write keeps the deadline in memory: after a failed re-check the next poll resumes it', async () => {
    const node = persistentNode({
      wrapFs: (fs) => ({
        ...fs,
        writeFile: async () => { throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }); },
      }),
    });
    const b = node.boot({ rng: () => 0.5 });

    await b.run('c1', { revalidate: async () => ({ status: 'failed' }) });
    expect(node.record(), 'nothing reached the disk').toBeNull();

    await b.run('c1');
    expect(b.rng, 'drawn once, on first detection').toHaveBeenCalledOnce();
    expect(b.holds).toEqual([[900_000, false], [0, true]]);
    expect(b.apply).toHaveBeenCalledWith('c1');
  });

  it('a failed clear does not bring the stale deadline back within the same process', async () => {
    const node = persistentNode({
      wrapFs: (fs) => ({
        ...fs,
        unlink: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
      }),
    });
    await node.store.write({ target: 'c1', deadlineEpochMs: node.clock.t - 60_000 }); // due
    const b = node.boot({ rng: () => 0.5 });

    await b.run('c1'); // resumes the due deadline, applies, then fails to remove it
    expect(b.apply).toHaveBeenCalledOnce();
    expect(node.record()?.target, 'still on disk').toBe('c1');

    await b.run('c1'); // e.g. the build failed and the target is detected again
    expect(b.rng, 'a fresh hold, not the stale due deadline').toHaveBeenCalledOnce();
    expect(b.holds).toEqual([[0, true], [900_000, false]]);
  });

  it('a poll after shutdown began writes no deadline and starts nothing', async () => {
    const node = persistentNode();
    const b = node.boot();
    b.shutDown();
    await b.run('c1');
    expect(b.rng).not.toHaveBeenCalled();
    expect(b.apply).not.toHaveBeenCalled();
    expect(node.record()).toBeNull();
  });

  it('writes no record when jitter is disabled', async () => {
    const node = persistentNode({ jitterMs: 0 });
    const b = node.boot();
    await b.run('c1', { revalidate: async () => available('c2') });
    expect(b.apply).toHaveBeenCalledWith('c2');
    expect(node.mem.files.size).toBe(0);
  });
});
