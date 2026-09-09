import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRpc } from '../src/rpc.mjs';

test('Codex RPC subprocess initializes, routes events, rejects on exit, and reconnects', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-rpc-boundary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'fake-app-server.mjs');
  writeFileSync(fake, `
    import { createInterface } from 'node:readline';
    const lines = createInterface({ input: process.stdin });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        console.log(JSON.stringify({ id: message.id, result: { ready: true } }));
        console.log(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } }));
        console.log(JSON.stringify({ id: 77, method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', questions: [] } }));
      } else if (message.method === 'initialized') {
        console.log(JSON.stringify({ method: 'fake/initializedObserved', params: {} }));
      } else if (message.method === 'ping') {
        console.log(JSON.stringify({ id: message.id, result: { pong: true } }));
      }
    });
  `);
  const rpc = new CodexRpc({ binary: process.execPath, args: [fake] });
  t.after(() => rpc.close());
  const notifications = [];
  const requests = [];
  rpc.on('notification', message => notifications.push(message));
  rpc.on('request', message => requests.push(message));
  const notificationReceived = once(rpc, 'notification');
  const requestReceived = once(rpc, 'request');
  const initializedObserved = new Promise(resolve => {
    rpc.on('notification', message => {
      if (message.method === 'fake/initializedObserved') resolve(message);
    });
  });

  assert.deepEqual(await rpc.start(), { ready: true });
  await Promise.all([notificationReceived, requestReceived]);
  await initializedObserved;
  assert.equal(notifications[0].method, 'turn/started');
  assert.equal(requests[0].id, 77);
  assert.deepEqual(await rpc.request('ping'), { pong: true });

  const pending = rpc.request('hang', {}, 5_000);
  const disconnected = once(rpc, 'disconnect');
  rpc.child.kill('SIGTERM');
  await assert.rejects(pending, /Codex disconnected/);
  await disconnected;
  assert.deepEqual(await rpc.start(), { ready: true });
});

test('MCP launcher forwards only canonical DKG credentials and environment', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-boundary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dkgHome = join(dir, 'dkg-home');
  mkdirSync(dkgHome);
  writeFileSync(join(dkgHome, 'auth.token'), '# managed token\n\n node-secret \n');
  const capture = join(dir, 'capture.json');
  const fakeCli = join(dir, 'fake-cli.mjs');
  writeFileSync(fakeCli, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({ args: process.argv.slice(2), env: {
      DKG_HOME: process.env.DKG_HOME, DKG_API: process.env.DKG_API, DKG_TOKEN: process.env.DKG_TOKEN,
      DKG_PROJECT: process.env.DKG_PROJECT, DEVNET_API: process.env.DEVNET_API, DEVNET_TOKEN: process.env.DEVNET_TOKEN,
    } }));
  `);
  const launcher = fileURLToPath(new URL('../src/mcp-launcher.mjs', import.meta.url));
  const child = spawn(process.execPath, [launcher, fakeCli, dkgHome, '9321'], {
    env: { ...process.env, CAPTURE_FILE: capture, DKG_PROJECT: 'leak', DEVNET_API: 'leak', DEVNET_TOKEN: 'leak' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  const result = JSON.parse(readFileSync(capture, 'utf8'));
  assert.deepEqual(result.args, ['mcp', 'serve']);
  assert.deepEqual(result.env, {
    DKG_HOME: dkgHome,
    DKG_API: 'http://127.0.0.1:9321',
    DKG_TOKEN: 'node-secret',
  });
});
