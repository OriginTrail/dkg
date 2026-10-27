import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { runWindowsMcpSmoke } from '../../test-mcp-wsl-launch.mjs';
const require = createRequire(import.meta.url);
const { readRegistration, runWindowsClient } = require('../../../packages/cli/test/fixtures/mcp-windows-client.fixture.cjs');
const project = "project 'literal' $HOME";
const entry = { command: 'C:\\Windows\\System32\\wsl.exe',
  args: ['--distribution', 'Ubuntu', '--user', 'alice', '--exec', '/usr/bin/env', '--', 'node', 'cli.js', 'mcp', 'serve'],
  env: { DKG_PROJECT: project, WSLENV: 'DKG_PROJECT/u:EXTRA/u', EXTRA: 'literal value' } };

for (const container of ['mcpServers', 'servers']) {
  test(`reads JSONC ${container} without losing persisted environment`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'dkg-wsl-smoke-'));
    try {
      const path = join(directory, 'config.json');
      writeFileSync(path, `{ // editor configuration\n "${container}": {"dkg": ${JSON.stringify(entry)},},}`);
      assert.deepEqual(readRegistration(path), entry);
      writeFileSync(path, JSON.stringify({ [container]: { dkg: { ...entry, env: {} } } }));
      assert.throws(() => readRegistration(path), /Configure DKG_PROJECT/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('WSL wrapper launches the shared driver in Windows Node with literal arguments', () => {
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/wslpath') return `${args[0]}:${args[1]}\n`;
    return 'passed\n';
  };
  assert.equal(runWindowsMcpSmoke('/mnt/c/config with spaces.json', 'C:\\Program Files\\node.exe', project, '59231',
    { platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, execute }), 'passed\n');
  const launch = calls.at(-1);
  assert.equal(launch.command, '/usr/bin/env');
  assert.equal(launch.args[0], '--');
  assert.equal(launch.args[1], '-u:C:\\Program Files\\node.exe');
  assert.match(launch.args[2], /mcp-windows-client\.fixture\.cjs$/);
  assert.deepEqual(launch.args.slice(3), ['-w:/mnt/c/config with spaces.json', project, '59231']);
  assert.equal(launch.options.timeout, 300000);
  assert.throws(() => runWindowsMcpSmoke('config', 'node', undefined, undefined,
    { platform: 'linux', env: {}, execute }), /real WSL/);
});

function runtime(reportedProject = project) {
  let launch;
  let closes = 0;
  let stdout = '';
  class StdioClientTransport {
    stderr = new EventEmitter();
    constructor(options) { launch = options; }
    async close() { closes++; }
  }
  class Client {
    async connect(transport) {
      transport.stderr.emit('data', `api=http://127.0.0.1:59231 · config=fixture · project=${reportedProject} · agent=<unset> · token=[set]\n`);
    }
    getServerVersion() { return { name: 'dkg' }; }
    async listTools() { return { tools: [{ name: 'query' }] }; }
    async close() { closes++; }
  }
  return { options: { platform: 'win32', env: { PATH: 'windows path', WSLENV: 'WRONG/w', DKG_PROJECT: 'inherited wrong project' },
    Client, StdioClientTransport, output: { write: value => { stdout += value; } }, diagnostic: { write() {} } },
  launch: () => launch, closes: () => closes, stdout: () => stdout };
}

test('Windows client applies the exact saved env, replacing inherited WSLENV and project', async () => {
  const r = runtime();
  await runWindowsClient(entry, project, '59231', r.options);
  assert.deepEqual(r.launch(), { command: entry.command, args: entry.args, stderr: 'pipe',
    env: { PATH: 'windows path', WSLENV: entry.env.WSLENV, DKG_PROJECT: project, EXTRA: 'literal value' } });
  assert.equal(r.closes(), 2);
  assert.match(r.stdout(), /initialize\/tools-list passed/);
});

for (const reportedProject of ['<unset>', `${project}-different`]) {
  test(`successful handshake with a different production project fails (${reportedProject})`, async () => {
    const r = runtime(reportedProject);
    await assert.rejects(runWindowsClient(entry, project, undefined, r.options), /configured project through WSLENV/);
    assert.equal(r.closes(), 2);
    assert.equal(r.stdout(), '');
  });
}
