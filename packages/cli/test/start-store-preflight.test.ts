import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readPid: vi.fn(), configExists: vi.fn(() => true) }));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/config.js')>(),
  configExists: mocks.configExists,
  loadConfig: async () => ({ store: { backend: 'oxigraph-server', options: { memoryMaxMiB: 0 } } }),
  readPid: mocks.readPid,
}));
import { registerLifecycleCommands } from '../src/commands/lifecycle.js';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
describe('start store preflight (#1761)', () => {
  it.each([{ flags: [] }, { flags: ['--foreground'] }])('rejects static memory errors before startup work ($flags)', async ({ flags }) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('preflight-exit'); });
    const program = new Command();
    registerLifecycleCommands(program);
    await expect(program.parseAsync(['node', 'dkg', 'start', ...flags])).rejects.toThrow('preflight-exit');
    expect(errors.mock.calls.flat().join(' ')).toContain('memoryMaxMiB must be a positive integer');
    expect(mocks.readPid).not.toHaveBeenCalled();
  });
});

describe('start runtime preflight (#1985)', () => {
  it.each([{ flags: [] }, { flags: ['--foreground'] }])('rejects an unsupported runtime before config or startup ($flags)', async ({ flags }) => {
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('runtime-exit'); });
    const program = new Command();
    registerLifecycleCommands(program);
    await expect(program.parseAsync(['node', 'dkg', 'start', ...flags])).rejects.toThrow('runtime-exit');
    expect(errors.mock.calls.flat().join(' ')).toContain('node:sqlite');
    expect(errors.mock.calls.flat().join(' ')).toContain(process.version);
    expect(mocks.configExists).not.toHaveBeenCalled();
    expect(mocks.readPid).not.toHaveBeenCalled();
  });
});
