import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GH#2270 — `dkg publisher enable` used to REPLACE config.publisher wholesale,
// so re-running it would silently erase every key it does not manage: the retry
// knobs (autoRetryEnabled, retryJitterRatio, retryBackoffBaseMs/MaxMs) an
// operator had set. It must merge instead, like `publisher disable` always has.
// `file` stands in for the on-disk config that each patch is applied to.
const mocks = vi.hoisted(() => ({
  file: {} as Record<string, any>,
  updateConfigFile: vi.fn(),
}));

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { ...actual, updateConfigFile: mocks.updateConfigFile };
});

const { Command } = await import('commander');
const { registerPublisherCommand } = await import('../src/commands/publisher.js');
const { applyConfigEdits } = await import('../src/home-config-file.js');
type ConfigModule = typeof import('../src/config.js');

async function runPublisherCommand(...argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerPublisherCommand(program);
  await program.parseAsync(argv, { from: 'user' });
}

describe('dkg publisher enable/disable config merge (#2270)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The real edit step, applied to the stand-in file.
    mocks.updateConfigFile.mockImplementation(async (...[edits]: Parameters<ConfigModule['updateConfigFile']>) => {
      applyConfigEdits(mocks.file, edits);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The command swallows failures into process.exit(1); throwing makes any
    // such failure surface as a red row instead of a silent pass.
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves publisher keys it does not manage', async () => {
    mocks.file = {
      name: 'node',
      publisher: {
        enabled: false,
        autoRetryEnabled: false,
        retryJitterRatio: 0.4,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 90_000,
      },
    };

    await runPublisherCommand('publisher', 'enable');

    expect(mocks.updateConfigFile).toHaveBeenCalledTimes(1);
    expect(mocks.file.name).toBe('node');
    expect(mocks.file.publisher).toEqual({
      enabled: true,
      pollIntervalMs: 12_000,
      errorBackoffMs: 5_000,
      maxRetries: 10,
      autoRetryEnabled: false,
      retryJitterRatio: 0.4,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 90_000,
    });
  });

  it('still writes the keys it does manage, from flags, over the previous values', async () => {
    mocks.file = {
      publisher: { enabled: false, pollIntervalMs: 1_000, maxRetries: 2, autoRetryEnabled: false },
    };

    await runPublisherCommand('publisher', 'enable', '--poll-interval', '7000', '--max-retries', '4');

    expect(mocks.file.publisher).toEqual({
      enabled: true,
      pollIntervalMs: 7_000,
      errorBackoffMs: 5_000,
      maxRetries: 4,
      autoRetryEnabled: false,
    });
  });

  it('enables from an absent publisher block without inventing retry knobs', async () => {
    mocks.file = { name: 'node' };

    await runPublisherCommand('publisher', 'enable');

    expect(mocks.file.publisher).toEqual({
      enabled: true,
      pollIntervalMs: 12_000,
      errorBackoffMs: 5_000,
      maxRetries: 10,
    });
  });

  it('preserves the same keys on disable', async () => {
    mocks.file = {
      publisher: { enabled: true, retryJitterRatio: 0.4, retryBackoffBaseMs: 2_000, retryBackoffMaxMs: 90_000 },
    };

    await runPublisherCommand('publisher', 'disable');

    expect(mocks.file.publisher).toEqual({
      enabled: false,
      retryJitterRatio: 0.4,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 90_000,
    });
  });
});
