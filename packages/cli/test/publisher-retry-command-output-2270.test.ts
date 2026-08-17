import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerPublisherCommand } from '../src/commands/publisher.js';
import { ApiClient } from '../src/api-client.js';

// GH#2270 — `dkg publisher retry` is where an operator learns what a retry pass did.
// Reporting only `retried` made the jobs the publisher deliberately left failed invisible:
// an evidence-bearing job (a transaction may already be on chain) looked identical to no
// failed jobs at all. The command now prints the whole disposition, and `retried` keeps its
// old sentence so the habit of reading that line still works.
describe('dkg publisher retry output (#2270)', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runRetry(outcome: {
    retried: number;
    blockedPendingRecovery: number;
    skipped: number;
  }): Promise<string> {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({
      publisherRetry: async () => outcome,
    } as any);
    const program = new Command();
    program.exitOverride();
    registerPublisherCommand(program);
    await program.parseAsync(['publisher', 'retry'], { from: 'user' });
    return logs.join('\n');
  }

  it('prints all three counts, with the retried sentence unchanged', async () => {
    const out = await runRetry({ retried: 2, blockedPendingRecovery: 3, skipped: 4 });

    expect(out).toContain('Retried 2 publisher job(s).');
    expect(out).toMatch(/3 awaiting chain proof/);
    expect(out).toMatch(/4 with nothing to retry/);
  });

  // The SAME contract over the offline fallback. `dkg publisher retry` runs against a stopped
  // daemon too, and that path builds its own publisher: a fallback still calling the old
  // `retry()` — or an inspector instance that never gained `retryDetailed` — would print a
  // truncated (or crashing) report while every daemon-path row above stayed green.
  it('prints the same disposition over the local inspector when the daemon is unreachable', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
    vi.spyOn(ApiClient, 'connect').mockRejectedValue(new Error('Daemon is not running'));
    const stop = vi.fn(async () => {});
    const retryDetailed = vi.fn(async () => ({ retried: 5, blockedPendingRecovery: 6, skipped: 7 }));
    vi.doMock('../src/publisher-runner.js', () => ({
      createPublisherInspector: async () => ({ publisher: { retryDetailed }, stop }),
    }));

    try {
      const program = new Command();
      program.exitOverride();
      registerPublisherCommand(program);
      await program.parseAsync(['publisher', 'retry'], { from: 'user' });
    } finally {
      vi.doUnmock('../src/publisher-runner.js');
    }

    expect(retryDetailed).toHaveBeenCalledWith({ status: 'failed' });
    // The inspector opens a store of its own, so the command must close it whatever it printed.
    expect(stop).toHaveBeenCalledTimes(1);
    const out = logs.join('\n');
    expect(out).toContain('Retried 5 publisher job(s).');
    expect(out).toMatch(/6 awaiting chain proof/);
    expect(out).toMatch(/7 with nothing to retry/);
  });

  it('still reports the blocked and skipped jobs when nothing was retried', async () => {
    // The case the old output was actively misleading in: "Retried 0" alone reads as
    // "no failed jobs", when in fact a job may be sitting on an unproven transaction.
    const out = await runRetry({ retried: 0, blockedPendingRecovery: 1, skipped: 0 });

    expect(out).toContain('Retried 0 publisher job(s).');
    expect(out).toMatch(/1 awaiting chain proof/);
    expect(out).toMatch(/0 with nothing to retry/);
  });
});
