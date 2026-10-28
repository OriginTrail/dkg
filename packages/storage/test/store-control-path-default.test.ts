/**
 * OT-RFC-73 P14: the control path's default and its node config setting. The default is on (share 1, publisher 2)
 * only for a node whose store backend is Blazegraph on a host with more than 2 CPUs; the setting is
 * DKG_STORE_CONTROL_RESERVED_SLOTS when set, else the config's `store.controlReservedSlots`, else that default. A
 * malformed value from either setting leaves the path off with a warning that names it. Only the daemon configures
 * the backend and the config value (`configureStoreControlPath`, before anything builds the path); a process that
 * never does keeps the path off unless the environment variable turns it on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backpressureRegistry } from '@origintrail-official/dkg-core';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import {
  STORE_CONTROL_RESERVED_SLOTS_CONFIG_KEY,
  STORE_CONTROL_RESERVED_SLOTS_ENV,
  configureStoreControlPath,
  describeStoreControlPath,
  getStoreControlPath,
  logStoreControlPathGeometry,
  resolveStoreControlConfig,
  selectStoreScheduler,
  setStoreControlPathForTesting,
} from '../src/store-control-path.js';

// The process-wide resolution reads the host's CPUs; the startup lines below are checked for chosen counts.
const host = vi.hoisted(() => ({ cpus: 8 }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const availableParallelism = () => host.cpus;
  return { ...actual, availableParallelism, default: { ...actual, availableParallelism } };
});

const ON = { share: 1, publisher: 2 };
const OFF = { share: 0, publisher: 0 };
const CONFIG = `config ${STORE_CONTROL_RESERVED_SLOTS_CONFIG_KEY}`;
const controlIds = () => backpressureRegistry.capture().schedulers.map((s) => s.scheduler).filter((id) => id.startsWith('store-control-'));
const capture = () => {
  const info: string[] = [];
  const warn: string[] = [];
  return { info, warn, logger: { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m) } };
};

afterEach(() => {
  setStoreControlPathForTesting(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  host.cpus = 8;
});

describe('the default (nothing set)', () => {
  it.each([
    [1, OFF], [2, OFF], [3, ON], [8, ON],
  ])('is %i CPUs with Blazegraph -> %o', (cpus, slots) => {
    expect(resolveStoreControlConfig(undefined, { cpus, backend: 'blazegraph' })).toMatchObject({ slots, source: 'default' });
  });

  it.each(['oxigraph-server', 'sparql-http', 'oxigraph-worker', 'oxigraph', 'oxigraph-persistent', 'some-other-store'])(
    'is off for %s on any host, until its own G2 cell passes',
    (backend) => {
      for (const cpus of [1, 2, 3, 8, 64]) {
        expect(resolveStoreControlConfig(undefined, { cpus, backend }))
          .toEqual({ slots: OFF, source: 'default', reason: `default for ${backend}`, warnings: [] });
      }
    },
  );

  it('names the backend and the CPUs that decided it', () => {
    expect(resolveStoreControlConfig(undefined, { cpus: 8, backend: 'blazegraph' }).reason).toBe('default for blazegraph, 8 CPUs');
    expect(resolveStoreControlConfig(undefined, { cpus: 2, backend: 'blazegraph' }).reason)
      .toBe('default: 2 CPUs or fewer (blazegraph, 2 CPUs)');
    expect(resolveStoreControlConfig(undefined, { cpus: 8 }).reason).toBe('default: no store backend configured');
  });
});

describe('store.controlReservedSlots', () => {
  it('turns the path off with 0 or "0", on a host and backend where the default is on', () => {
    for (const value of [0, '0', ' 0 ']) {
      expect(resolveStoreControlConfig(undefined, { cpus: 8, backend: 'blazegraph', configured: value }))
        .toEqual({ slots: OFF, source: 'config', reason: `${CONFIG}=0`, warnings: [] });
    }
  });

  it('takes the same per-queue values as the environment variable, a queue left out getting 0', () => {
    expect(resolveStoreControlConfig(undefined, { cpus: 8, backend: 'blazegraph', configured: 'share:1,publisher:2' }))
      .toEqual({ slots: ON, source: 'config', reason: `${CONFIG}=share:1,publisher:2`, warnings: [] });
    expect(resolveStoreControlConfig(undefined, { cpus: 8, backend: 'blazegraph', configured: 'publisher:1' }).slots)
      .toEqual({ share: 0, publisher: 1 });
    expect(resolveStoreControlConfig(undefined, { cpus: 8, backend: 'blazegraph', configured: 'share:1' }).slots)
      .toEqual({ share: 1, publisher: 0 });
  });

  it('may turn the path on where the default is off: a small host, managed oxigraph-server, any backend', () => {
    for (const [cpus, backend] of [[1, 'blazegraph'], [2, 'blazegraph'], [8, 'oxigraph-server'], [2, 'oxigraph-server'], [8, 'sparql-http']] as const) {
      expect(resolveStoreControlConfig(undefined, { cpus, backend, configured: 'share:1,publisher:2' }), `${backend} ${cpus}`)
        .toMatchObject({ slots: ON, source: 'config', warnings: [] });
    }
  });

  it('clamps a value above a queue\'s cap, with a warning that names the config key', () => {
    const config = resolveStoreControlConfig(undefined, { cpus: 8, backend: 'oxigraph-server', configured: 'share:3,publisher:9' });
    expect(config.slots).toEqual(ON);
    expect(config.warnings).toEqual([
      `${CONFIG} share:3 is above the cap of 1; using 1.`,
      `${CONFIG} publisher:9 is above the cap of 2; using 2.`,
    ]);
  });

  it.each([
    '', '  ', 'garbage', 'on', '1', 'share:1;publisher:2', 'share=1', 'share:1,share:1', 'other:1', 'share:-1',
    1, 2, 3, -1, 0.5, true, false, null, {}, [], { share: 1, publisher: 2 }, ['share:1'],
  ])('refuses the malformed value %j with a warning that names the config key, and leaves the path off', (value) => {
    // Even where the default is on: a malformed rollback must never fall through to the default.
    const config = resolveStoreControlConfig(undefined, { cpus: 8, backend: 'blazegraph', configured: value });
    expect(config.slots).toEqual(OFF);
    expect(config.source).toBe('refused');
    expect(config.reason).toBe(`${CONFIG} refused as malformed`);
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toMatch(new RegExp(`^Invalid ${CONFIG.replace('.', '\\.')}=`));
    expect(config.warnings[0]).not.toContain(STORE_CONTROL_RESERVED_SLOTS_ENV);
    expect(config.warnings[0]).toContain('stays off');
  });

  it('states a valid value on one line, normalized, whatever its spacing or case', () => {
    expect(resolveStoreControlConfig(undefined, { configured: ' Share : 1 ,\n PUBLISHER:2 ' }).reason)
      .toBe(`${CONFIG}=share:1,publisher:2`);
    expect(resolveStoreControlConfig('\tpublisher:02\n').reason).toBe(`${STORE_CONTROL_RESERVED_SLOTS_ENV}=publisher:2`);
    expect(resolveStoreControlConfig(`share:${'9'.repeat(400)}`).reason.length).toBeLessThan(80);
  });

  it('says a blank value is blank, and bounds how much of a long one it repeats', () => {
    expect(resolveStoreControlConfig(undefined, { configured: ' ' }).warnings[0]).toContain('(set but blank)');
    expect(resolveStoreControlConfig(undefined, { configured: 'x'.repeat(500) }).warnings[0].length).toBeLessThan(250);
    expect(resolveStoreControlConfig(undefined, { configured: { long: 'x'.repeat(500) } }).warnings[0].length).toBeLessThan(250);
  });
});

describe('precedence: the environment variable, then the config, then the default', () => {
  it('the environment variable wins over the config, in both directions', () => {
    expect(resolveStoreControlConfig('0', { cpus: 8, backend: 'blazegraph', configured: 'share:1,publisher:2' })).toEqual({
      slots: OFF, source: 'env', reason: `${STORE_CONTROL_RESERVED_SLOTS_ENV}=0, over ${CONFIG}`, warnings: [],
    });
    expect(resolveStoreControlConfig('share:1,publisher:2', { cpus: 8, backend: 'oxigraph-server', configured: 0 })).toEqual({
      slots: ON, source: 'env', reason: `${STORE_CONTROL_RESERVED_SLOTS_ENV}=share:1,publisher:2, over ${CONFIG}`, warnings: [],
    });
  });

  it('the config wins over the default, in both directions', () => {
    expect(resolveStoreControlConfig(undefined, { cpus: 8, backend: 'blazegraph', configured: 0 })).toMatchObject({ slots: OFF, source: 'config' });
    expect(resolveStoreControlConfig(undefined, { cpus: 1, backend: 'blazegraph', configured: 'share:1,publisher:2' }))
      .toMatchObject({ slots: ON, source: 'config' });
  });

  it('a malformed environment variable leaves the path off, whatever the config says, and its warning names the variable', () => {
    for (const raw of ['', 'garbage']) {
      const config = resolveStoreControlConfig(raw, { cpus: 8, backend: 'blazegraph', configured: 'share:1,publisher:2' });
      expect(config.slots).toEqual(OFF);
      expect(config.source).toBe('refused');
      expect(config.reason).toBe(`${STORE_CONTROL_RESERVED_SLOTS_ENV} refused as malformed, over ${CONFIG}`);
      expect(config.warnings[0]).toMatch(new RegExp(`^Invalid ${STORE_CONTROL_RESERVED_SLOTS_ENV}=`));
      expect(config.warnings[0]).not.toContain(STORE_CONTROL_RESERVED_SLOTS_CONFIG_KEY);
    }
  });

  it('a malformed config value is not rescued by the default', () => {
    expect(resolveStoreControlConfig(undefined, { cpus: 8, backend: 'blazegraph', configured: 'share:1,' }).slots).toEqual(OFF);
  });
});

describe('the startup line, per source', () => {
  const lineFor = (settings: Parameters<typeof configureStoreControlPath>[0], env?: string) => {
    if (env !== undefined) vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, env);
    else vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, undefined);
    setStoreControlPathForTesting(undefined);
    const out = capture();
    expect(configureStoreControlPath(settings, out.logger)).toBe(true);
    logStoreControlPathGeometry(out.logger);
    expect(out.info).toHaveLength(1);
    return out;
  };

  it('states the Blazegraph default with the CPU count, and the small-host rule', () => {
    host.cpus = 8;
    expect(lineFor({ backend: 'blazegraph' }).info[0]).toBe(
      'Store control path: on (added slots share=1 publisher=2; default for blazegraph, 8 CPUs; effective until daemon restart)',
    );
    host.cpus = 2;
    expect(lineFor({ backend: 'blazegraph' }).info[0]).toBe(
      'Store control path: off (added slots share=0 publisher=0; default: 2 CPUs or fewer (blazegraph, 2 CPUs); effective until daemon restart)',
    );
  });

  it('states the default of a backend that is not on by default, and that embedded Oxigraph never uses the path', () => {
    expect(lineFor({ backend: 'oxigraph-server' }).info[0]).toBe(
      'Store control path: off (added slots share=0 publisher=0; default for oxigraph-server; effective until daemon restart)',
    );
    expect(lineFor({ backend: 'oxigraph-worker' }).info[0]).toBe(
      'Store control path: off (added slots share=0 publisher=0; default for oxigraph-worker; '
      + 'the embedded oxigraph-worker store never uses it; effective until daemon restart)',
    );
  });

  it('names the config key, and the environment variable with what it overrides', () => {
    expect(lineFor({ backend: 'blazegraph', configured: 0 }).info[0]).toBe(
      'Store control path: off (added slots share=0 publisher=0; config store.controlReservedSlots=0; effective until daemon restart)',
    );
    expect(lineFor({ backend: 'oxigraph-server', configured: 'share:1,publisher:2' }).info[0]).toBe(
      'Store control path: on (added slots share=1 publisher=2; config store.controlReservedSlots=share:1,publisher:2; '
      + 'effective until daemon restart)',
    );
    expect(lineFor({ backend: 'blazegraph' }, '0').info[0]).toBe(
      'Store control path: off (added slots share=0 publisher=0; DKG_STORE_CONTROL_RESERVED_SLOTS=0; effective until daemon restart)',
    );
    expect(lineFor({ backend: 'blazegraph', configured: 'share:1,publisher:2' }, '0').info[0]).toBe(
      'Store control path: off (added slots share=0 publisher=0; DKG_STORE_CONTROL_RESERVED_SLOTS=0, '
      + 'over config store.controlReservedSlots; effective until daemon restart)',
    );
  });

  it('warns once about a malformed value from either setting, naming it, and states the path off', () => {
    const config = lineFor({ backend: 'blazegraph', configured: 'share:1;publisher:2' });
    expect(config.warn).toHaveLength(1);
    expect(config.warn[0]).toMatch(/^Invalid config store\.controlReservedSlots="share:1;publisher:2"/);
    expect(config.info[0]).toBe(
      'Store control path: off (added slots share=0 publisher=0; config store.controlReservedSlots refused as malformed; '
      + 'effective until daemon restart)',
    );
    const env = lineFor({ backend: 'blazegraph' }, 'garbage');
    expect(env.warn).toHaveLength(1);
    expect(env.warn[0]).toMatch(/^Invalid DKG_STORE_CONTROL_RESERVED_SLOTS="garbage"/);
    expect(env.info[0]).toContain('off (added slots share=0 publisher=0; DKG_STORE_CONTROL_RESERVED_SLOTS refused as malformed;');
  });
});

describe('configureStoreControlPath', () => {
  it('builds the process-wide path from the configured backend and value', () => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, undefined);
    expect(configureStoreControlPath({ backend: 'blazegraph' })).toBe(true);
    const path = getStoreControlPath();
    expect(Object.keys(path)).toEqual(['share', 'publisher']);
    expect(controlIds()).toEqual(['store-control-publisher', 'store-control-share']);
  });

  it('keeps the last settings given before the path is built', () => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, undefined);
    configureStoreControlPath({ backend: 'blazegraph' });
    configureStoreControlPath({ backend: 'blazegraph', configured: 'publisher:1' });
    expect(Object.keys(getStoreControlPath())).toEqual(['publisher']);
  });

  it('refuses a configuration after the path was built, loudly, and leaves the path as it was', () => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, undefined);
    configureStoreControlPath({ backend: 'oxigraph-server' });
    const path = getStoreControlPath();
    const before = describeStoreControlPath();
    const { warn, logger } = capture();
    expect(configureStoreControlPath({ backend: 'blazegraph', configured: 'share:1,publisher:2' }, logger)).toBe(false);
    expect(warn).toEqual([
      'Store control path: configuration refused, the path was already built (default for oxigraph-server). '
      + 'Backend blazegraph and store.controlReservedSlots "share:1,publisher:2" take effect only after a restart.',
    ]);
    expect(getStoreControlPath()).toBe(path);
    expect(path).toEqual({});
    expect(describeStoreControlPath()).toBe(before);
    expect(controlIds()).toEqual([]);
  });

  // Each half of the repeat check on its own: a late configuration that differs from the built one in one setting
  // only is refused like any other, never accepted as a repeat while the path stays as it was.
  it.each([
    ['only the backend', { backend: 'oxigraph-server' }, { backend: 'blazegraph' },
      '(default for oxigraph-server). Backend blazegraph and store.controlReservedSlots absent'],
    ['only the config value', { backend: 'blazegraph', configured: 0 }, { backend: 'blazegraph', configured: 'share:1,publisher:2' },
      '(config store.controlReservedSlots=0). Backend blazegraph and store.controlReservedSlots "share:1,publisher:2"'],
  ] as const)('refuses a late configuration that changes %s', (_name, built, late, stated) => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, undefined);
    configureStoreControlPath(built);
    const path = getStoreControlPath();
    const { warn, logger } = capture();
    expect(configureStoreControlPath(late, logger)).toBe(false);
    expect(warn).toEqual([
      `Store control path: configuration refused, the path was already built ${stated} take effect only after a restart.`,
    ]);
    expect(getStoreControlPath()).toBe(path);
    expect(path).toEqual({});
    expect(controlIds()).toEqual([]);
  });

  it('refuses a configuration after an unconfigured use built the path', () => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, undefined);
    const shared = new StorePriorityScheduler({ maxConcurrent: 2 });
    // A tagged store call before the daemon configured the path builds it from the environment alone: off.
    expect(selectStoreScheduler(shared, { controlQueue: 'share' })).toBe(shared);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(configureStoreControlPath({ backend: 'blazegraph' })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[store control\] Store control path: configuration refused, the path was already built/);
    expect(getStoreControlPath()).toEqual({});
  });

  it('accepts a repeat of the settings the path was built with, silently', () => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, undefined);
    configureStoreControlPath({ backend: 'blazegraph', configured: 0 });
    getStoreControlPath();
    const { warn, logger } = capture();
    expect(configureStoreControlPath({ backend: 'blazegraph', configured: 0 }, logger)).toBe(true);
    expect(warn).toEqual([]);
  });

  it('is cleared by the test reset, so the next build is unconfigured again', () => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, undefined);
    configureStoreControlPath({ backend: 'blazegraph' });
    expect(Object.keys(getStoreControlPath())).toEqual(['share', 'publisher']);
    setStoreControlPathForTesting(undefined);
    expect(getStoreControlPath()).toEqual({});
    expect(describeStoreControlPath()).toContain('default: no store backend configured');
  });
});

describe('a process that never configures the path (tools, benchmarks, tests)', () => {
  it('keeps it off when the environment variable is unset, whatever the host', () => {
    for (const cpus of [1, 8, 64]) {
      host.cpus = cpus;
      setStoreControlPathForTesting(undefined);
      vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, undefined);
      expect(getStoreControlPath()).toEqual({});
      expect(controlIds()).toEqual([]);
    }
  });

  it('honours the environment variable', () => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, 'share:1,publisher:2');
    expect(Object.keys(getStoreControlPath())).toEqual(['share', 'publisher']);
  });
});

describe('off restores today exactly (AC2), whichever setting turned it off', () => {
  it.each([
    ['the small-host default', { backend: 'blazegraph' }, undefined, 2],
    ['the oxigraph-server default', { backend: 'oxigraph-server' }, undefined, 8],
    ['config 0', { backend: 'blazegraph', configured: 0 }, undefined, 8],
    ['config "0"', { backend: 'blazegraph', configured: '0' }, undefined, 8],
    ['a malformed config value', { backend: 'blazegraph', configured: 'on' }, undefined, 8],
    ['the environment variable 0', { backend: 'blazegraph', configured: 'share:1,publisher:2' }, '0', 8],
  ] as const)('%s: nothing is built or registered and a tagged call takes the shared scheduler', (_name, settings, env, cpus) => {
    host.cpus = cpus;
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, env);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    configureStoreControlPath(settings);
    const shared = new StorePriorityScheduler({ maxConcurrent: 2 });
    for (const controlQueue of ['share', 'publisher'] as const) {
      expect(selectStoreScheduler(shared, { controlQueue })).toBe(shared);
    }
    expect(getStoreControlPath()).toEqual({});
    expect(controlIds()).toEqual([]);
  });
});
