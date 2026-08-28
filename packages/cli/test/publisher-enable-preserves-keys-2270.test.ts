import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GH#2270 — `dkg publisher enable` used to REPLACE config.publisher wholesale,
// so re-running it would silently erase every key it does not manage: the retry
// knobs (autoRetryEnabled, retryJitterRatio, retryBackoffBaseMs/MaxMs) an
// operator had set. It must merge instead, like `publisher disable` always has.
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { ...actual, loadConfig: mocks.loadConfig, saveConfig: mocks.saveConfig };
});

const { Command } = await import('commander');
const { registerPublisherCommand } = await import('../src/commands/publisher.js');

async function runPublisherCommand(...argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerPublisherCommand(program);
  await program.parseAsync(argv, { from: 'user' });
}

describe('dkg publisher enable/disable config merge (#2270)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveConfig.mockResolvedValue(undefined);
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
    mocks.loadConfig.mockResolvedValue({
      name: 'node',
      publisher: {
        enabled: false,
        autoRetryEnabled: false,
        retryJitterRatio: 0.4,
        retryBackoffBaseMs: 2_000,
        retryBackoffMaxMs: 90_000,
      },
    });

    await runPublisherCommand('publisher', 'enable');

    expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
    const saved = mocks.saveConfig.mock.calls[0]?.[0] as any;
    expect(saved.publisher).toEqual({
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
    mocks.loadConfig.mockResolvedValue({
      publisher: { enabled: false, pollIntervalMs: 1_000, maxRetries: 2, autoRetryEnabled: false },
    });

    await runPublisherCommand('publisher', 'enable', '--poll-interval', '7000', '--max-retries', '4');

    const saved = mocks.saveConfig.mock.calls[0]?.[0] as any;
    expect(saved.publisher).toEqual({
      enabled: true,
      pollIntervalMs: 7_000,
      errorBackoffMs: 5_000,
      maxRetries: 4,
      autoRetryEnabled: false,
    });
  });

  it('enables from an absent publisher block without inventing retry knobs', async () => {
    mocks.loadConfig.mockResolvedValue({ name: 'node' });

    await runPublisherCommand('publisher', 'enable');

    const saved = mocks.saveConfig.mock.calls[0]?.[0] as any;
    expect(saved.publisher).toEqual({
      enabled: true,
      pollIntervalMs: 12_000,
      errorBackoffMs: 5_000,
      maxRetries: 10,
    });
  });

  it('preserves the same keys on disable', async () => {
    mocks.loadConfig.mockResolvedValue({
      publisher: { enabled: true, retryJitterRatio: 0.4, retryBackoffBaseMs: 2_000, retryBackoffMaxMs: 90_000 },
    });

    await runPublisherCommand('publisher', 'disable');

    const saved = mocks.saveConfig.mock.calls[0]?.[0] as any;
    expect(saved.publisher).toEqual({
      enabled: false,
      retryJitterRatio: 0.4,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 90_000,
    });
  });
});
