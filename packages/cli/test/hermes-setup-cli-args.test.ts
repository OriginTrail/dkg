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
      daemonUrl: 'http://127.0.0.1:9200',
      bridgeUrl: 'http://127.0.0.1:9202',
      gatewayUrl: 'https://hermes.example.com',
      bridgeHealthUrl: 'http://127.0.0.1:9202/health',
      port: 9300,
      memoryMode: 'tools-only',
      verify: false,
      start: false,
      // `fund` defaults to true (commander `--no-fund` convention) when not
      // explicitly passed. `preserveProvider` defaults to false (replace-by-
      // default per setup-entrypoint-contract.md §2).
      fund: true,
      preserveProvider: false,
      dryRun: true,
      nodeSkillContent: expect.stringContaining('# DKG V10 Node Skill'),
    });
  });

  it('defaults verify/start/fund to true and dryRun/preserveProvider to false', () => {
    expect(normalizeHermesSetupOptions({})).toEqual({
      profile: undefined,
      daemonUrl: undefined,
      bridgeUrl: undefined,
      gatewayUrl: undefined,
      bridgeHealthUrl: undefined,
      port: undefined,
      memoryMode: undefined,
      verify: true,
      start: true,
      fund: true,
      preserveProvider: false,
      dryRun: false,
    });
  });

  it('trims the Hermes profile name', () => {
    expect(normalizeHermesSetupOptions({
      profile: ' cli ',
    })).toMatchObject({
      profile: 'cli',
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

  // ---------------------------------------------------------------------------
  // S2 step 1 additions for issue #386.
  // ---------------------------------------------------------------------------

  // H-AC-20: `--no-fund` argv normalization round-trips correctly. Mirrors the
  // assertion already present for OpenClaw in
  // `packages/cli/test/openclaw-setup-cli-args.test.ts`.
  it('H-AC-20: --no-fund normalizes to fund:false; defaults are fund:true', () => {
    expect(normalizeHermesSetupOptions({ fund: false })).toMatchObject({ fund: false });
    expect(normalizeHermesSetupOptions({ fund: true })).toMatchObject({ fund: true });
    expect(normalizeHermesSetupOptions({})).toMatchObject({ fund: true });
  });

  // H-AC-30 (unit half): `--preserve-provider` and its alias
  // `--no-replace-provider` both round-trip through the normalizer as
  // `preserveProvider: true`. The adapter-half (the verbatim throw message)
  // is asserted in the adapter integration tests in S4.
  it('H-AC-30 (unit): --preserve-provider normalizes to preserveProvider:true', () => {
    expect(normalizeHermesSetupOptions({ preserveProvider: true })).toMatchObject({
      preserveProvider: true,
    });
    expect(normalizeHermesSetupOptions({ preserveProvider: false })).toMatchObject({
      preserveProvider: false,
    });
    // Default (omitted): replace-by-default per contract §2.
    expect(normalizeHermesSetupOptions({})).toMatchObject({ preserveProvider: false });
  });

  // H-AC-15: `--no-start` is silently safe to combine with `--no-fund` and
  // `--dry-run`. The normalizer must produce all three flag values without
  // throwing, regardless of which combination the user passed.
  it('H-AC-15: --no-start + --no-fund + --dry-run combine without error', () => {
    expect(normalizeHermesSetupOptions({
      start: false,
      fund: false,
      dryRun: true,
    })).toMatchObject({
      start: false,
      fund: false,
      dryRun: true,
    });
  });

  // H-AC-58 (unit half): `--port` and `--daemon-url` round-trip independently
  // through the normalizer. The port-conflict warn (when both are passed and
  // the URL host:port disagrees) fires inside `runHermesSetup`'s orchestrator
  // — see S2.5 + adapter-side coverage. Here we only assert that both fields
  // survive normalization with their original values intact.
  it('H-AC-58 (unit): --daemon-url and --port round-trip independently', () => {
    const result = normalizeHermesSetupOptions({
      daemonUrl: 'http://127.0.0.1:9200',
      port: '9300',
    });
    expect(result.daemonUrl).toBe('http://127.0.0.1:9200');
    expect(result.port).toBe(9300);
  });
});
