// `dkg debug cpu-profile` and the API client call behind it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import { registerDebugCommand } from '../src/commands/debug.js';
import type { CpuProfileResult } from '../src/cpu-profile-wire.js';

const RESULT: CpuProfileResult = {
  path: '/node-home/diagnostics/cpu-2026-10-29T12-00-00-000Z.cpuprofile',
  seconds: 30,
  clamped: false,
  recordedMs: 30_002,
  bytes: 8_192,
  stoppedEarly: false,
};

let previousExitCode: typeof process.exitCode;
beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = previousExitCode;
});

function fixture(outcome: CpuProfileResult | Error | string = RESULT) {
  const recordCpuProfile = vi.fn(async (_seconds?: number) => {
    if (typeof outcome === 'string' || outcome instanceof Error) throw outcome;
    return outcome;
  });
  const connect = vi.spyOn(ApiClient, 'connect').mockResolvedValue({ recordCpuProfile } as unknown as ApiClient);
  const run = (...args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerDebugCommand(program);
    return program.parseAsync(['node', 'dkg', 'debug', 'cpu-profile', ...args]);
  };
  const printed = () => vi.mocked(console.log).mock.calls.map(([line]) => String(line));
  return { run, recordCpuProfile, connect, printed };
}

describe('dkg debug cpu-profile', () => {
  it('asks the node for the requested duration and prints where it wrote the profile', async () => {
    const f = fixture();
    await f.run('--seconds', '30');
    expect(f.recordCpuProfile).toHaveBeenCalledExactlyOnceWith(30);
    expect(f.printed()).toEqual([
      'Recording a CPU profile for 30 s...',
      `Wrote ${RESULT.path} (8192 bytes) on the node's host.`,
      'Open it in Chrome DevTools (Performance panel) or any .cpuprofile viewer.',
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('records for the default 10 s without --seconds', async () => {
    const f = fixture({ ...RESULT, seconds: 10 });
    await f.run();
    expect(f.recordCpuProfile).toHaveBeenCalledExactlyOnceWith(10);
    expect(f.printed()[0]).toBe('Recording a CPU profile for 10 s...');
  });

  it('says when the node clamped the duration or ended the profile early', async () => {
    const f = fixture({ ...RESULT, seconds: 60, clamped: true, stoppedEarly: true });
    await f.run('--seconds', '90');
    expect(f.recordCpuProfile).toHaveBeenCalledExactlyOnceWith(90);
    expect(f.printed().slice(0, 3)).toEqual([
      'Recording a CPU profile for 60 s...',
      'The node clamped the duration to 60 s.',
      'The node began to shut down, so the profile ended early.',
    ]);
  });

  it.each(['0', '-5', '2.5', 'ten'])('refuses --seconds %s before contacting the node', async (seconds) => {
    const f = fixture();
    await f.run(`--seconds=${seconds}`);
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledExactlyOnceWith('--seconds must be a positive integer');
    expect(f.connect).not.toHaveBeenCalled();
  });

  it.each<[Error | string, RegExp]>([
    [ApiClient.httpError(403, 'POST /api/diagnostics/cpu-profile requires a node-level admin token; agent-scoped tokens cannot record a CPU profile of the node.'),
      /requires a node-level admin token/],
    [ApiClient.httpError(409, 'A CPU profile is already being recorded on this node; try again when it ends.'), /already being recorded/],
    ['connection refused', /^connection refused$/],
  ])('prints the node refusal and exits 1', async (outcome, message) => {
    const f = fixture(outcome);
    await f.run('--seconds', '5');
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(message));
  });
});

describe('ApiClient.recordCpuProfile', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function answering(body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
    }) as typeof fetch;
    return calls;
  }

  it('posts the duration with the operator token and waits past the recording', async () => {
    const deadlines: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { deadlines.push(ms); return timeout(ms); });
    const calls = answering(RESULT);
    const client = new ApiClient(9_200, 'operator-token', { longTimeoutMs: 1_000 });

    await expect(client.recordCpuProfile(30)).resolves.toEqual(RESULT);
    await expect(client.recordCpuProfile()).resolves.toEqual(RESULT);
    // The node takes any positive duration; its deadline is whole milliseconds.
    await expect(client.recordCpuProfile(1.2345)).resolves.toEqual(RESULT);

    expect(calls.map(({ url, init }) => [url, init.method, init.body])).toEqual([
      ['http://127.0.0.1:9200/api/diagnostics/cpu-profile', 'POST', '{"seconds":30}'],
      ['http://127.0.0.1:9200/api/diagnostics/cpu-profile', 'POST', '{}'],
      ['http://127.0.0.1:9200/api/diagnostics/cpu-profile', 'POST', '{"seconds":1.2345}'],
    ]);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer operator-token');
    // The recording plus a minute, even where the long deadline is shorter.
    expect(deadlines).toEqual([90_000, 70_000, 61_235]);
  });
});
