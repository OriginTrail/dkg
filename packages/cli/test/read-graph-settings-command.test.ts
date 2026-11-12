// `dkg store read-graphs enable | disable | settings | default-semantics`, the
// read-graph flags of `dkg context-graph create` and `dkg query`, and the API
// client calls behind them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import { registerReadGraphsCommand } from '../src/commands/read-graphs.js';
import { registerContextGraphCommand } from '../src/commands/context-graph.js';
import { registerKnowledgeCommands } from '../src/commands/knowledge.js';
import type { ReadGraphModeChange } from '@origintrail-official/dkg-storage';
import type { ReadGraphContextGraphSettings, ReadGraphSettingsAnswer } from '../src/read-graph-settings-wire.js';

const POLICY = { enabled: true, layers: ['verifiable-memory', 'shared-working-memory', 'working-memory'] } as const;
const NODE = { layers: { 'verifiable-memory': 'off', 'shared-working-memory': 'off', 'working-memory': 'off' }, viewSemantics: 'per-asset' } as const;
const RESEARCH: ReadGraphContextGraphSettings = {
  contextGraphId: 'research',
  layers: { 'verifiable-memory': 'serve', 'working-memory': 'build' },
  viewSemantics: 'merged',
  effective: { layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'off', 'working-memory': 'build' }, viewSemantics: 'merged' },
  readGraphs: [
    { readGraph: 'did:dkg:context-graph:research/_read/vm', contextGraphId: 'research', layer: 'vm', state: 'ready', generation: 3, members: 1_204, triples: 24_080 },
    { readGraph: 'did:dkg:context-graph:research/_read/wm/0xab', contextGraphId: 'research', layer: 'wm', agentAddress: '0xab', state: 'building', generation: 1, progress: 0.4 },
  ],
};
const answer = (settings: ReadGraphContextGraphSettings, changes?: readonly ReadGraphModeChange[]): ReadGraphSettingsAnswer =>
  ({ policy: POLICY, node: NODE, contextGraphs: [settings], ...(changes === undefined ? {} : { changes }) });
const applied = (layer: ReadGraphModeChange['layer'], from: ReadGraphModeChange['from'], to: ReadGraphModeChange['to'],
  outcome: ReadGraphModeChange['outcome'] = 'applied'): ReadGraphModeChange => ({ contextGraphId: 'research', layer, from, to, outcome });
const httpError = (status: number, body: Record<string, unknown>) => ApiClient.httpError(status, String(body.error ?? `HTTP ${status}`), body);

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

const printed = () => vi.mocked(console.log).mock.calls.map(([line]) => String(line));
const failed = () => vi.mocked(console.error).mock.calls.map(([line]) => String(line));

/** A node whose settings route answers `get` and `set` as given. */
function node(answers: { get?: ReadGraphSettingsAnswer | Error; set?: ReadGraphSettingsAnswer | Error }) {
  const reply = (value: ReadGraphSettingsAnswer | Error | undefined, name: string) => {
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`unexpected ${name}`);
    return value;
  };
  const get = vi.fn(async (_contextGraphId?: string) => reply(answers.get, 'get'));
  const set = vi.fn(async (_change: unknown) => reply(answers.set, 'set'));
  const connect = vi.spyOn(ApiClient, 'connect').mockResolvedValue({ readGraphSettings: { get, set } } as unknown as ApiClient);
  const run = (...args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerReadGraphsCommand(program);
    return program.parseAsync(['node', 'dkg', 'store', 'read-graphs', ...args]);
  };
  return { run, get, set, connect };
}

describe('dkg store read-graphs enable', () => {
  it('switches published assets to preview by default, and says it is getting ready', async () => {
    const n = node({ set: answer({ ...RESEARCH, readGraphs: [] }, [applied('verifiable-memory', 'off', 'build')]) });
    await n.run('enable', '-c', 'research');
    expect(n.set).toHaveBeenCalledExactlyOnceWith({ contextGraphId: 'research', layers: { 'verifiable-memory': 'build' } });
    expect(printed()).toEqual(['Published assets of research: off → preview. Getting ready in the background.']);
    expect(process.exitCode).toBeUndefined();
  });

  it('takes on and all, and says which memories are in use already', async () => {
    const n = node({ set: answer(RESEARCH, [
      applied('verifiable-memory', 'build', 'serve'),
      applied('shared-working-memory', 'serve', 'serve', 'unchanged'),
      applied('working-memory', 'off', 'serve'),
    ]) });
    await n.run('enable', '--context-graph', 'research', '--layer', 'all', '--mode', 'on');
    expect(n.set).toHaveBeenCalledExactlyOnceWith({ contextGraphId: 'research', layers: {
      'verifiable-memory': 'serve', 'shared-working-memory': 'serve', 'working-memory': 'serve',
    } });
    expect(printed()).toEqual([
      'Published assets of research: preview → on. In use.',
      'Shared memory of research: already on.',
      'Private drafts of research: off → on. Getting ready in the background; until then, queries that ask to search across assets are told it is not ready.',
    ]);
  });

  it('says the modes in force when the node lists no changes', async () => {
    const n = node({ set: answer(RESEARCH) });
    await n.run('enable', '-c', 'research', '--layer', 'wm', '--mode', 'build');
    expect(printed()).toEqual(['Private drafts of research: preview. Getting ready 40%.']);
  });

  it('exits 1 when the node refuses a memory, and says why', async () => {
    const n = node({ set: answer(RESEARCH, [applied('verifiable-memory', 'off', 'build', { refused: 'Published assets are not allowed on this node.' })]) });
    await n.run('enable', '-c', 'research');
    expect(printed()).toEqual(['Published assets of research: stays off. Published assets are not allowed on this node.']);
    expect(process.exitCode).toBe(1);
  });

  it('prints the node\'s answer with --json, engine values and all', async () => {
    const reply = answer(RESEARCH, [applied('verifiable-memory', 'off', 'build')]);
    const n = node({ set: reply });
    await n.run('enable', '-c', 'research', '--json');
    expect(JSON.parse(printed()[0]!)).toEqual(reply);
  });

  it('refuses a mode or memory it does not know, and an invalid context graph, before it connects', async () => {
    const n = node({});
    await n.run('enable', '-c', 'research', '--mode', 'fast');
    await n.run('enable', '-c', 'research', '--layer', 'drafts');
    await n.run('enable', '-c', '');
    expect(failed()).toEqual([
      '--mode must be preview or on (or build or serve).',
      '--layer must be one of verifiable-memory, shared-working-memory, working-memory, or all.',
      'contextGraphId must be the ID of a context graph that can search across assets.',
    ]);
    expect(n.connect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('says what each memory did when the node refuses the whole change, then why', async () => {
    const refusal = httpError(409, {
      code: 'READ_GRAPHS_APPLY_REFUSED', error: 'The node could not switch it; nothing changed.',
      changes: [applied('verifiable-memory', 'off', 'build', { refused: 'The store is restarting.' })],
    });
    const n = node({ set: refusal });
    await n.run('enable', '-c', 'research');
    expect(printed()).toEqual(['Published assets of research: stays off. The store is restarting.']);
    expect(failed()).toEqual(['The node could not switch it; nothing changed.']);
    expect(process.exitCode).toBe(1);
  });

  it('tells the operator to update a node that has no settings route', async () => {
    const n = node({ set: httpError(404, { error: 'Not Found' }) });
    await n.run('enable', '-c', 'research');
    expect(failed()).toEqual(['This node cannot change search across assets yet: update it to a release with the read-graph settings.']);
    expect(process.exitCode).toBe(1);
  });
});

describe('dkg store read-graphs disable', () => {
  it('switches the memory off, published assets by default, and says the copy goes in the background', async () => {
    const n = node({ set: answer(RESEARCH, [applied('verifiable-memory', 'serve', 'off')]) });
    await n.run('disable', '-c', 'research');
    expect(n.set).toHaveBeenCalledExactlyOnceWith({ contextGraphId: 'research', layers: { 'verifiable-memory': 'off' } });
    expect(printed()).toEqual(['Published assets of research: on → off. The combined copy is removed in the background.']);
  });

  it('takes every memory with --layer all, and says the modes in force when no changes are listed', async () => {
    const off = { ...RESEARCH, layers: {}, effective: { layers: { 'verifiable-memory': 'off', 'shared-working-memory': 'off', 'working-memory': 'off' }, viewSemantics: 'per-asset' } } as const;
    const n = node({ set: answer(off) });
    await n.run('disable', '-c', 'research', '--layer', 'all');
    expect(n.set).toHaveBeenCalledExactlyOnceWith({ contextGraphId: 'research', layers: {
      'verifiable-memory': 'off', 'shared-working-memory': 'off', 'working-memory': 'off',
    } });
    expect(printed()).toEqual(['Published assets of research: off.', 'Shared memory of research: off.', 'Private drafts of research: off.']);
  });
});

describe('dkg store read-graphs default-semantics', () => {
  it('sets merged or per-asset, and none goes back to the node\'s default', async () => {
    const n = node({ set: answer(RESEARCH) });
    await n.run('default-semantics', '-c', 'research', 'merged');
    expect(n.set).toHaveBeenLastCalledWith({ contextGraphId: 'research', viewSemantics: 'merged' });
    n.set.mockResolvedValueOnce(answer({ ...RESEARCH, viewSemantics: undefined, effective: { ...RESEARCH.effective!, viewSemantics: 'per-asset' } }));
    await n.run('default-semantics', '-c', 'research', 'none');
    expect(n.set).toHaveBeenLastCalledWith({ contextGraphId: 'research', viewSemantics: null });
    expect(printed()).toEqual([
      'Queries on research that don\'t choose now search across assets.',
      'Queries on research that don\'t choose follow the node\'s default: search each asset on its own.',
    ]);
  });

  it('refuses anything but merged, per-asset and none', async () => {
    const n = node({});
    await n.run('default-semantics', '-c', 'research', 'union');
    expect(failed()).toEqual(['The default must be merged, per-asset or none.']);
    expect(n.connect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('dkg store read-graphs settings', () => {
  it('lists the policy, then each context graph\'s memories and default semantics', async () => {
    const n = node({ get: answer(RESEARCH) });
    await n.run('settings');
    expect(n.get).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(printed()).toEqual([
      'Search across assets is allowed for: Published assets; Shared memory, shared with your team; Private drafts.',
      'research',
      '  Published assets: on, in use. 1,204 assets, holds about 24,080 facts.',
      '  Shared memory, shared with your team: off (node default).',
      '  Private drafts: preview, getting ready 40%.',
      '  Queries that don\'t choose: search across assets.',
    ]);
  });

  it('reads one context graph, says why the node can\'t switch it on, and when there is nothing to list', async () => {
    const n = node({ get: { policy: { enabled: false, layers: [] }, node: NODE, refused: { code: 'READ_GRAPHS_DISABLED', error: 'It is switched off in config.json.' }, contextGraphs: [] } });
    await n.run('settings', '-c', 'research');
    expect(n.get).toHaveBeenCalledExactlyOnceWith('research');
    expect(printed()).toEqual([
      'Search across assets is switched off on this node (query.readGraphsPolicy in its config.json).',
      'This node can\'t switch it on: It is switched off in config.json.',
      'No context graph has settings or read graphs.',
    ]);
  });

  it('prints the answer with --json, and refuses an invalid context graph before it connects', async () => {
    const n = node({ get: answer(RESEARCH) });
    await n.run('settings', '--json');
    expect(JSON.parse(printed()[0]!)).toEqual(answer(RESEARCH));
    await n.run('settings', '-c', '');
    expect(failed()).toEqual(['--context-graph must be the ID of a context graph that can search across assets.']);
    expect(n.connect).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('says so when the caller is not the node admin', async () => {
    const n = node({ get: httpError(403, { error: 'This route needs the node-admin token.' }) });
    await n.run('settings');
    expect(failed()).toEqual(['This route needs the node-admin token.']);
    expect(process.exitCode).toBe(1);
  });
});

describe('ApiClient.readGraphSettings', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('gets the settings, of one context graph as a query, and puts a change, with the node-admin token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return { ok: true, status: 200, statusText: 'OK', json: async () => answer(RESEARCH) } as unknown as Response;
    }) as typeof fetch;
    const client = new ApiClient(9_200, 'operator-token');

    await expect(client.readGraphSettings.get()).resolves.toEqual(answer(RESEARCH));
    await expect(client.readGraphSettings.get('0xab/research')).resolves.toEqual(answer(RESEARCH));
    await expect(client.readGraphSettings.set({ contextGraphId: 'research', layers: { 'verifiable-memory': 'build' } })).resolves.toEqual(answer(RESEARCH));

    expect(calls.map(({ url, init }) => [url, init.method ?? 'GET', init.body])).toEqual([
      ['http://127.0.0.1:9200/api/store/read-graphs/settings', 'GET', undefined],
      ['http://127.0.0.1:9200/api/store/read-graphs/settings?contextGraphId=0xab%2Fresearch', 'GET', undefined],
      ['http://127.0.0.1:9200/api/store/read-graphs/settings', 'PUT', '{"contextGraphId":"research","layers":{"verifiable-memory":"build"}}'],
    ]);
    expect((calls[2]!.init.headers as Record<string, string>).Authorization).toBe('Bearer operator-token');
    // The settings table records the CLI as the actor of a change.
    expect((calls[2]!.init.headers as Record<string, string>)['x-dkg-actor']).toBe('cli');
    expect((calls[0]!.init.headers as Record<string, string>)['x-dkg-actor']).toBeUndefined();
  });

  it('sends the creation\'s read-graph setting with the CLI as its actor, and no actor without one', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ created: '0xab/research', uri: 'did:dkg:context-graph:0xab/research' }) } as unknown as Response;
    }) as typeof fetch;
    const client = new ApiClient(9_200, 'operator-token');
    await client.createContextGraph('0xab/research', 'research', undefined, { readGraphs: { layers: { 'verifiable-memory': 'build' } } });
    await client.createContextGraph('0xab/plain', 'plain');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ id: '0xab/research', readGraphs: { layers: { 'verifiable-memory': 'build' } } });
    expect((calls[0]!.init.headers as Record<string, string>)['x-dkg-actor']).toBe('cli');
    expect(JSON.parse(String(calls[1]!.init.body))).not.toHaveProperty('readGraphs');
    expect((calls[1]!.init.headers as Record<string, string>)['x-dkg-actor']).toBeUndefined();
  });

  it('keeps a refusal\'s code and body on the error it throws', async () => {
    globalThis.fetch = (async () => ({
      ok: false, status: 409, statusText: 'Conflict',
      json: async () => ({ code: 'READ_GRAPHS_DISABLED', error: 'Search across assets is switched off on this node.' }),
    }) as unknown as Response) as typeof fetch;
    await expect(new ApiClient(9_200, 'operator-token').readGraphSettings.set({ contextGraphId: 'research', viewSemantics: 'merged' }))
      .rejects.toMatchObject({ httpStatus: 409, message: 'Search across assets is switched off on this node.', responseBody: { code: 'READ_GRAPHS_DISABLED' } });
  });
});

describe('dkg context-graph create --read-graphs', () => {
  function creating(result: Record<string, unknown>) {
    const createContextGraph = vi.fn(async (..._args: unknown[]) => ({ created: '0xab/research', uri: 'did:dkg:context-graph:0xab/research', ...result }));
    const connect = vi.spyOn(ApiClient, 'connect').mockResolvedValue({ createContextGraph } as unknown as ApiClient);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit);
    const run = (...args: string[]) => {
      const program = new Command();
      program.exitOverride();
      registerContextGraphCommand(program);
      return program.parseAsync(['node', 'dkg', 'context-graph', 'create', '0xab/research', ...args]);
    };
    return { run, createContextGraph, connect, exit };
  }

  it('sends the setting with the creation, and says what the node switched', async () => {
    const c = creating({ readGraphs: { applied: true, changes: [{ ...applied('verifiable-memory', 'off', 'build'), contextGraphId: '0xab/research' }] } });
    await c.run('--read-graphs', 'preview');
    expect(c.createContextGraph.mock.calls[0]![3]).toMatchObject({ readGraphs: { layers: { 'verifiable-memory': 'build' } } });
    expect(printed()).toContain('  Published assets of 0xab/research: off → preview. Getting ready in the background.');
    expect(process.exitCode).toBeUndefined();
  });

  it('sends none without the flag', async () => {
    const c = creating({});
    await c.run();
    expect(c.createContextGraph.mock.calls[0]![3]).toMatchObject({ readGraphs: undefined });
    expect(printed().some((line) => line.includes('across assets'))).toBe(false);
  });

  it('still creates the context graph when the node refuses the setting, and exits 1 with how to switch it on later', async () => {
    const c = creating({ readGraphs: { refused: 'This node\'s store keeps no combined copies.', code: 'READ_GRAPHS_UNSUPPORTED' } });
    await c.run('--read-graphs', 'on', '--read-graph-layer', 'all');
    expect(c.createContextGraph.mock.calls[0]![3]).toMatchObject({ readGraphs: { layers: {
      'verifiable-memory': 'serve', 'shared-working-memory': 'serve', 'working-memory': 'serve',
    } } });
    expect(printed()).toEqual(expect.arrayContaining([
      '  ID:   0xab/research',
      '  Search across assets was not switched on: This node\'s store keeps no combined copies.',
      '  Switch it on later with: dkg store read-graphs enable -c 0xab/research --layer all --mode on',
    ]));
    expect(process.exitCode).toBe(1);
  });

  it('refuses a wrong flag before anything is created', async () => {
    const c = creating({});
    await expect(c.run('--read-graph-layer', 'all')).rejects.toThrow('exit 1');
    expect(failed()).toEqual(['--read-graph-layer needs --read-graphs.']);
    expect(c.connect).not.toHaveBeenCalled();
  });
});

describe('dkg query --view --semantics', () => {
  function querying(reply: { result: unknown; semantics?: string }) {
    const query = vi.fn(async (..._args: unknown[]) => reply);
    const connect = vi.spyOn(ApiClient, 'connect').mockResolvedValue({ query } as unknown as ApiClient);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit);
    const run = (...args: string[]) => {
      const program = new Command();
      program.exitOverride();
      registerKnowledgeCommands(program);
      return program.parseAsync(['node', 'dkg', 'query', 'research', '-q', 'SELECT ?s WHERE { ?s ?p ?o }', ...args]);
    };
    return { run, query, connect, exit };
  }

  it('asks for merged semantics on published assets, and says the answer searched across assets', async () => {
    const q = querying({ result: { type: 'bindings', bindings: [{ s: 'urn:a' }] }, semantics: 'merged' });
    await q.run('--semantics', 'merged');
    expect(q.query).toHaveBeenCalledExactlyOnceWith('SELECT ?s WHERE { ?s ?p ?o }', 'research', {
      includeSharedMemory: false, view: 'verifiable-memory', semantics: 'merged',
    });
    expect(printed()).toContain('\n1 row(s), searched across assets');
  });

  it('keeps a query without the flags as it was, and says nothing about assets for a per-asset answer', async () => {
    const q = querying({ result: { type: 'bindings', bindings: [] } });
    await q.run();
    expect(q.query).toHaveBeenCalledExactlyOnceWith('SELECT ?s WHERE { ?s ?p ?o }', 'research', { includeSharedMemory: false });
    await q.run('--view', 'wm', '--semantics', 'per-asset');
    expect(q.query).toHaveBeenLastCalledWith('SELECT ?s WHERE { ?s ?p ?o }', 'research', {
      includeSharedMemory: false, view: 'working-memory', semantics: 'per-asset',
    });
    expect(printed()).toEqual(['No results.', 'No results.']);
  });

  it('refuses a semantics or view it does not know before it connects', async () => {
    const q = querying({ result: { type: 'bindings', bindings: [] } });
    await expect(q.run('--semantics', 'union')).rejects.toThrow('exit 1');
    expect(failed()).toEqual(['--semantics must be merged or per-asset.']);
    expect(q.connect).not.toHaveBeenCalled();
  });
});
