import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeEntry = vi.fn();

async function importSetupEntry(
  runtimeFactory: () => { default: typeof runtimeEntry },
) {
  vi.resetModules();
  vi.doMock('../openclaw-entry.mjs', runtimeFactory);
  return import('../setup-entry.mjs');
}

describe('setup-entry', () => {
  beforeEach(() => {
    runtimeEntry.mockReset();
  });

  it('skips runtime registration during setup-only phases', async () => {
    const { default: setupEntry } = await importSetupEntry(() => ({
      default: runtimeEntry,
    }));
    const registerTool = vi.fn();
    const registerHook = vi.fn();
    const registerChannel = vi.fn();
    const registerHttpRoute = vi.fn();
    const info = vi.fn();

    await setupEntry({
      config: {},
      registrationMode: 'setup-only',
      registerTool,
      registerHook,
      registerChannel,
      registerHttpRoute,
      on: vi.fn(),
      logger: { info },
    } as any);

    expect(registerTool).not.toHaveBeenCalled();
    expect(registerHook).not.toHaveBeenCalled();
    expect(registerChannel).not.toHaveBeenCalled();
    expect(registerHttpRoute).not.toHaveBeenCalled();
    expect(runtimeEntry).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('skipping runtime registration'));
  });

  it('delegates to the runtime entry outside setup-only modes', async () => {
    const { default: setupEntry } = await importSetupEntry(() => ({
      default: runtimeEntry,
    }));
    const api = {
      config: {},
      registrationMode: 'full',
      logger: { info: vi.fn() },
    } as any;

    await setupEntry(api);

    expect(runtimeEntry).toHaveBeenCalledWith(api);
  });

  it('defaults missing registrationMode to the runtime entry', async () => {
    const { default: setupEntry } = await importSetupEntry(() => ({
      default: runtimeEntry,
    }));
    const api = {
      config: {},
      logger: { info: vi.fn() },
    } as any;

    await setupEntry(api);

    expect(runtimeEntry).toHaveBeenCalledWith(api);
  });

  it('does not import the runtime entry during setup-only loads', async () => {
    const { default: setupEntry } = await importSetupEntry(() => {
      throw new Error('runtime entry should stay lazy during setup-only loads');
    });

    expect(setupEntry({
      config: {},
      registrationMode: 'setup-only',
      logger: { info: vi.fn() },
    } as any)).toBeUndefined();
  });
});
