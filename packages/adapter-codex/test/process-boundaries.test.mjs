import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRpc } from '../src/rpc.mjs';

const contractBinary = process.env.DKG_CODEX_CONTRACT_BINARY;
const contractVersion = process.env.DKG_CODEX_CONTRACT_VERSION;

function notification(rpc, method, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rpc.off('notification', received);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeout);
    const received = (message) => {
      if (message.method !== method) return;
      clearTimeout(timer);
      rpc.off('notification', received);
      resolve(message);
    };
    rpc.on('notification', received);
  });
}

test('emitted requests and consumed events match the pinned Codex app-server contract', {
  skip: !contractBinary || !contractVersion,
}, async t => {
  const version = spawnSync(contractBinary, ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, new RegExp(`\\b${contractVersion.replaceAll('.', '\\.')}\\b`));

  const dir = mkdtempSync(join(tmpdir(), 'codex-live-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rpc = new CodexRpc({
    binary: contractBinary,
    args: ['app-server'],
    cwd: dir,
    // Never inherit a developer's credentials into the contract test. These
    // calls exercise protocol admission and local rollout persistence only.
    env: { PATH: process.env.PATH, CODEX_HOME: dir, CI: '1', NO_PROXY: '*' },
  });
  t.after(() => rpc.close());

  const initialized = await rpc.start();
  assert.equal(typeof initialized.userAgent, 'string');

  const listed = await rpc.request('thread/list', {
    limit: 40, sortKey: 'updated_at', cursor: null, searchTerm: null,
    archived: false, useStateDbOnly: true,
  });
  assert.ok(Array.isArray(listed.data));

  const threadStarted = notification(rpc, 'thread/started');
  const created = await rpc.request('thread/start', {
    cwd: dir, historyMode: 'legacy', serviceName: 'dkg-node-ui',
  });
  assert.equal(typeof created.thread.id, 'string');
  assert.equal((await threadStarted).params.thread.id, created.thread.id);

  const summary = await rpc.request('thread/read', {
    threadId: created.thread.id, includeTurns: false,
  });
  assert.equal(summary.thread.id, created.thread.id);

  const turnStarted = notification(rpc, 'turn/started');
  const itemStarted = notification(rpc, 'item/started');
  const turn = await rpc.request('turn/start', {
    threadId: created.thread.id,
    clientUserMessageId: 'contract-smoke',
    input: [{ type: 'text', text: 'Protocol contract smoke test.', text_elements: [] }],
  });
  assert.equal(typeof turn.turn.id, 'string');
  assert.equal((await turnStarted).params.turn.id, turn.turn.id);
  assert.equal((await itemStarted).params.threadId, created.thread.id);

  const materialized = await rpc.request('thread/read', {
    threadId: created.thread.id, includeTurns: true,
  });
  assert.equal(materialized.thread.turns[0].id, turn.turn.id);
  assert.equal(materialized.thread.turns[0].items[0].type, 'userMessage');

  const resumed = await rpc.request('thread/resume', { threadId: created.thread.id });
  assert.equal(resumed.thread.id, created.thread.id);
});

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

test('a Codex app-server that refuses initialization is terminated, not orphaned', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-rpc-init-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'pid');
  const fake = join(dir, 'refusing-app-server.mjs');
  // Refuses initialization and STAYS ALIVE, emitting notifications the way an
  // orphan would keep emitting into the next connection.
  writeFileSync(fake, `
    import { createInterface } from 'node:readline';
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.PID_FILE, String(process.pid));
    const lines = createInterface({ input: process.stdin });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        console.log(JSON.stringify({ id: message.id, error: { code: -32000, message: 'initialization refused' } }));
        setInterval(() => console.log(JSON.stringify({ method: 'fake/orphanAlive', params: {} })), 5);
      }
    });
    setInterval(() => {}, 1000);
  `);
  const rpc = new CodexRpc({ binary: process.execPath, args: [fake],
    env: { ...process.env, PID_FILE: pidFile } });
  t.after(() => rpc.close());
  const notifications = [];
  rpc.on('notification', message => notifications.push(message.method));
  const disconnected = once(rpc, 'disconnect');

  await assert.rejects(rpc.start(), /initialization refused/);
  await disconnected;
  assert.equal(rpc.child, null);

  const pid = Number(readFileSync(pidFile, 'utf8'));
  const gone = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      try { process.kill(pid, 0); } catch { return true; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
  };
  assert.equal(await gone(), true, 'the refusing app-server was left running');
  // Nothing the orphan emitted after the failure reached this connection.
  const seen = notifications.length;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(notifications.length, seen);
  assert.ok(!notifications.includes('fake/orphanAlive'));
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
