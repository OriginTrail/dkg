import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeEntry = vi.fn();

vi.mock('../openclaw-entry.mjs', () => ({
  default: runtimeEntry,
}));

describe('setup-entry', () => {
  beforeEach(() => {
    runtimeEntry.mockReset();
  });

  it('skips runtime registration during setup-only phases', async () => {
    const { default: setupEntry } = await import('../setup-entry.mjs');
    const registerTool = vi.fn();
    const registerHook = vi.fn();
    const registerChannel = vi.fn();
    const registerHttpRoute = vi.fn();
    const info = vi.fn();

    setupEntry({
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
    const { default: setupEntry } = await import('../setup-entry.mjs');
    const api = {
      config: {},
      registrationMode: 'full',
      logger: { info: vi.fn() },
    } as any;

    setupEntry(api);

    expect(runtimeEntry).toHaveBeenCalledWith(api);
  });
});
