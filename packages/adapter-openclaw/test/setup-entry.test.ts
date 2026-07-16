import { beforeEach, describe, expect, it } from 'vitest';
import setupEntry from '../setup-entry.mjs';

describe('setup-entry', () => {
  let runtimeEntryCalls: unknown[][];

  beforeEach(() => {
    runtimeEntryCalls = [];
  });

  function runtimeFactory() {
    return Promise.resolve({
      default: (...args: unknown[]) => { runtimeEntryCalls.push(args); },
    });
  }

  it('skips runtime registration during setup-only phases', () => {
    const registerToolCalls: unknown[][] = [];
    const registerHookCalls: unknown[][] = [];
    const registerChannelCalls: unknown[][] = [];
    const registerHttpRouteCalls: unknown[][] = [];
    const infoCalls: unknown[][] = [];

    setupEntry({
      config: {},
      registrationMode: 'setup-only',
      registerTool: (...args: unknown[]) => { registerToolCalls.push(args); },
      registerHook: (...args: unknown[]) => { registerHookCalls.push(args); },
      registerChannel: (...args: unknown[]) => { registerChannelCalls.push(args); },
      registerHttpRoute: (...args: unknown[]) => { registerHttpRouteCalls.push(args); },
      on: () => {},
      logger: { info: (...args: unknown[]) => { infoCalls.push(args); } },
      _importRuntime: runtimeFactory,
    });

    expect(registerToolCalls).toHaveLength(0);
    expect(registerHookCalls).toHaveLength(0);
    expect(registerChannelCalls).toHaveLength(0);
    expect(registerHttpRouteCalls).toHaveLength(0);
    expect(runtimeEntryCalls).toHaveLength(0);
    expect(infoCalls.some(args => String(args[0]).includes('skipping runtime registration'))).toBe(true);
  });

  it('delegates to the runtime entry outside setup-only modes', async () => {
    const api = {
      config: {},
      registrationMode: 'full',
      logger: { info: () => {} },
      _importRuntime: runtimeFactory,
    } as any;

    await setupEntry(api);

    expect(runtimeEntryCalls).toHaveLength(1);
    expect(runtimeEntryCalls[0][0]).toBe(api);
  });

  it('defaults missing registrationMode to the runtime entry', async () => {
    const api = {
      config: {},
      logger: { info: () => {} },
      _importRuntime: runtimeFactory,
    } as any;

    await setupEntry(api);

    expect(runtimeEntryCalls).toHaveLength(1);
    expect(runtimeEntryCalls[0][0]).toBe(api);
  });

  it('does not import the runtime entry during setup-only loads', () => {
    expect(setupEntry({
      config: {},
      registrationMode: 'setup-only',
      logger: { info: () => {} },
      _importRuntime: () => {
        throw new Error('runtime entry should stay lazy during setup-only loads');
      },
    } as any)).toBeUndefined();
  });
});
