import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DkgClient, type SparqlResult } from '../src/client.js';
import { inboxCursorPath, loadInboxCursor } from '../src/inbox-cursor.js';
import { registerChatTools } from '../src/tools/chat.js';
import { registerMemorySearchTool } from '../src/tools/memory-search.js';
import { bindingsToParagraphs, prettyTerm, sourceLabel } from '../src/sparql.js';
import { FakeClient, FakeServer, makeConfig } from './harness.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-recall-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('persistent inbox reads', () => {
  it('resumes after a server restart at the same-millisecond row id and isolates another daemon', async () => {
    const requests: URL[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/api/agents') return Response.json({ agents: [] });
      requests.push(parsed);
      const id = parsed.searchParams.get('sinceId') === '7' ? 8 : 7;
      return Response.json({
        messages: [{ id, ts: 1000, direction: 'in', peer: 'peer', text: `message ${id}` }],
      });
    });
    const read = async (api = 'http://localhost:9200') => {
      const config = makeConfig({ api, sourcePath: path.join(home, 'config.yaml') });
      const server = new FakeServer();
      registerChatTools(server.asMcpServer(), new DkgClient({ config, fetcher }), config);
      return server.call('dkg_check_inbox');
    };
    expect((await read()).content[0].text).toContain('message 7');
    expect((await read()).content[0].text).toContain('message 8');
    expect((await read('http://localhost:9300')).content[0].text).toContain('message 7');
    expect(requests.map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { direction: 'in', order: 'asc' },
      { since: '1000', sinceId: '7', direction: 'in', order: 'asc' },
      { direction: 'in', order: 'asc' },
    ]);
    expect(
      loadInboxCursor({ api: 'http://localhost:9200', sourcePath: path.join(home, 'config.yaml') }),
    ).toEqual({ ts: 1000, id: 8 });
    expect(
      loadInboxCursor({ api: 'http://localhost:9300', sourcePath: path.join(home, 'config.yaml') }),
    ).toEqual({ ts: 1000, id: 7 });
  });
  it.each([{ ts: 50 }, { ts: 50, id: 'old' }, { unrelated: 1 }])(
    'recovers partial/unknown cursor state: %j',
    (state) => {
      const identity = { api: 'http://localhost:9200', sourcePath: null };
      const target = inboxCursorPath(identity);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(state));
      expect(loadInboxCursor(identity)).toEqual({ ts: 'ts' in state ? 50 : 0, id: 0 });
    },
  );
  it('formats an out-of-range timestamp without losing an otherwise readable message', async () => {
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: async (url) =>
        Response.json(
          String(url).includes('/api/agents')
            ? { agents: [null, 'bad entry', { peerId: 'short', name: 123 }] }
            : {
                messages: [
                  {
                    id: 1,
                    ts: 1e20,
                    direction: 'out',
                    peer: 'short',
                    text: 'line one\nline two',
                    delivered: false,
                  },
                ],
              },
        ),
    });
    const server = new FakeServer();
    registerChatTools(server.asMcpServer(), client, makeConfig());
    const result = await server.call('dkg_check_inbox', { directionFilter: 'out' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('100000000000000000000 [UNDELIVERED]');
    expect(result.content[0].text).toContain('line one\n    line two');
    expect(fs.existsSync(path.join(home, '.cache'))).toBe(false);
  });
});

describe('memory search degradation and ranking', () => {
  function harness(client: FakeClient) {
    const server = new FakeServer();
    registerMemorySearchTool(server.asMcpServer(), client.asDkgClient(), makeConfig());
    return server;
  }
  it('rejects whitespace and handles queries containing only single-letter tokens without querying', async () => {
    const client = new FakeClient();
    const server = harness(client);
    expect((await server.call('dkg_memory_search', { query: '  ' })).isError).toBe(true);
    expect((await server.call('dkg_memory_search', { query: 'a b' })).content[0].text).toBe(
      'No hits for "a b".',
    );
    expect(client.queryCalls).toHaveLength(0);
  });
  it('keeps a surviving layer when the other layers fail and does not log query text', async () => {
    const query = 'private-query';
    const client = new FakeClient({
      query: async (args) => {
        if (args.view === 'working-memory') throw new Error('WM offline');
        if (args.view === 'shared-working-memory') throw 'SWM offline';
        return {
          type: 'bindings',
          bindings: [{ uri: 'urn:hit', text: `Only VM contains ${query} in a long fact.` }],
        };
      },
    });
    const result = await harness(client).call('dkg_memory_search', { query });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('1 hit(s)');
    expect(result.content[0].text).toContain('urn:hit');
    const logs = vi
      .mocked(process.stderr.write)
      .mock.calls.map((call) => String(call[0]))
      .join('');
    expect(logs).toContain('WM offline');
    expect(logs).toContain('SWM offline');
    expect(logs).not.toContain(query);
  });
  it('drops empty and nonmatching bindings, ranks same-tier duplicates, and bounds long snippets', async () => {
    const long = `alpha beta ${'x'.repeat(600)}`;
    const client = new FakeClient({
      query: async (args): Promise<SparqlResult> =>
        args.view !== 'working-memory'
          ? { type: 'boolean', value: false }
          : {
              type: 'bindings',
              bindings: [
                { uri: 'urn:empty', text: '' },
                { uri: 'urn:irrelevant', text: 'this does not contain either search term' },
                {
                  uri: 'urn:duplicate',
                  text: 'alpha is the first partial match in this collection',
                },
                { uri: 'urn:duplicate', text: long },
                { uri: 'urn:duplicate', text: 'alpha loses after the better scoring duplicate' },
                { text: 'alpha beta text-only fallback remains a distinct hit' },
              ],
            },
    });
    const result = await harness(client).call('dkg_memory_search', {
      query: 'alpha beta',
      limit: 2,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('2 hit(s)');
    expect(text).toContain(long.slice(0, 500) + '…');
    expect(text).not.toContain('x'.repeat(500));
    expect(text).toContain('text-only fallback');
    expect(text).toContain('score=1.00');
    for (const absent of ['urn:empty', 'urn:irrelevant', 'first partial', 'loses after'])
      expect(text).not.toContain(absent);
    expect(text.match(/`urn:duplicate`/g)).toHaveLength(1);
  });
});

describe('RDF result presentation', () => {
  it('renders heterogeneous binding values as numbered paragraphs without raw RDF wrappers', () => {
    expect(bindingsToParagraphs([])).toBe('(no results)');
    expect(
      bindingsToParagraphs([
        { name: { type: 'literal', value: '"Živa"@sl' }, count: '"42"^^<urn:integer>' },
        { kind: '<http://schema.org/Person>' },
      ]),
    ).toBe('### 1.\n  - **name**: Živa\n  - **count**: 42\n\n### 2.\n  - **kind**: schema:Person');
    expect(prettyTerm('')).toBe('');
    expect(prettyTerm('"unterminated')).toBe('"unterminated');
    expect(sourceLabel({ sourceGraph: 'urn:unattributed' })).toBe('`urn:unattributed`');
  });
});

it('does not rewrite a persisted inbox cursor for stale rows returned by an older daemon', async () => {
  const config = makeConfig();
  const cursorPath = inboxCursorPath({ api: config.api, sourcePath: config.sourcePath });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(cursorPath, '{"ts":1000,"id":8}');
  const client = new FakeClient({
    getMessages: async () => ({
      messages: [{ id: 7, ts: 1000, direction: 'in', peer: 'peer', text: 'already surfaced' }],
    }),
  });
  const server = new FakeServer();
  registerChatTools(server.asMcpServer(), client.asDkgClient(), config);
  const write = vi.spyOn(fs, 'writeFileSync');
  const result = await server.call('dkg_check_inbox');
  expect(result.isError).toBeFalsy();
  expect(write).not.toHaveBeenCalled();
  expect(loadInboxCursor({ api: config.api, sourcePath: config.sourcePath })).toEqual({
    ts: 1000,
    id: 8,
  });
});
