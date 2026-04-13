import { describe, expect, it, vi } from 'vitest';
import setupEntry from '../setup-entry.mjs';

describe('setup-entry', () => {
  it('skips runtime registration during setup-only phases', () => {
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
    expect(info).toHaveBeenCalledWith(expect.stringContaining('skipping runtime registration'));
  });
});
