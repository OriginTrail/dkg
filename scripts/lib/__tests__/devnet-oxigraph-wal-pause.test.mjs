// The control flow of devnet-test-oxigraph-wal-pause.sh against two scripted
// nodes: no devnet, no store. The real script runs from a copy of the scripts
// directory whose devnet.sh is a recorder, so "restart the node" is observable
// and nothing outside the fixture is touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = fileURLToPath(new URL('../..', import.meta.url));
const stamp = '[2026-01-01T00:00:00.000Z] [oxigraph]';
const PAUSE = `${stamp} 9.1 MiB retained WAL reached the 8.0 MiB maintenance threshold; pausing new store work until busy stores drain`;
const RESTART = `${stamp} retained WAL reached the 8.0 MiB maintenance threshold after 31s idle; terminating server for supervised recovery`;
const HEALTHY = `${stamp} server restarted and healthy on the node's store port.`;
const REFUSAL = { error: 'Managed Oxigraph is recovering; insert was not started', code: 'STORE_OPERATION_TIMEOUT',
  retryable: true, outcome: 'not_started', backend: 'oxigraph-server', operation: 'insert' };

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
});

// Two servers on consecutive ports: node N answers on base + N - 1.
async function twoNodes(t, handler) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const first = createServer((req, res) => handler(1, req, res));
    const second = createServer((req, res) => handler(2, req, res));
    await listen(first, 0);
    const base = first.address().port;
    try { await listen(second, base + 1); } catch { await new Promise(done => first.close(done)); continue; }
    t.after(() => Promise.all([first, second].map(server => new Promise(done => server.close(done)))));
    return base;
  }
  throw new Error('no two consecutive free ports');
}

/**
 * A fixture devnet: node 1 and node 2 on the managed backend (node 3 on another one, without a server).
 * `behaviour`: pauseAfter (fill writes before the node logs the pause; 0 = never),
 * acceptDuringPause (the node keeps admitting writes after it logged the pause).
 */
async function setup(t, behaviour = {}) {
  const { pauseAfter = 3, acceptDuringPause = false } = behaviour;
  const dir = mkdtempSync(join(tmpdir(), 'dkg-wal-pause-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
  for (const file of ['devnet-test-oxigraph-wal-pause.sh', 'devnet-lib.sh']) cpSync(join(scripts, file), join(dir, 'scripts', file));
  cpSync(join(scripts, 'lib/qa'), join(dir, 'scripts/lib/qa'), { recursive: true });
  // The recorder: which command, on which version layout, and whether the node's configuration held the limit then.
  writeFileSync(join(dir, 'scripts/devnet.sh'), `#!/bin/bash
echo "$1 $2 layout=\${DEVNET_VERSION_LAYOUT:-unset} limit=$(grep -c walRestartThresholdBytes "$DEVNET_DIR/node$2/config.json")" >> "$DEVNET_DIR/devnet-sh.calls"
`, { mode: 0o755 });
  const config = backend => `${JSON.stringify({ name: 'fixture', store: { backend, options: { port: 1 } } }, null, 2)}\n`;
  for (const [node, backend] of [[1, 'oxigraph-server'], [2, 'oxigraph-server'], [3, 'blazegraph']]) {
    mkdirSync(join(dir, `.devnet/node${node}`), { recursive: true });
    writeFileSync(join(dir, `.devnet/node${node}/config.json`), config(backend));
    writeFileSync(join(dir, `.devnet/node${node}/auth.token`), `# fixture\ntoken-${node}\n`);
    writeFileSync(join(dir, `.devnet/node${node}/daemon.log`), 'an older line: maintenance threshold; pausing new store work\n');
  }
  const log = join(dir, '.devnet/node2/daemon.log');
  const state = { fills: 0, retried: 0, value: null, requests: [] };
  const base = await twoNodes(t, (node, req, res) => {
    let input = ''; req.on('data', chunk => input += chunk);
    req.on('end', () => {
      const send = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      state.requests.push(`${node} ${req.method} ${req.url} ${req.headers.authorization}`);
      if (req.url === '/api/status') return send(200, { name: `node${node}` });
      if (req.url === '/api/query') {
        return send(200, { result: { type: 'bindings', bindings: state.value === null ? [] : [{ name: state.value }] } });
      }
      if (req.url === '/api/knowledge-assets' && node === 2) {
        const body = JSON.parse(input);
        if (body.name.includes('-fill-')) {
          state.fills += 1;
          send(201, { created: true, swmShared: true });
          if (state.fills === pauseAfter) appendFileSync(log, `${PAUSE}\n`);
          return undefined;
        }
        state.retried += 1;
        if (state.retried === 1 && !acceptDuringPause) return send(503, REFUSAL);
        if (!acceptDuringPause) appendFileSync(log, `${RESTART}\n${HEALTHY}\n`);
        state.value = body.quads[0].object;
        return send(201, { created: true, swmShared: true });
      }
      return send(404, { error: 'not found' });
    });
  });
  return { dir, base, state, log };
}

function run(fixture, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [join(fixture.dir, 'scripts/devnet-test-oxigraph-wal-pause.sh')], {
      env: { ...process.env, API_PORT_BASE: String(fixture.base), WAL_PAUSE_RESULTS: join(fixture.dir, 'results'),
        DEVNET_DIR: join(fixture.dir, '.devnet'), ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
  });
}
const calls = fixture => readFileSync(join(fixture.dir, '.devnet/devnet-sh.calls'), 'utf8').trim().split('\n');
const original = fixture => `${JSON.stringify({ name: 'fixture', store: { backend: 'oxigraph-server', options: { port: 1 } } }, null, 2)}\n`
  === readFileSync(join(fixture.dir, '.devnet/node2/config.json'), 'utf8');

test('a pause is met: the refused write is repeated until it succeeds, and the node gets its configuration back', async t => {
  const fixture = await setup(t);
  const result = await run(fixture, { DEVNET_VERSION_LAYOUT: 'all:current' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Node 2 is chosen before node 1 (the devnet's relay), and node 1 watches.
  assert.match(result.stdout, /node 2 gets a limit of 8388608 bytes .*; node 1 watches/);
  assert.match(result.stdout, /ok: node 2 paused new store work after 3 writes and \d+s: 9\.1 MiB retained WAL reached the 8\.0 MiB maintenance threshold; pausing/);
  assert.match(result.stdout, /ok: a write during the pause is refused as retryable and not started \(HTTP 503, STORE_OPERATION_TIMEOUT\): Managed Oxigraph is recovering; insert was not started/);
  assert.match(result.stdout, /ok: the same write succeeded when repeated: attempt 2, \d+s after the refusal/);
  assert.match(result.stdout, /ok: node 2 restarted its store for maintenance: retained WAL reached .* terminating server for supervised recovery/);
  assert.match(result.stdout, /ok: node 2 logged its store as restarted and healthy/);
  assert.match(result.stdout, /ok: node 2 serves the write again and node 1 received it/);
  assert.match(result.stdout, /checks passed=6 failed=0/);
  assert.equal(fixture.state.fills, 3); assert.equal(fixture.state.retried, 2);
  // Restarted once with the limit in its configuration and once without it, on the caller's version layout.
  assert.deepEqual(calls(fixture), ['restart-node 2 layout=all:current limit=1', 'restart-node 2 layout=all:current limit=0']);
  assert.ok(original(fixture), 'the configuration is byte-identical to what it was');
  assert.ok(!existsSync(join(fixture.dir, '.devnet/node2/config.json.before-wal-pause')));
  // Each node is asked with its own token, and the reads went to both nodes.
  assert.ok(fixture.state.requests.includes('2 POST /api/knowledge-assets Bearer token-2'));
  assert.ok(fixture.state.requests.includes('1 POST /api/query Bearer token-1'));
  assert.ok(fixture.state.requests.includes('2 POST /api/query Bearer token-2'));
  assert.equal(JSON.parse(readFileSync(join(fixture.dir, 'results/wal-pause.results.json'), 'utf8')).filter(r => r.met).length, 2);
});

test('a line from before the limit was set is not the pause: a node that never pauses fails, and is put back', async t => {
  const fixture = await setup(t, { pauseAfter: 0 });
  const result = await run(fixture, { WAL_PAUSE_WAIT_S: '2' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /FAIL: node 2 did not pause within 2s and \d+ writes/);
  assert.ok(fixture.state.fills > 0); assert.equal(fixture.state.retried, 0);
  assert.deepEqual(calls(fixture).map(line => line.replace(/ layout=\S+/, '')), ['restart-node 2 limit=1', 'restart-node 2 limit=0']);
  assert.ok(original(fixture));
});

test('a node that logs the pause and still admits a write fails the check', async t => {
  const fixture = await setup(t, { pauseAfter: 1, acceptDuringPause: true });
  const result = await run(fixture);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /FAIL: a write sent right after the pause began was accepted/);
  assert.match(result.stderr, /FAIL: node 2 did not log the supervised restart of its store/);
  assert.equal(fixture.state.retried, 1, 'an accepted write is not repeated');
  assert.ok(original(fixture));
});

test('without a node it can act on the script does not run, and changes nothing', async t => {
  const fixture = await setup(t);
  const otherBackend = await run(fixture, { WAL_PAUSE_NODE: '3' });
  assert.equal(otherBackend.status, 3, otherBackend.stdout + otherBackend.stderr);
  assert.match(otherBackend.stdout, /SKIP: node 3 is on the 'blazegraph' backend/);
  const noDevnet = await run(fixture, { DEVNET_DIR: join(fixture.dir, 'missing') });
  assert.equal(noDevnet.status, 3, noDevnet.stdout + noDevnet.stderr);
  const notANumber = await run(fixture, { WAL_PAUSE_BYTES: '8MiB' });
  assert.equal(notANumber.status, 2);
  assert.ok(!existsSync(join(fixture.dir, '.devnet/devnet-sh.calls')), 'no node was restarted');
  assert.ok(original(fixture));
  assert.equal(fixture.state.fills, 0);
});
