import { describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import {
  hermesSetupAction,
  normalizeHermesSetupOptions,
} from '../src/hermes-setup.js';

function makeCommand(): Pick<Command, 'getOptionValueSource'> {
  return {
    getOptionValueSource: () => undefined,
  } as Pick<Command, 'getOptionValueSource'>;
}

describe('hermesSetupAction', () => {
  it('normalizes setup CLI args before delegating to adapter setup', async () => {
    const runSetup = vi.fn(async () => {});

    await hermesSetupAction(
      {
        profile: ' default ',
        hermesBin: ' C:/Tools/hermes.exe ',
        daemonUrl: ' http://127.0.0.1:9200 ',
        port: '9300',
        cwd: ' C:/Projects/hermes-agent ',
        memoryMode: 'tools-only',
        verify: false,
        start: false,
        dryRun: true,
      },
      makeCommand(),
      { runSetup },
    );

    expect(runSetup).toHaveBeenCalledWith({
      profile: 'default',
      hermesBin: 'C:/Tools/hermes.exe',
      daemonUrl: 'http://127.0.0.1:9200',
      port: 9300,
      cwd: 'C:/Projects/hermes-agent',
      memoryMode: 'tools-only',
      verify: false,
      start: false,
      dryRun: true,
    });
  });

  it('defaults verify/start to true and dryRun to false', () => {
    expect(normalizeHermesSetupOptions({})).toEqual({
      profile: undefined,
      hermesBin: undefined,
      daemonUrl: undefined,
      port: undefined,
      cwd: undefined,
      memoryMode: undefined,
      verify: true,
      start: true,
      dryRun: false,
    });
  });

  it('rejects invalid port values', () => {
    expect(() => normalizeHermesSetupOptions({ port: '70000' })).toThrow('Invalid Hermes daemon port');
    expect(() => normalizeHermesSetupOptions({ port: 'nope' })).toThrow('Invalid Hermes daemon port');
  });

  it('rejects invalid memory modes', () => {
    expect(() => normalizeHermesSetupOptions({ memoryMode: 'everything' as any })).toThrow('Invalid Hermes memory mode');
  });
});
