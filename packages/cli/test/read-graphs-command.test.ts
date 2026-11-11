// `dkg store read-graphs status | check | rebuild | drop`, the API client call
// behind them, and the request rules the CLI and the node share.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import { registerReadGraphsCommand } from '../src/commands/read-graphs.js';
import {
  READ_GRAPHS_REQUEST_TIMEOUT_MS,
  parseReadGraphsRequest,
  readGraphsStatusPath,
  type ReadGraphView,
  type ReadGraphsStatusAnswer,
} from '../src/read-graphs-wire.js';

const VM = 'did:dkg:context-graph:research/_read/vm';
const CODE = 'did:dkg:context-graph:research/code/_read/vm';
const WM = 'did:dkg:context-graph:research/_read/wm/0xab';

const STATUS: ReadGraphsStatusAnswer = {
  readGraphs: [
    { readGraph: VM, contextGraphId: 'research', layer: 'vm', state: 'ready', generation: 3 },
    { readGraph: CODE, contextGraphId: 'research', subGraphName: 'code', layer: 'vm', state: 'dirty', generation: 7 },
    { readGraph: WM, contextGraphId: 'research', layer: 'wm', agentAddress: '0xab', state: 'rebuilding', generation: 1 },
  ] satisfies ReadGraphView[],
  states: { building: 0, ready: 1, dirty: 1, repairing: 0, rebuilding: 1 },
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

/** A node that answers each action with the given answer, or fails with the given error. */
function fixture(answers: Partial<Record<string, unknown>>) {
  const readGraphs = vi.fn(async (action: string, _request?: unknown) => {
    const answer = answers[action];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new Error(`unexpected ${action}`);
    return answer;
  });
  const connect = vi.spyOn(ApiClient, 'connect').mockResolvedValue({ readGraphs } as unknown as ApiClient);
  const run = (...args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerReadGraphsCommand(program);
    return program.parseAsync(['node', 'dkg', 'store', 'read-graphs', ...args]);
  };
  const printed = () => vi.mocked(console.log).mock.calls.map(([line]) => String(line));
  return { run, readGraphs, connect, printed };
}

describe('dkg store read-graphs status', () => {
  it('lists the read graphs with their state, layer, scope and generation, and counts them by state', async () => {
    const f = fixture({ status: STATUS });
    await f.run('status', '--context-graph', 'research', '--layer', 'vm');
    expect(f.readGraphs).toHaveBeenCalledExactlyOnceWith('status', { contextGraphId: 'research', layer: 'vm' });
    expect(f.printed()).toEqual([
      'ready      vm  research (generation 3)',
      'dirty      vm  research sub-graph code (generation 7)',
      'rebuilding wm  research agent 0xab (generation 1)',
      '3 read graph(s): 1 ready, 1 dirty, 1 rebuilding.',
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it('prints the node answer as JSON with --json, and says when there is nothing', async () => {
    const f = fixture({ status: STATUS });
    await f.run('status', '--json');
    expect(f.readGraphs).toHaveBeenCalledExactlyOnceWith('status', {});
    expect(JSON.parse(f.printed()[0]!)).toEqual(STATUS);
    const empty = fixture({ status: { readGraphs: [], states: {} } });
    await empty.run('status');
    expect(empty.printed()).toEqual(['No read graphs.']);
  });
});

describe('dkg store read-graphs check', () => {
  it('runs a full check by default and a sampled one with --sampled', async () => {
    const f = fixture({ check: { results: [{ readGraph: VM, outcome: 'consistent' }, { readGraph: WM, outcome: 'skipped' }] } });
    await f.run('check', '--layer', 'vm');
    await f.run('check', '--sampled');
    expect(f.readGraphs.mock.calls).toEqual([['check', { layer: 'vm', mode: 'full' }], ['check', { mode: 'sampled' }]]);
    expect(f.printed().slice(0, 2)).toEqual([`consistent ${VM}`, `skipped ${WM}`]);
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 on a mismatch or a check that failed', async () => {
    const f = fixture({
      check: { results: [{ readGraph: VM, outcome: 'mismatch', direction: 'unheld' }, { readGraph: CODE, outcome: 'error', error: 'the store went away' }] },
    });
    await f.run('check');
    expect(f.printed()).toEqual([`mismatch (unheld) ${VM}`, `error: the store went away ${CODE}`]);
    expect(process.exitCode).toBe(1);
  });

  it('says when there is nothing to check', async () => {
    const f = fixture({ check: { results: [] } });
    await f.run('check');
    expect(f.printed()).toEqual(['No read graphs to check.']);
  });
});

describe('dkg store read-graphs rebuild', () => {
  it('prints each read graph it marked and that the builder rebuilds them', async () => {
    const f = fixture({ rebuild: { marked: [{ readGraph: VM, state: 'dirty' }, { readGraph: CODE }] } });
    await f.run('rebuild', '--context-graph', 'research');
    expect(f.readGraphs).toHaveBeenCalledExactlyOnceWith('rebuild', { contextGraphId: 'research' });
    expect(f.printed()).toEqual([`dirty ${VM}`, `removed ${CODE}`, 'The node\'s builder rebuilds them at its next pass.']);
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 when a read graph could not be marked, and says when there is nothing', async () => {
    const f = fixture({ rebuild: { marked: [{ readGraph: VM, error: 'This store\'s adapter cannot maintain read graphs' }] } });
    await f.run('rebuild');
    expect(f.printed()).toEqual([`error: This store's adapter cannot maintain read graphs ${VM}`]);
    expect(process.exitCode).toBe(1);
    const empty = fixture({ rebuild: { marked: [] } });
    await empty.run('rebuild');
    expect(empty.printed()).toEqual(['No read graphs to rebuild.']);
  });
});

describe('dkg store read-graphs drop', () => {
  it('lists what it would drop and drops nothing without --yes', async () => {
    const f = fixture({ status: STATUS });
    await f.run('drop', '--layer', 'vm');
    expect(f.readGraphs).toHaveBeenCalledExactlyOnceWith('status', { layer: 'vm' });
    expect(f.printed()).toEqual([`would drop ${VM}`, `would drop ${CODE}`, `would drop ${WM}`, 'Run again with --yes to drop 3 read graph(s).']);
    expect(process.exitCode).toBe(1);
    const empty = fixture({ status: { readGraphs: [], states: {} } });
    process.exitCode = undefined;
    await empty.run('drop');
    expect(empty.printed()).toEqual(['No read graphs to drop.']);
    expect(process.exitCode).toBeUndefined();
  });

  it('drops with --yes and exits 1 unless each one is gone', async () => {
    const f = fixture({ drop: { removed: [{ readGraph: VM, outcome: 'done' }, { readGraph: CODE, outcome: 'current' }] } });
    await f.run('drop', '--yes', '--context-graph', 'research');
    expect(f.readGraphs).toHaveBeenCalledExactlyOnceWith('drop', { contextGraphId: 'research' });
    expect(f.printed()).toEqual([`done ${VM}`, `current ${CODE}`]);
    expect(process.exitCode).toBeUndefined();
    const lost = fixture({ drop: { removed: [{ readGraph: VM, outcome: 'lost' }, { readGraph: CODE, outcome: 'error', error: 'refused' }] } });
    await lost.run('drop', '--yes');
    expect(lost.printed()).toEqual([`lost ${VM}`, `error: refused ${CODE}`]);
    expect(process.exitCode).toBe(1);
    const empty = fixture({ drop: { removed: [] } });
    await empty.run('drop', '--yes');
    expect(empty.printed()).toEqual(['No read graphs to drop.']);
  });
});

describe('dkg store read-graphs --json', () => {
  it('prints each node answer as JSON, with the same exit codes', async () => {
    const check = { results: [{ readGraph: VM, outcome: 'mismatch', direction: 'unheld' }] };
    const rebuild = { marked: [{ readGraph: VM, state: 'dirty' }] };
    const drop = { removed: [{ readGraph: VM, outcome: 'done' }] };
    const f = fixture({ status: STATUS, check, rebuild, drop });
    await f.run('check', '--json', '-c', 'research');
    expect(f.readGraphs).toHaveBeenLastCalledWith('check', { contextGraphId: 'research', mode: 'full' });
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await f.run('rebuild', '--json');
    expect(process.exitCode).toBeUndefined();
    // Without --yes: what it would drop, and exit 1.
    await f.run('drop', '--json');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await f.run('drop', '--json', '--yes');
    expect(process.exitCode).toBeUndefined();
    expect(f.printed().map((line) => JSON.parse(line) as unknown)).toEqual([check, rebuild, STATUS, drop]);
    expect(f.readGraphs.mock.calls.map(([action]) => action)).toEqual(['check', 'rebuild', 'status', 'drop']);
  });
});

describe('dkg store read-graphs, failing', () => {
  it.each<[string[], RegExp]>([
    [['status', '--layer', 'xx'], /^layer must be one of wm, swm, vm\.$/],
    [['check', '--context-graph', 'not an id'], /^Invalid contextGraphId: /],
    [['drop', '--yes', '--context-graph', '../up'], /^Invalid contextGraphId: /],
  ])('refuses %j before contacting the node', async (args, message) => {
    const f = fixture({});
    await f.run(...args);
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(message));
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('prints the node refusal and exits 1', async () => {
    const f = fixture({ rebuild: ApiClient.httpError(403, 'POST /api/store/read-graphs/rebuild requires a node-level admin token; agent-scoped tokens cannot rebuild the read graphs of the node.') });
    await f.run('rebuild');
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/requires a node-level admin token/));
  });

  it('adds its commands to a store command that already exists', async () => {
    const program = new Command();
    const store = program.command('store').description('existing');
    registerReadGraphsCommand(program);
    expect(program.commands.filter((command) => command.name() === 'store')).toEqual([store]);
    expect(store.commands.map((command) => command.name())).toEqual(['read-graphs']);
    expect(store.commands[0]!.commands.map((command) => command.name())).toEqual(['status', 'check', 'rebuild', 'drop']);
  });
});

describe('ApiClient.readGraphs', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('gets the status with its filters as a query, and posts the other actions with the long deadline', async () => {
    const deadlines: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { deadlines.push(ms); return timeout(ms); });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ answered: true }) } as unknown as Response;
    }) as typeof fetch;
    const client = new ApiClient(9_200, 'operator-token', { longTimeoutMs: 1_000 });

    await expect(client.readGraphs('status', { contextGraphId: 'research', layer: 'swm' })).resolves.toEqual({ answered: true });
    await expect(client.readGraphs('status')).resolves.toEqual({ answered: true });
    await expect(client.readGraphs('check', { layer: 'vm', mode: 'sampled' })).resolves.toEqual({ answered: true });
    await expect(client.readGraphs('drop')).resolves.toEqual({ answered: true });

    expect(calls.map(({ url, init }) => [url, init.method ?? 'GET', init.body])).toEqual([
      ['http://127.0.0.1:9200/api/store/read-graphs?contextGraphId=research&layer=swm', 'GET', undefined],
      ['http://127.0.0.1:9200/api/store/read-graphs', 'GET', undefined],
      ['http://127.0.0.1:9200/api/store/read-graphs/check', 'POST', '{"layer":"vm","mode":"sampled"}'],
      ['http://127.0.0.1:9200/api/store/read-graphs/drop', 'POST', '{}'],
    ]);
    expect((calls[2]!.init.headers as Record<string, string>).Authorization).toBe('Bearer operator-token');
    expect(deadlines.filter((ms) => ms === READ_GRAPHS_REQUEST_TIMEOUT_MS)).toHaveLength(2);
  });
});

describe('the read-graphs request', () => {
  it('takes a context graph, a layer and, for check only, a mode', () => {
    expect(parseReadGraphsRequest('check', { contextGraphId: 'research', layer: 'wm', mode: 'full' })).toEqual({
      request: { contextGraphId: 'research', layer: 'wm', mode: 'full' },
    });
    expect(parseReadGraphsRequest('status', {})).toEqual({ request: {} });
    expect(parseReadGraphsRequest('drop', { mode: 'full' })).toEqual({ error: 'Unknown field "mode"; the fields are contextGraphId, layer.' });
    expect(parseReadGraphsRequest('status', null)).toHaveProperty('error');
    expect(readGraphsStatusPath({ layer: 'vm' })).toBe('/api/store/read-graphs?layer=vm');
    expect(readGraphsStatusPath()).toBe('/api/store/read-graphs');
  });
});
