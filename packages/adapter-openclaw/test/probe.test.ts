import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DkgNodePlugin } from '../src/DkgNodePlugin.js';
import type { OpenClawPluginApi } from '../src/types.js';

function makeMockApi(overrides?: Partial<OpenClawPluginApi>): OpenClawPluginApi {
  const infoSpy = vi.fn();
  const debugSpy = vi.fn();
  const warnSpy = vi.fn();
  
  return {
    config: {},
    registrationMode: 'full',
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    on: vi.fn(),
    logger: { info: infoSpy, debug: debugSpy, warn: warnSpy },
    ...overrides,
  };
}

describe('DkgNodePlugin registration-mode probe', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.DKG_PROBE_REGISTRATION_MODE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DKG_PROBE_REGISTRATION_MODE;
    } else {
      process.env.DKG_PROBE_REGISTRATION_MODE = originalEnv;
    }
    vi.clearAllMocks();
  });

  it('probe is silent when DKG_PROBE_REGISTRATION_MODE is not set', () => {
    delete process.env.DKG_PROBE_REGISTRATION_MODE;
    
    const api = makeMockApi();
    const plugin = new DkgNodePlugin();
    plugin.register(api);

    const infoCalls = (api.logger.info as any).mock.calls;
    const probeInfoCalls = infoCalls.filter((c: any) => c[0]?.includes('[dkg-probe]'));
    expect(probeInfoCalls).toHaveLength(0);
  });

  it('probe logs register() call when env var is "1"', () => {
    process.env.DKG_PROBE_REGISTRATION_MODE = '1';
    
    const api = makeMockApi({ registrationMode: 'setup-runtime' });
    const plugin = new DkgNodePlugin();
    plugin.register(api);

    const infoCalls = (api.logger.info as any).mock.calls.map((c: any[]) => c[0]);
    const registerCallLog = infoCalls.find((msg: string) => msg?.includes('[dkg-probe] register() called'));
    
    expect(registerCallLog).toBeDefined();
    expect(registerCallLog).toContain('mode=setup-runtime');
    expect(registerCallLog).toContain('call#=1');
    expect(registerCallLog).toContain('api.on=');
  });

  it('probe logs consecutive register() calls with incrementing call#', () => {
    process.env.DKG_PROBE_REGISTRATION_MODE = '1';
    
    const api1 = makeMockApi({ registrationMode: 'setup-runtime' });
    const api2 = makeMockApi({ registrationMode: 'full' });
    const plugin = new DkgNodePlugin();
    
    plugin.register(api1);
    plugin.register(api2);

    const infoCalls1 = (api1.logger.info as any).mock.calls.map((c: any[]) => c[0]);
    const infoCalls2 = (api2.logger.info as any).mock.calls.map((c: any[]) => c[0]);
    
    const registerLog1 = infoCalls1.find((msg: string) => msg?.includes('[dkg-probe] register() called'));
    const registerLog2 = infoCalls2.find((msg: string) => msg?.includes('[dkg-probe] register() called'));
    
    expect(registerLog1).toContain('call#=1');
    expect(registerLog2).toContain('call#=2');
  });

  it('probe attempts to register handlers via all three mechanisms', () => {
    process.env.DKG_PROBE_REGISTRATION_MODE = '1';
    
    const onSpy = vi.fn();
    const registerHookSpy = vi.fn();
    const api = makeMockApi({
      on: onSpy,
      registerHook: registerHookSpy,
    });
    
    const plugin = new DkgNodePlugin();
    plugin.register(api);

    // Should attempt to register on each event via each mechanism
    // api.on and api.registerHook are called for each of 6 events
    const numEvents = 6; // before_prompt_build, agent_end, before_compaction, before_reset, message_received, message_sent
    
    expect(onSpy.mock.calls.length).toBeGreaterThanOrEqual(numEvents);
    expect(registerHookSpy.mock.calls.length).toBeGreaterThanOrEqual(numEvents);
  });

  it('per-api gating: re-registers on a NEW api instance, does NOT double-install on the SAME api (R11.3 / T25)', () => {
    // T25 — Pre-fix the probe gated on api identity alone and would
    // wholesale-skip re-entry. Post-fix it tracks per-(api,mechanism,
    // event) so:
    //   * NEW api: full install runs (covered by other tests).
    //   * SAME api with no hook-surface change: no double-install of
    //     already-bound mechanism+event tuples.
    //   * SAME api with hook surface upgraded (api.on flips from
    //     undefined → function): the missing typed-hook tuples DO
    //     install on the second call. (Asserted in a separate test.)
    process.env.DKG_PROBE_REGISTRATION_MODE = '1';

    const apiSetup = makeMockApi({ registrationMode: 'setup-runtime' });
    const apiFull = makeMockApi({ registrationMode: 'full' });
    const plugin = new DkgNodePlugin();

    // Multi-phase init: same plugin, fresh api on each call.
    plugin.register(apiSetup);
    plugin.register(apiFull);

    // Both APIs must have received the probe's "register() called" log.
    const setupRegLogs = (apiSetup.logger.info as any).mock.calls
      .map((c: any[]) => c[0])
      .filter((m: string) => typeof m === 'string' && m.includes('[dkg-probe] register() called'));
    const fullRegLogs = (apiFull.logger.info as any).mock.calls
      .map((c: any[]) => c[0])
      .filter((m: string) => typeof m === 'string' && m.includes('[dkg-probe] register() called'));
    expect(setupRegLogs.length).toBe(1);
    expect(fullRegLogs.length).toBe(1);

    // Snapshot the PROBE-specific registerHook calls before the
    // re-entry. Filtering by `dkg-probe-` name isolates the probe's
    // installs from the adapter's own hook installs (which DO retry
    // by design via T6-style mechanism on the same api).
    const probeNamesBefore = (apiSetup.registerHook as any).mock.calls
      .filter((c: any[]) => c[2]?.name?.startsWith?.('dkg-probe-'))
      .length;

    // Re-enter with the SAME apiSetup. With unchanged hook surface
    // (same api.on / api.registerHook availability) the probe must
    // NOT double-install any mechanism+event tuple.
    plugin.register(apiSetup);

    const probeNamesAfter = (apiSetup.registerHook as any).mock.calls
      .filter((c: any[]) => c[2]?.name?.startsWith?.('dkg-probe-'))
      .length;
    expect(probeNamesAfter).toBe(probeNamesBefore);
  });

  it('per-api per-mechanism gating: api.on flips from undefined to function across calls; missing typed-hook tuples bind on the upgrade (T25)', () => {
    // Regression for T25: pre-fix the per-api WeakSet caused a wholesale
    // skip on the second register() call, so a `setup-runtime → full`
    // upgrade on the SAME api object that flipped `api.on` from
    // undefined → function never bound the typed-hook surface that
    // became available. Post-fix the per-(mechanism, event) tracking
    // installs only the missing tuples.
    process.env.DKG_PROBE_REGISTRATION_MODE = '1';

    // Mutable api: api.on starts undefined, becomes a function on call 2.
    const onSpy = vi.fn();
    const api: any = {
      ...makeMockApi(),
      registrationMode: 'setup-runtime',
      on: undefined,
    };
    const plugin = new DkgNodePlugin();
    plugin.register(api);

    // Call 1: api.on absent → no typed-hook installs via api.on.
    expect(onSpy).not.toHaveBeenCalled();

    // Flip the surface: api.on becomes available, mode upgrades.
    api.on = onSpy;
    api.registrationMode = 'full';
    plugin.register(api);

    // Probe MUST have called api.on for each typed event on the second
    // call — the per-mechanism gate let the upgrade install bind the
    // newly-available surface.
    const events = onSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('before_prompt_build');
    expect(events).toContain('agent_end');
  });

  it('probe gracefully handles missing globalThis internal-hook map', () => {
    process.env.DKG_PROBE_REGISTRATION_MODE = '1';
    
    const api = makeMockApi();
    const plugin = new DkgNodePlugin();
    
    // Should not throw even if globalThis hook map is absent
    expect(() => plugin.register(api)).not.toThrow();
  });

  it('probe handlers fire and log when invoked', () => {
    process.env.DKG_PROBE_REGISTRATION_MODE = '1';
    
    const api = makeMockApi();
    const plugin = new DkgNodePlugin();
    plugin.register(api);

    // Find the handler that was registered via api.on
    const onCalls = (api.on as any).mock.calls;
    const firstCall = onCalls[0];
    
    if (firstCall && typeof firstCall[1] === 'function') {
      const handler = firstCall[1];
      const infoSpy = api.logger.info as any;
      
      // Clear previous logs
      infoSpy.mockClear();
      
      // Invoke the handler
      handler();
      
      // Should have logged a HOOK FIRED message
      const fireLogs = infoSpy.mock.calls
        .map((c: any[]) => c[0])
        .filter((msg: string) => msg?.includes('[dkg-probe] HOOK FIRED'));
      
      expect(fireLogs.length).toBeGreaterThan(0);
      expect(fireLogs[0]).toContain('event=');
      expect(fireLogs[0]).toContain('via=');
      expect(fireLogs[0]).toContain('fire#=');
    }
  });

  it('probe counter increments on each hook fire from the same handler', () => {
    process.env.DKG_PROBE_REGISTRATION_MODE = '1';
    
    const api = makeMockApi();
    const plugin = new DkgNodePlugin();
    plugin.register(api);

    // Find a handler and invoke it multiple times
    const onCalls = (api.on as any).mock.calls;
    const firstCall = onCalls[0];
    
    if (firstCall && typeof firstCall[1] === 'function') {
      const handler = firstCall[1];
      const infoSpy = api.logger.info as any;
      
      // Invoke multiple times and collect fire# values
      infoSpy.mockClear();
      handler();
      handler();
      handler();
      
      const fireLogs = infoSpy.mock.calls
        .map((c: any[]) => c[0])
        .filter((msg: string) => msg?.includes('[dkg-probe] HOOK FIRED'));
      
      // Extract fire# from each log
      const fireNumbers = fireLogs.map(msg => {
        const match = msg.match(/fire#=(\d+)/);
        return match ? parseInt(match[1], 10) : null;
      }).filter(n => n !== null);
      
      // Should see 1, 2, 3
      expect(fireNumbers).toEqual([1, 2, 3]);
    }
  });
});
