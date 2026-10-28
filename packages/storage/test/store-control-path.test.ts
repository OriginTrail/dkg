import { afterEach, describe, expect, it, vi } from 'vitest';
import { backpressureRegistry } from '@origintrail-official/dkg-core';
import {
  StorePriorityScheduler,
  externalStorePriorityScheduler,
} from '../src/store-priority-scheduler.js';
import {
  StoreSchedulerStats,
  registerStoreSchedulerStats,
  takeStoreSchedulerStatsReports,
} from '../src/store-scheduler-stats.js';
import {
  STORE_CONTROL_DEFAULT_BACKENDS,
  STORE_CONTROL_MAX_SLOTS,
  STORE_CONTROL_RESERVED_SLOTS_ENV,
  buildStoreControlPath,
  controlStoreOptions,
  defaultStoreControlSlots,
  describeStoreControlPath,
  getStoreControlPath,
  logStoreControlPathGeometry,
  registerStoreControlPath,
  resolveStoreControlConfig,
  selectStoreScheduler,
  setStoreControlPathForTesting,
} from '../src/store-control-path.js';

const registeredIds = () => backpressureRegistry.capture().schedulers.map((scheduler) => scheduler.scheduler);
const statsIds = () => takeStoreSchedulerStatsReports().map((report) => report.scheduler);

afterEach(() => {
  setStoreControlPathForTesting(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('DKG_STORE_CONTROL_RESERVED_SLOTS', () => {
  it('is off by default in a process that configured no backend, on any host', () => {
    for (const cpus of [1, 2, 3, 4, 64]) {
      expect(resolveStoreControlConfig(undefined, { cpus })).toEqual({
        slots: { share: 0, publisher: 0 }, source: 'default', reason: 'default: no store backend configured', warnings: [],
      });
    }
  });

  it.each(['', ' ', '   ', '\t', ' \n '])(
    'refuses the set-but-blank value %j with a warning and leaves the path off, even when the default is on',
    (blank) => {
      // Set-but-blank is a typo (`VAR=` from a template or a shell), not "unset": it must not mean the default,
      // or a mistyped rollback would leave the path on once the default is switched on.
      for (const backend of [undefined, 'blazegraph', 'oxigraph-server']) {
        for (const cpus of [1, 2, 8, 64]) {
          const config = resolveStoreControlConfig(blank, { cpus, backend });
          expect(config.slots, `${cpus} CPUs, backend ${backend}`).toEqual({ share: 0, publisher: 0 });
          expect(config.source).toBe('refused');
          expect(config.warnings).toHaveLength(1);
          expect(config.warnings[0]).toContain(STORE_CONTROL_RESERVED_SLOTS_ENV);
          expect(config.warnings[0]).toContain('blank');
          expect(config.warnings[0]).toContain('stays off');
        }
      }
      // Only a truly unset value means the default.
      expect(resolveStoreControlConfig(undefined, { cpus: 8, backend: 'blazegraph' }))
        .toMatchObject({ slots: { share: 1, publisher: 2 }, source: 'default', warnings: [] });
    },
  );

  it('is share 1 + publisher 2 for Blazegraph and managed oxigraph-server, with no added slots on hosts of 2 or fewer CPUs', () => {
    expect(STORE_CONTROL_DEFAULT_BACKENDS).toEqual(['blazegraph', 'oxigraph-server']);
    for (const backend of ['blazegraph', 'oxigraph-server']) {
      expect(defaultStoreControlSlots(8, backend)).toEqual({ share: 1, publisher: 2 });
      expect(defaultStoreControlSlots(3, backend)).toEqual({ share: 1, publisher: 2 });
      for (const cpus of [1, 2]) expect(defaultStoreControlSlots(cpus, backend)).toEqual({ share: 0, publisher: 0 });
    }
    expect(defaultStoreControlSlots(8, 'sparql-http')).toEqual({ share: 0, publisher: 0 });
    expect(defaultStoreControlSlots(8)).toEqual({ share: 0, publisher: 0 });

    expect(resolveStoreControlConfig(undefined, { cpus: 4, backend: 'blazegraph' }))
      .toMatchObject({ slots: { share: 1, publisher: 2 }, source: 'default' });
    expect(resolveStoreControlConfig(undefined, { cpus: 2, backend: 'blazegraph' }))
      .toMatchObject({ slots: { share: 0, publisher: 0 }, source: 'default' });
    // The caps are the hard maximum: 3 added slots in total.
    expect(STORE_CONTROL_MAX_SLOTS).toEqual({ share: 1, publisher: 2 });
  });

  it('turns the whole path off with 0', () => {
    expect(resolveStoreControlConfig('0', { cpus: 8, backend: 'blazegraph' })).toEqual({
      slots: { share: 0, publisher: 0 }, source: 'env', reason: `${STORE_CONTROL_RESERVED_SLOTS_ENV}=0`, warnings: [],
    });
    expect(resolveStoreControlConfig(' 0 ', { cpus: 8, backend: 'blazegraph' }).slots).toEqual({ share: 0, publisher: 0 });
  });

  it('takes per-queue values, and a queue left out gets 0', () => {
    expect(resolveStoreControlConfig('share:1,publisher:2')).toEqual({
      slots: { share: 1, publisher: 2 }, source: 'env', reason: `${STORE_CONTROL_RESERVED_SLOTS_ENV}=share:1,publisher:2`, warnings: [],
    });
    expect(resolveStoreControlConfig('publisher:1').slots).toEqual({ share: 0, publisher: 1 });
    expect(resolveStoreControlConfig('share:1').slots).toEqual({ share: 1, publisher: 0 });
    expect(resolveStoreControlConfig('share:0,publisher:2').slots).toEqual({ share: 0, publisher: 2 });
    expect(resolveStoreControlConfig(' Share : 1 , PUBLISHER:2 ').slots).toEqual({ share: 1, publisher: 2 });
  });

  it('honours an explicit value on a host of 2 or fewer CPUs', () => {
    for (const cpus of [1, 2]) {
      expect(resolveStoreControlConfig('share:1,publisher:2', { cpus, backend: 'blazegraph' }))
        .toMatchObject({ slots: { share: 1, publisher: 2 }, source: 'env' });
      expect(resolveStoreControlConfig('share:1,publisher:2', { cpus }).slots).toEqual({ share: 1, publisher: 2 });
    }
  });

  it('clamps a value above a queue\'s cap, with a warning', () => {
    const config = resolveStoreControlConfig('share:3,publisher:9');
    expect(config.slots).toEqual({ share: 1, publisher: 2 });
    expect(config.source).toBe('env');
    expect(config.warnings).toHaveLength(2);
    expect(config.warnings[0]).toContain('share:3');
    expect(config.warnings[1]).toContain('publisher:9');
    // Only the queue above its cap is clamped.
    const partial = resolveStoreControlConfig('share:1,publisher:3');
    expect(partial.slots).toEqual({ share: 1, publisher: 2 });
    expect(partial.warnings).toHaveLength(1);
    expect(resolveStoreControlConfig('share:99999999999999999999').slots.share).toBe(1);
  });

  it.each([
    '1', '2', 'on', 'true', 'off', 'share', 'share:', ':1', 'share:-1', 'share:1.5', 'share:one', 'share=1',
    'share:1;publisher:2', 'share:1 publisher:2', 'share:1,', ',', 'share:1,share:1', 'share:1,SHARE:0',
    'other:1', 'share:1,other:1', '00', '-1', '0,0', '0:1', 'share:1,publisher:2,share:1', 'NaN',
  ])('refuses the malformed value %j with a warning and leaves the path off', (raw) => {
    const config = resolveStoreControlConfig(raw, { cpus: 8, backend: 'blazegraph' });
    expect(config.slots).toEqual({ share: 0, publisher: 0 });
    expect(config.source).toBe('refused');
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain(STORE_CONTROL_RESERVED_SLOTS_ENV);
    expect(config.warnings[0]).toContain('stays off');
  });

  it('bounds how much of a malformed value its warning repeats', () => {
    const [warning] = resolveStoreControlConfig('x'.repeat(500)).warnings;
    expect(warning.length).toBeLessThan(250);
  });
});

describe('buildStoreControlPath', () => {
  const sharedWith = (normalQueueLimit: number, queueWaitTimeoutMs: number) =>
    ({ snapshot: { normalQueueLimit, queueWaitTimeoutMs } }) as Pick<StorePriorityScheduler, 'snapshot'>;

  it('builds an instance only for a queue whose slots are above 0', () => {
    expect(Object.keys(buildStoreControlPath({ share: 0, publisher: 0 }, sharedWith(8, 100)))).toEqual([]);
    expect(Object.keys(buildStoreControlPath({ share: 1, publisher: 0 }, sharedWith(8, 100)))).toEqual(['share']);
    expect(Object.keys(buildStoreControlPath({ share: 0, publisher: 2 }, sharedWith(8, 100)))).toEqual(['publisher']);
    expect(Object.keys(buildStoreControlPath({ share: 1, publisher: 2 }, sharedWith(8, 100)))).toEqual(['share', 'publisher']);
  });

  it('never builds more than a queue\'s cap, even if asked', () => {
    const path = buildStoreControlPath({ share: 5, publisher: 7 }, sharedWith(8, 100));
    expect(path.share!.snapshot.maxConcurrent).toBe(1);
    expect(path.publisher!.snapshot.maxConcurrent).toBe(2);
  });

  it('sets every capacity option explicitly: no shared environment tuning reaches an instance', () => {
    vi.stubEnv('DKG_STORE_MAX_CONCURRENT', '8');
    vi.stubEnv('DKG_STORE_ACK_RESERVED_SLOTS', '3');
    vi.stubEnv('DKG_STORE_HEALTH_RESERVED_SLOTS', '2');
    vi.stubEnv('DKG_STORE_NORMAL_RESERVED_SLOTS', '2');
    vi.stubEnv('DKG_STORE_BACKGROUND_RESERVED_SLOTS', '2');
    vi.stubEnv('DKG_STORE_QUEUE_LIMIT', '3');
    vi.stubEnv('DKG_STORE_NORMAL_QUEUE_LIMIT', '5');
    vi.stubEnv('DKG_STORE_QUEUE_WAIT_TIMEOUT_MS', '77');
    const path = buildStoreControlPath({ share: 1, publisher: 2 }, sharedWith(41, 4321));

    for (const [queue, slots] of [['share', 1], ['publisher', 2]] as const) {
      expect(path[queue]!.snapshot).toMatchObject({
        maxConcurrent: slots,
        ackReservedSlots: 0,
        healthReservedSlots: 0,
        normalReservedSlots: 0,
        backgroundReservedSlots: 0,
        normalInflightLimit: slots,
        // The shared scheduler's resolved queue limit and wait, as values.
        normalQueueLimit: 41,
        queueWaitTimeoutMs: 4321,
      });
      expect(path[queue]!.backpressureId).toBe(`store-control-${queue}`);
    }
  });

  it('takes the queue limit and wait of the real shared scheduler by default', () => {
    const path = buildStoreControlPath({ share: 1, publisher: 2 });
    const shared = externalStorePriorityScheduler.snapshot;
    expect(path.share!.snapshot).toMatchObject({
      normalQueueLimit: shared.normalQueueLimit,
      queueWaitTimeoutMs: shared.queueWaitTimeoutMs,
    });
  });
});

describe('registerStoreControlPath', () => {
  const controlIds = (ids: string[]) => ids.filter((id) => id.startsWith('store-control-'));
  const squatStats = (id: string) => registerStoreSchedulerStats({ backpressureId: id, stats: new StoreSchedulerStats(['control']) });

  it('registers each instance with the backpressure registry and the queue-wait stats, and undoes both', () => {
    const path = buildStoreControlPath({ share: 1, publisher: 2 });
    const undo = registerStoreControlPath(path);
    expect(controlIds(registeredIds())).toEqual(['store-control-publisher', 'store-control-share']);
    expect(controlIds(statsIds())).toEqual(['store-control-publisher', 'store-control-share']);
    undo();
    expect(controlIds(registeredIds())).toEqual([]);
    expect(controlIds(statsIds())).toEqual([]);
  });

  it('undoes the backpressure registration when the stats registration of the same instance fails', () => {
    const path = buildStoreControlPath({ share: 1, publisher: 0 });
    const release = squatStats('store-control-share');
    try {
      expect(() => registerStoreControlPath(path)).toThrow(/already registered/);
      // The failure came after the registry accepted the instance; its undo must have been recorded and run.
      expect(controlIds(registeredIds())).toEqual([]);
    } finally {
      release();
    }
    expect(controlIds(statsIds())).toEqual([]);
  });

  it('leaves nothing from an earlier instance behind when a later one fails in its second step', () => {
    const path = buildStoreControlPath({ share: 1, publisher: 2 });
    const release = squatStats('store-control-publisher');
    try {
      expect(() => registerStoreControlPath(path)).toThrow(/already registered/);
      expect(controlIds(registeredIds())).toEqual([]);
      // The squatter's own entry is not ours to undo.
      expect(controlIds(statsIds())).toEqual(['store-control-publisher']);
    } finally {
      release();
    }
    expect(controlIds(statsIds())).toEqual([]);
  });
});

describe('the process-wide control path', () => {
  it('builds and registers nothing while the path is off', () => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, '0');
    setStoreControlPathForTesting(undefined);
    expect(getStoreControlPath()).toEqual({});
    expect(registeredIds().filter((id) => id.startsWith('store-control-'))).toEqual([]);
    expect(statsIds().filter((id) => id.startsWith('store-control-'))).toEqual([]);
    expect(registeredIds()).toContain('store');
  });

  it('is off when the variable is unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, undefined);
    expect(getStoreControlPath()).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a variable that is set but blank, with one warning, and leaves the path off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, '  ');
    expect(getStoreControlPath()).toEqual({});
    expect(getStoreControlPath()).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('[store control]');
    expect(warn.mock.calls[0][0]).toContain('stays off');
    expect(describeStoreControlPath()).toContain('refused as malformed');
    expect(registeredIds().filter((id) => id.startsWith('store-control-'))).toEqual([]);
  });

  it('builds both instances once from the environment and registers them with the diagnostics', () => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, 'share:1,publisher:2');
    const path = getStoreControlPath();
    expect(getStoreControlPath()).toBe(path);
    expect(path.share).toBeInstanceOf(StorePriorityScheduler);
    expect(path.publisher).toBeInstanceOf(StorePriorityScheduler);

    expect(registeredIds()).toEqual(expect.arrayContaining(['store', 'store-control-share', 'store-control-publisher']));
    const control = backpressureRegistry.capture().schedulers.filter((s) => s.scheduler.startsWith('store-control-'));
    expect(control.map((s) => [s.scheduler, s.lanes.map((lane) => lane.lane), s.totals.inflightLimit]))
      .toEqual([['store-control-publisher', ['control'], 2], ['store-control-share', ['control'], 1]]);

    // The queue-wait stats report each instance beside the shared scheduler, in the one lane.
    const reports = takeStoreSchedulerStatsReports();
    expect(reports.map((report) => report.scheduler))
      .toEqual(['store', 'store-control-publisher', 'store-control-share']);
    for (const report of reports.slice(1)) {
      expect(report.queueWaits.map((wait) => wait.lane)).toEqual(['control']);
    }

    // Replacing the path undoes the registrations, so none is left behind.
    setStoreControlPathForTesting(undefined);
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, 'publisher:1');
    expect(Object.keys(getStoreControlPath())).toEqual(['publisher']);
    expect(registeredIds().filter((id) => id.startsWith('store-control-'))).toEqual(['store-control-publisher']);
  });

  it('refuses a malformed value with one warning, and leaves the path off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, 'share:1;publisher:2');
    expect(getStoreControlPath()).toEqual({});
    expect(getStoreControlPath()).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('[store control]');
    expect(registeredIds().filter((id) => id.startsWith('store-control-'))).toEqual([]);
  });

  it('keeps admission working, with one warning, when the diagnostics refuse the instances', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const squatter = new StorePriorityScheduler({ controlId: 'store-control-publisher', maxConcurrent: 1 });
    const undo = backpressureRegistry.register(squatter);
    try {
      vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, 'share:1,publisher:2');
      const path = getStoreControlPath();
      expect(Object.keys(path)).toEqual(['share', 'publisher']);
      expect(selectStoreScheduler(externalStorePriorityScheduler, { controlQueue: 'publisher' })).toBe(path.publisher);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('not registered with the diagnostics');
      // Nothing half-registered is left behind.
      expect(registeredIds().filter((id) => id.startsWith('store-control-'))).toEqual(['store-control-publisher']);
      expect(statsIds().filter((id) => id.startsWith('store-control-'))).toEqual([]);
    } finally {
      undo();
    }
  });

  it('keeps admission working, with one warning, when only the stats registration is refused', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const release = registerStoreSchedulerStats({ backpressureId: 'store-control-publisher', stats: new StoreSchedulerStats(['control']) });
    try {
      vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, 'share:1,publisher:2');
      const path = getStoreControlPath();
      expect(selectStoreScheduler(externalStorePriorityScheduler, { controlQueue: 'share' })).toBe(path.share);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('not registered with the diagnostics');
      expect(registeredIds().filter((id) => id.startsWith('store-control-'))).toEqual([]);
    } finally {
      release();
    }
  });

  it('accepts injected instances for tests, without registering them', () => {
    const injected = buildStoreControlPath({ share: 1, publisher: 2 });
    setStoreControlPathForTesting(injected);
    expect(getStoreControlPath()).toBe(injected);
    expect(registeredIds().filter((id) => id.startsWith('store-control-'))).toEqual([]);
    setStoreControlPathForTesting(undefined);
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, '0');
    expect(getStoreControlPath()).toEqual({});
  });
});

describe('scheduler selection and the tagging helper', () => {
  it('returns the shared scheduler unless the call names a queue whose path is on', () => {
    const shared = new StorePriorityScheduler({ maxConcurrent: 2 });
    const path = buildStoreControlPath({ share: 1, publisher: 2 });
    setStoreControlPathForTesting(path);

    expect(selectStoreScheduler(shared, undefined)).toBe(shared);
    expect(selectStoreScheduler(shared, {})).toBe(shared);
    // Priority and the ambient lane are not what routes a call.
    expect(selectStoreScheduler(shared, { priority: 'ack' } as never)).toBe(shared);
    expect(selectStoreScheduler(shared, { controlQueue: 'share' })).toBe(path.share);
    expect(selectStoreScheduler(shared, { controlQueue: 'publisher' })).toBe(path.publisher);
    // A value that is no queue (a mistake, or a prototype key) never selects anything.
    for (const bogus of ['other', 'constructor', '__proto__', 'toString', '']) {
      expect(selectStoreScheduler(shared, { controlQueue: bogus as never })).toBe(shared);
    }
  });

  it('falls back to the shared scheduler for a queue whose path is off', () => {
    const shared = new StorePriorityScheduler({ maxConcurrent: 2 });
    const path = buildStoreControlPath({ share: 0, publisher: 2 });
    setStoreControlPathForTesting(path);
    expect(selectStoreScheduler(shared, { controlQueue: 'share' })).toBe(shared);
    expect(selectStoreScheduler(shared, { controlQueue: 'publisher' })).toBe(path.publisher);
    setStoreControlPathForTesting({});
    expect(selectStoreScheduler(shared, { controlQueue: 'publisher' })).toBe(shared);
  });

  it('tags with the source and the queue, and sets no priority', () => {
    expect(controlStoreOptions('share', 'publisher.asyncPromote.writeJob'))
      .toEqual({ source: 'publisher.asyncPromote.writeJob', controlQueue: 'share' });
    expect(controlStoreOptions('publisher', 'publisher.asyncLift.claim'))
      .toEqual({ source: 'publisher.asyncLift.claim', controlQueue: 'publisher' });
    expect('priority' in controlStoreOptions('share', 'x')).toBe(false);
  });
});

describe('the startup geometry line', () => {
  const capture = () => {
    const info: string[] = [];
    const warn: string[] = [];
    return { info, warn, logger: { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m) } };
  };

  it('states the effective geometry once, as one line', () => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, 'share:1,publisher:2');
    const { info, warn, logger } = capture();
    logStoreControlPathGeometry(logger);
    expect(warn).toEqual([]);
    expect(info).toHaveLength(1);
    expect(info[0]).toBe(describeStoreControlPath());
    expect(info[0]).toContain('on');
    expect(info[0]).toContain('share=1 publisher=2');
    expect(info[0]).toContain(STORE_CONTROL_RESERVED_SLOTS_ENV);
    expect(info[0]).not.toContain('\n');
  });

  it('says the path is off by default, and that a malformed value was refused', () => {
    // Do not depend on the ambient environment: the variable is explicitly unset here (restored after the test).
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, undefined);
    setStoreControlPathForTesting(undefined);
    const unset = capture();
    logStoreControlPathGeometry(unset.logger);
    expect(unset.info[0]).toContain('off');
    expect(unset.info[0]).toContain('share=0 publisher=0');
    expect(unset.info[0]).toContain('default');

    setStoreControlPathForTesting(undefined);
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, 'garbage');
    const refused = capture();
    logStoreControlPathGeometry(refused.logger);
    expect(refused.warn).toHaveLength(1);
    expect(refused.warn[0]).toContain('stays off');
    expect(refused.info[0]).toContain('off');
    expect(refused.info[0]).toContain('refused as malformed');

    // The warning is reported once: a second call states the geometry again without repeating it.
    const again = capture();
    logStoreControlPathGeometry(again.logger);
    expect(again.warn).toEqual([]);
    expect(again.info[0]).toBe(refused.info[0]);
  });

  it('reports a clamp as a warning and the clamped geometry', () => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, 'share:2,publisher:5');
    const { info, warn, logger } = capture();
    logStoreControlPathGeometry(logger);
    expect(warn).toHaveLength(2);
    expect(info[0]).toContain('share=1 publisher=2');
  });

  it('builds the instances at that call, so they are in the diagnostics from daemon start', () => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, 'share:1,publisher:2');
    logStoreControlPathGeometry(capture().logger);
    expect(registeredIds()).toEqual(expect.arrayContaining(['store-control-share', 'store-control-publisher']));
  });

  it('is not printed at module import', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, 'garbage');
    vi.resetModules();
    await import('../src/index.js');
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
