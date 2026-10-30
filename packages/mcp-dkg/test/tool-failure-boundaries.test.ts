import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DkgClient } from '../src/client.js';
import { registerAssertionTools } from '../src/tools/assertions.js';
import { registerSetupTools } from '../src/tools/setup.js';
import { registerHealthTools } from '../src/tools/health.js';
import { registerChatTools } from '../src/tools/chat.js';
import { FakeServer, makeConfig, type ToolResult } from './harness.js';

const text = (result: ToolResult) => result.content.map((part) => part.text).join('\n');
const quad = { subject: 'urn:s', predicate: 'urn:p', object: '"value"' };
const assertionCalls: Array<[string, Record<string, unknown>]> = [
  ['dkg_knowledge_asset_create', { name: 'notes' }],
  ['dkg_knowledge_asset_create', { name: 'notes', quads: [quad] }],
  ['dkg_knowledge_asset_write', { name: 'notes', quads: [quad] }],
  ['dkg_knowledge_asset_finalize', { name: 'notes' }],
  ['dkg_knowledge_asset_share', { name: 'notes' }],
  ['dkg_knowledge_asset_publish', { name: 'notes' }],
  ['dkg_knowledge_asset_pull_from', { name: 'notes', layer: 'swm' }],
  ['dkg_knowledge_asset_discard', { name: 'notes' }],
  ['dkg_knowledge_asset_query', { name: 'notes' }],
  ['dkg_knowledge_asset_import_artifact_resolve', { assertionUri: 'urn:assertion' }],
  ['dkg_knowledge_asset_import_artifact_read_markdown', { assertionUri: 'urn:assertion' }],
  [
    'dkg_knowledge_asset_semantic_enrichment_write',
    { assertionUri: 'urn:assertion', semanticQuads: [quad] },
  ],
  ['dkg_knowledge_asset_history', { name: 'notes' }],
];
const otherCalls: Array<[string, Record<string, unknown>]> = [
  ['dkg_context_graph_create', { name: 'Team' }],
  ['dkg_context_graph_register', { contextGraphId: 'team' }],
  ['dkg_subscribe', { contextGraphId: 'team' }],
  ['dkg_sub_graph_create', { contextGraphId: 'team', subGraphName: 'notes' }],
  ['dkg_status', {}],
  ['dkg_peer_info', { peerId: 'peer' }],
  ['dkg_wallet_balances', {}],
  ['dkg_send_message', { to: 'peer', text: 'hello' }],
  ['dkg_check_inbox', {}],
];
function harness(defaultProject: string | null = 'team') {
  const config = makeConfig({ defaultProject });
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
  const client = new DkgClient({ config, fetcher });
  const server = new FakeServer();
  for (const register of [
    registerAssertionTools,
    registerSetupTools,
    registerHealthTools,
    registerChatTools,
  ]) {
    register(server.asMcpServer(), client, config);
  }
  return { server, fetcher };
}
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tool-failures-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('tool failures remain explicit, recoverable MCP responses', () => {
  it.each([
    ...assertionCalls,
    ['dkg_knowledge_asset_import_file', { name: 'notes', filePath: '/not-read' }] as [
      string,
      Record<string, unknown>,
    ],
  ])('%s requires a context graph before doing any I/O', async (name, input) => {
    const h = harness(null);
    const result = await h.server.call(name, input);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/project|context.graph/i);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it.each([...assertionCalls, ...otherCalls])(
    '%s reports rejected daemon requests',
    async (name, input) => {
      const h = harness();
      h.fetcher.mockImplementation(async () =>
        Response.json({ error: 'permission denied' }, { status: 403 }),
      );
      const result = await h.server.call(name, input);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('403');
      expect(text(result)).toContain('permission denied');
    },
  );
  it.each([
    'dkg_context_graph_create',
    'dkg_status',
    'dkg_send_message',
    'dkg_knowledge_asset_create',
  ])('%s preserves non-Error failures', async (name) => {
    const h = harness();
    h.fetcher.mockRejectedValue('connection closed');
    const input = [...assertionCalls, ...otherCalls].find(([tool]) => tool === name)![1];
    const result = await h.server.call(name, input);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('connection closed');
  });
});

describe('setup validates before writing and preserves idempotency', () => {
  it.each([
    ['dkg_context_graph_create', { name: '  ' }, '"name" is required'],
    ['dkg_context_graph_create', { name: '!!!' }, 'Could not derive'],
    ['dkg_context_graph_create', { name: 'Team', id: '-bad-' }, 'Invalid context graph ID'],
    ['dkg_context_graph_register', { contextGraphId: '  ' }, '"contextGraphId" is required'],
    [
      'dkg_context_graph_register',
      { contextGraphId: 'team', pcaAccountId: '1', contribution: 'open' },
      'curated contribution',
    ],
    ['dkg_subscribe', { contextGraphId: '  ' }, '"contextGraphId" is required'],
    [
      'dkg_sub_graph_create',
      { contextGraphId: '  ', subGraphName: 'notes' },
      '"contextGraphId" is required',
    ],
    [
      'dkg_sub_graph_create',
      { contextGraphId: 'team', subGraphName: '  ' },
      '"subGraphName" is required',
    ],
  ] as Array<[string, Record<string, unknown>, string]>)(
    '%s rejects invalid setup input: %j',
    async (name, input, message) => {
      const h = harness();
      const result = await h.server.call(name, input);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(message);
      expect(h.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    'serializes explicit policies and describes registration (already registered: %s)',
    async (duplicate) => {
      const h = harness();
      h.fetcher.mockResolvedValueOnce(
        Response.json(duplicate ? { error: 'already registered' } : { registered: 'team' }, {
          status: duplicate ? 409 : 200,
        }),
      );
      const result = await h.server.call('dkg_context_graph_register', {
        contextGraphId: ' team ',
        sharing: 'invite-only',
        contribution: 'curators-only',
      });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain(
        duplicate ? 'already registered' : "Registered context graph 'team'",
      );
      expect(JSON.parse(String(h.fetcher.mock.calls[0][1]?.body))).toEqual({
        id: 'team',
        accessPolicy: 1,
        publishPolicy: 0,
      });
      expect(text(result)).not.toContain('undefined');
    },
  );
  it('surfaces an existing graph and trims description before create', async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(Response.json({ error: 'already exists' }, { status: 409 }));
    expect(
      text(
        await h.server.call('dkg_context_graph_create', {
          name: ' Team ',
          description: ' purpose ',
          sharing: 'open',
          contribution: 'open',
        }),
      ),
    ).toContain('already exists');
    expect(JSON.parse(String(h.fetcher.mock.calls[0][1]?.body))).toEqual({
      id: 'team',
      name: 'Team',
      description: 'purpose',
      accessPolicy: 0,
      publishPolicy: 1,
    });
  });
});

describe('wallet diagnostics', () => {
  it.each([
    [{ balances: [], chainId: null }, ['no operational wallets found'], ['Chain:', 'RPC:']],
    [
      { balances: [{ address: '0xabc', eth: '0', trac: '5' }], chainId: 1 },
      ['0xabc', '0 ETH', '5 TRAC', 'Chain: 1'],
      ['RPC:'],
    ],
    [
      {
        balances: [{ address: '0xabc', eth: '2', trac: '3', symbol: 'TEST' }],
        chainId: 0,
        rpcUrl: 'http://rpc',
      },
      ['3 TEST', 'Chain: 0', 'RPC: http://rpc'],
      [],
    ],
  ] as Array<[unknown, string[], string[]]>)(
    'renders the actual wallet state: %j',
    async (payload, present, absent) => {
      const h = harness();
      h.fetcher.mockResolvedValueOnce(Response.json(payload));
      const result = await h.server.call('dkg_wallet_balances');
      expect(result.isError).toBeFalsy();
      for (const value of present) expect(text(result)).toContain(value);
      for (const value of absent) expect(text(result)).not.toContain(value);
    },
  );
  it('treats an HTTP-success probe error as a failed diagnostic', async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(Response.json({ error: 'RPC unavailable' }));
    const result = await h.server.call('dkg_wallet_balances');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('RPC unavailable');
  });
});

describe('file import boundaries', () => {
  it('rejects whitespace paths before opening a file', async () => {
    const h = harness();
    const result = await h.server.call('dkg_knowledge_asset_import_file', {
      name: 'notes',
      filePath: '  ',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('"filePath" is required');
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it.each(['opaque', 'opaque.', 'opaque.unknown', 'notes.md'])(
    'uploads %s with explicit or inferred MIME and preserves bytes',
    async (fileName) => {
      const h = harness();
      const filePath = path.join(home, fileName);
      fs.writeFileSync(filePath, 'imported bytes');
      const explicit = fileName === 'notes.md';
      const result = await h.server.call('dkg_knowledge_asset_import_file', {
        name: 'notes',
        filePath,
        ...(explicit ? { contentType: 'text/plain' } : {}),
      });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('Extraction status: (unknown)');
      expect(text(result)).not.toContain('triple(s)');
      const form = h.fetcher.mock.calls[0][1]?.body as FormData;
      const file = form.get('file') as File;
      expect(file.name).toBe(fileName);
      expect(await file.text()).toBe('imported bytes');
      expect(file.type).toBe(explicit ? 'text/plain' : 'application/octet-stream');
      expect(text(result).includes('Content type:')).toBe(explicit);
    },
  );
  it('reports an HTTP rejection after reading a file without claiming import succeeded', async () => {
    const h = harness();
    const filePath = path.join(home, 'notes.md');
    fs.writeFileSync(filePath, '# notes');
    h.fetcher.mockResolvedValueOnce(Response.json({ error: 'quota exceeded' }, { status: 422 }));
    const result = await h.server.call('dkg_knowledge_asset_import_file', {
      name: 'notes',
      filePath,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('quota exceeded');
    expect(text(result)).not.toContain("Imported '");
  });
});

describe('optional outcome metadata', () => {
  it('rejects an empty assertion name at the public schema boundary', async () => {
    const h = harness();
    await expect(h.server.call('dkg_knowledge_asset_create', { name: '' })).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it('does not invent a URI when an older daemon omits it', async () => {
    const h = harness();
    expect(text(await h.server.call('dkg_knowledge_asset_create', { name: 'notes' }))).toContain(
      'URI: (unset)',
    );
  });
  it('reports a partial share failure even when status, seal metadata and the error description are absent', async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(
      Response.json({ publishReady: false, errors: [{ phase: 'swm-share' }] }, { status: 207 }),
    );
    const result = await h.server.call('dkg_knowledge_asset_create', {
      name: 'notes',
      quads: [quad],
      alsoShareSwm: true,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('share FAILED');
    expect(text(result)).toContain('"sealed": null');
    expect(text(result)).toContain('"status": null');
    expect(text(result)).not.toContain('undefined');
  });
  it('normalizes bracketed write terms while preserving object literals', async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(Response.json({ written: 2 }));
    const result = await h.server.call('dkg_knowledge_asset_write', {
      name: 'notes',
      quads: [
        { subject: '<urn:s>', predicate: '<urn:p>', object: '"<literal>"' },
        { subject: '<incomplete', predicate: 'urn:p', object: '"value"' },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(h.fetcher.mock.calls[0][1]?.body)).quads).toEqual([
      { subject: 'urn:s', predicate: 'urn:p', object: '"<literal>"' },
      { subject: '<incomplete', predicate: 'urn:p', object: '"value"' },
    ]);
  });
  it('includes a new graph description and forwards open registration policies', async () => {
    const h = harness();
    h.fetcher
      .mockResolvedValueOnce(Response.json({ uri: 'urn:team' }))
      .mockResolvedValueOnce(Response.json({ registered: 'team' }));
    expect(
      text(
        await h.server.call('dkg_context_graph_create', {
          name: 'Team',
          description: 'Shared work',
        }),
      ),
    ).toContain('Description: Shared work');
    await h.server.call('dkg_context_graph_register', {
      contextGraphId: 'team',
      sharing: 'open',
      contribution: 'open',
    });
    expect(JSON.parse(String(h.fetcher.mock.calls[1][1]?.body))).toEqual({
      id: 'team',
      accessPolicy: 0,
      publishPolicy: 1,
    });
  });
  it('renders legacy chat retry responses without inventing successful delivery', async () => {
    const h = harness();
    h.fetcher
      .mockResolvedValueOnce(Response.json({ delivered: false, queued: true }))
      .mockResolvedValueOnce(Response.json({ delivered: false }));
    const queued = await h.server.call('dkg_send_message', { to: 'peer', text: 'hello' });
    expect(text(queued)).toContain('QUEUED');
    expect(text(queued)).toContain('attempt #1 just failed: unknown error');
    const rejected = await h.server.call('dkg_send_message', { to: 'peer', text: 'hello' });
    expect(rejected.isError).toBe(true);
    expect(text(rejected)).toContain('NOT delivered: unknown error');
  });
  it('describes an empty filtered history without marking unrelated messages read', async () => {
    const h = harness();
    h.fetcher.mockImplementation(async (url) =>
      Response.json(String(url).includes('/api/messages') ? { messages: [] } : { agents: [] }),
    );
    const result = await h.server.call('dkg_check_inbox', {
      peer: 'alice',
      since: 1000,
      directionFilter: 'out',
    });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe('No messages from alice since 1970-01-01 00:00:01 (direction=out).');
    expect(fs.existsSync(path.join(home, '.cache'))).toBe(false);
  });
});
