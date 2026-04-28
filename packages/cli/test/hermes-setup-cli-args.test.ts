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
        daemonUrl: ' http://127.0.0.1:9200 ',
        bridgeUrl: ' http://127.0.0.1:9202 ',
        gatewayUrl: ' https://hermes.example.com ',
        bridgeHealthUrl: ' http://127.0.0.1:9202/health ',
        port: '9300',
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
      profileName: undefined,
      daemonUrl: 'http://127.0.0.1:9200',
      bridgeUrl: 'http://127.0.0.1:9202',
      gatewayUrl: 'https://hermes.example.com',
      bridgeHealthUrl: 'http://127.0.0.1:9202/health',
      port: 9300,
      memoryMode: 'tools-only',
      verify: false,
      start: false,
      dryRun: true,
    });
  });

  it('defaults verify/start to true and dryRun to false', () => {
    expect(normalizeHermesSetupOptions({})).toEqual({
      profile: undefined,
      profileName: undefined,
      daemonUrl: undefined,
      bridgeUrl: undefined,
      gatewayUrl: undefined,
      bridgeHealthUrl: undefined,
      port: undefined,
      memoryMode: undefined,
      verify: true,
      start: true,
      dryRun: false,
    });
  });

  it('accepts profileName as a programmatic alias while preferring profile', () => {
    expect(normalizeHermesSetupOptions({
      profileName: ' alias ',
    })).toMatchObject({
      profile: 'alias',
      profileName: 'alias',
    });
    expect(normalizeHermesSetupOptions({
      profile: ' cli ',
      profileName: ' alias ',
    })).toMatchObject({
      profile: 'cli',
      profileName: 'alias',
    });
  });

  it('rejects invalid port values', () => {
    expect(() => normalizeHermesSetupOptions({ port: '70000' })).toThrow('Invalid Hermes daemon port');
    expect(() => normalizeHermesSetupOptions({ port: 'nope' })).toThrow('Invalid Hermes daemon port');
  });

  it('rejects invalid memory modes', () => {
    expect(() => normalizeHermesSetupOptions({ memoryMode: 'everything' as any })).toThrow('Invalid Hermes memory mode');
    expect(() => normalizeHermesSetupOptions({ memoryMode: 'ask' as any })).toThrow('Invalid Hermes memory mode');
  });
});
