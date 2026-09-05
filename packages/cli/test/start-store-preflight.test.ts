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
