import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readPid: vi.fn() }));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/config.js')>(),
  configExists: () => true,
  loadConfig: async () => ({ store: { backend: 'oxigraph-server', options: { memoryMaxMiB: 0 } } }),
  readPid: mocks.readPid,
}));
import { registerLifecycleCommands } from '../src/commands/lifecycle.js';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
describe('start store preflight (#1761)', () => {
  it('rejects an unsupported Node runtime before reading node state', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('runtime-exit'); });
    const program = new Command();
    registerLifecycleCommands(program);

    await expect(program.parseAsync(['node', 'dkg', 'start'])).rejects.toThrow('runtime-exit');

    expect(errors.mock.calls.flat().join(' ')).toContain('node:sqlite is unavailable');
    expect(mocks.readPid).not.toHaveBeenCalled();
  });

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
