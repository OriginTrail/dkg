import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import type { TerminalJobClearOutcome } from '@origintrail-official/dkg-publisher';
import { respondTerminalClearOutcome } from '../src/daemon/routes/terminal-clear-response.js';
import { registerPublisherCommand } from '../src/commands/publisher.js';
import { registerKnowledgeAssetCommand } from '../src/commands/knowledge-asset.js';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
const jobId = 'finished-job';
const token = 'clear-job-regression-token';

describe('single-job clear commands through the CLI and HTTP client', () => {
  let home: string;
  let server: Server;
  let port: number;
  let terminalOutcome: TerminalJobClearOutcome | undefined;
  let response: { status: number; body: object };
  let calls: Array<{ path?: string; method?: string; authorization?: string; body: object }>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dkg-clear-job-'));
    await writeFile(join(home, 'auth.token'), token);
    calls = [];
    terminalOutcome = undefined;
    response = { status: 200, body: { outcome: 'cleared', jobId } };
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({ path: req.url, method: req.method, authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
      if (terminalOutcome) { respondTerminalClearOutcome(res, terminalOutcome, jobId); return; }
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.body));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener');
    port = address.port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
  });

  function invoke(args: string[]) {
    return run(process.execPath, ['--import', loader, entry, ...args], {
      env: { ...process.env, DKG_HOME: home, DKG_API_PORT: String(port) }, timeout: 20_000,
    });
  }

  const commands = [
    { args: ['publisher', 'clear-job'], path: '/api/publisher/clear-job', body: { jobId } },
    { args: ['ka', 'clear-share-job'], path: `/api/knowledge-assets/swm/share-jobs/${jobId}/clear`, body: {} },
  ];

  it.each(commands.flatMap(command => ['cleared', 'already_absent', 'rejected'].map(outcome => ({ ...command, outcome }))))(
    'executes the registered action and reports its outcome: $args $outcome', async ({ args, path, body, outcome }) => {
      terminalOutcome = outcome === 'rejected'
        ? { outcome, reason: 'nonterminal' }
        : { outcome: outcome as 'cleared' | 'already_absent' };
      vi.spyOn(ApiClient, 'connect').mockResolvedValue(new ApiClient(port, token));
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('command exited'); });
      const program = new Command().exitOverride();
      registerPublisherCommand(program);
      registerKnowledgeAssetCommand(program);
      const result = program.parseAsync([...args, jobId], { from: 'user' });
      if (outcome === 'rejected') {
        await expect(result).rejects.toThrow('command exited');
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('nonterminal'));
      } else {
        await result;
        expect(output).toHaveBeenCalledWith(expect.stringContaining(outcome));
        expect(exit).not.toHaveBeenCalled();
      }
      expect(calls).toEqual([{ path, method: 'POST', authorization: `Bearer ${token}`, body }]);
    },
  );

  it('passes an explicit override through the registered publisher action', async () => {
    vi.spyOn(ApiClient, 'connect').mockResolvedValue(new ApiClient(port, token));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command().exitOverride();
    registerPublisherCommand(program);
    await program.parseAsync(['publisher', 'clear-job', jobId, '--allow-pending-transaction'], { from: 'user' });
    expect(calls[0].body).toEqual({ jobId, allowPendingTransaction: true });
  });

  it.each(commands)('clears exactly one job: $args', async ({ args, path, body }) => {
    const { stdout } = await invoke([...args, jobId]);
    expect(stdout).toContain('cleared');
    expect(stdout).toContain(jobId);
    expect(calls).toEqual([{ path, method: 'POST', authorization: `Bearer ${token}`, body }]);
  });

  it.each(commands)('treats an absent job as success: $args', async ({ args }) => {
    response.body = { outcome: 'already_absent', jobId };
    expect((await invoke([...args, jobId])).stdout).toContain('already_absent');
    expect(calls).toHaveLength(1);
  });

  it('sends the pending-transaction override only when explicitly requested', async () => {
    await invoke(['publisher', 'clear-job', jobId, '--allow-pending-transaction']);
    expect(calls).toEqual([{ path: '/api/publisher/clear-job', method: 'POST',
      authorization: `Bearer ${token}`, body: { jobId, allowPendingTransaction: true } }]);
  });

  it.each(commands.flatMap(command => (['nonterminal', 'unknown', 'malformed'] as const).map(reason => ({ ...command, reason }))))(
    'fails with the daemon refusal: $args $reason', async ({ args, reason }) => {
      terminalOutcome = { outcome: 'rejected', reason };
      await expect(invoke([...args, jobId])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(reason) });
      expect(calls).toHaveLength(1);
    },
  );

  it('preserves the pending-transaction explanation alongside its structured reason', async () => {
    terminalOutcome = { outcome: 'rejected', reason: 'pending_transaction' };
    vi.spyOn(ApiClient, 'connect').mockResolvedValue(new ApiClient(port, token));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('command exited'); });
    const program = new Command().exitOverride();
    registerPublisherCommand(program);
    await expect(program.parseAsync(['publisher', 'clear-job', jobId], { from: 'user' })).rejects.toThrow('command exited');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('pending_transaction'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('may have sent a transaction'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('allowPendingTransaction'));
  });

  it.each(commands)('does not create an offline store when the daemon is unreachable: $args', async ({ args }) => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    const before = await readdir(home);
    await expect(invoke([...args, jobId])).rejects.toMatchObject({ code: 1 });
    expect(await readdir(home)).toEqual(before);
    expect(calls).toHaveLength(0);
  });
});
