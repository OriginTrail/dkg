import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAdapters } from '../src/adapters.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-adapters-'));
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function module(name: string, source: string) {
  const file = join(root, `${name}.mjs`);
  writeFileSync(file, source);
  return pathToFileURL(file).href;
}

it.each([undefined, '', ' ,  , '])(
  'does nothing with empty adapter selection %j',
  async (value) => {
    vi.stubEnv('DKG_ADAPTERS', value);
    const server = new FakeServer();
    await loadAdapters(server.asMcpServer(), new FakeClient().asDkgClient(), makeConfig());
    expect(server.tools.size).toBe(0);
    expect(process.stderr.write).not.toHaveBeenCalled();
  },
);
it('continues after retired, missing, incompatible, and throwing adapters and passes the resolved context to the valid one', async () => {
  const good = module(
    'good',
    `export function registerTools(server, client, config) { server.registerTool('custom', {}, async () => ({ content: [{type:'text',text: config.defaultProject + ':' + (await client.getAgentIdentity()).peerId}] })); }`,
  );
  const noExport = module('no-export', 'export const version = 1;');
  const failure = module(
    'error',
    'export function registerTools() { throw new Error("adapter error"); }',
  );
  const nonError = module(
    'non-error',
    'export function registerTools() { throw "adapter refused"; }',
  );
  vi.stubEnv(
    'DKG_ADAPTERS',
    [
      'autoresearch',
      pathToFileURL(join(root, 'missing.mjs')).href,
      noExport,
      failure,
      nonError,
      `  ${good}  `,
    ].join(','),
  );
  const server = new FakeServer();
  await loadAdapters(
    server.asMcpServer(),
    new FakeClient().asDkgClient(),
    makeConfig({ defaultProject: 'pinned' }),
  );
  expect(await server.call('custom')).toEqual({
    content: [{ type: 'text', text: 'pinned:peer-test' }],
  });
  const logs = vi
    .mocked(process.stderr.write)
    .mock.calls.map(([line]) => String(line))
    .join('');
  for (const expected of [
    'retired',
    'missing.mjs',
    'no registerTools export',
    'adapter error',
    'adapter refused',
    'adapter loaded:',
  ])
    expect(logs).toContain(expected);
  expect(server.tools.size).toBe(1);
});
