import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The D1 runner's helpers in scripts/devnet-read-graphs-run-lib.sh. Its gate log watchers run in the background while
// the devnet's own scripts stop and restart nodes, and devnet process control stops every process it counts as a
// node's own. Its restart drill uploads bodies larger than one command-line argument may be on Linux.
const LIB = fileURLToPath(new URL('../../devnet-read-graphs-run-lib.sh', import.meta.url));
const DEVNET_LIB = fileURLToPath(new URL('../../devnet-lib.sh', import.meta.url));
const RUNNER = fileURLToPath(new URL('../../devnet-read-graphs-build-run.sh', import.meta.url));
const PROCESS_CONTROL = fileURLToPath(new URL('../../devnet-node-process-control.mjs', import.meta.url));
// The runner's default number of shared-memory triples per knowledge asset in the restart drill.
const DEFAULT_ASSET_TRIPLES = Number(/READ_GRAPHS_DRILL_RESTART_ASSET_TRIPLES:-(\d+)\}/.exec(readFileSync(RUNNER, 'utf8'))?.[1]);
// Linux's limit on one command-line argument (MAX_ARG_STRLEN).
const LINUX_ARGUMENT_BYTES = 128 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(what, check, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// A devnet directory with node1's home and an empty daemon.log, and one watcher's files.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'read-graphs-watcher-'));
  const devnet = join(dir, '.devnet');
  const home = join(devnet, 'node1');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'daemon.log'), '');
  const files = { out: join(dir, 'mismatches.node1'), lost: join(dir, 'lost.node1'), stopped: join(dir, 'watcher.node1.stopped') };
  writeFileSync(files.out, '');
  writeFileSync(files.lost, '');
  return { dir, devnet, home, log: join(home, 'daemon.log'), ...files };
}

// node1's watcher, started as the runner starts it, from a shell whose environment names the node's home (as the
// runner's can: DKG_HOME, a path under it). Returns its PID.
function startWatcher(f) {
  const result = spawnSync('bash', ['-c', `
    set -eu
    source "$1"
    DEVNET_DIR="$2"
    watch_mismatches 1 "$3" "$4" "$(date '+%Y-%m-%d %H:%M:%S')" "$(log_position 1)" "$5"
  `, 'bash', LIB, f.devnet, f.out, f.lost, f.stopped], {
    encoding: 'utf8',
    env: { ...process.env, DKG_HOME: f.home, DKG_NODE_LOG: f.log },
  });
  assert.equal(result.status, 0, result.stderr);
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `no watcher PID: ${result.stdout}`);
  return pid;
}

// The PIDs that `devnet.sh stop-node 1` or `restart-node 1` would signal.
function collected(f) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', PROCESS_CONTROL, 'collect', f.dir, f.devnet, '1'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
}

test("devnet process control does not count a gate log watcher as one of its node's processes", async (t) => {
  const f = fixture();
  // The control: a Node process with the node's daemon.log in its environment, as the watcher once had.
  const control = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, LOG: f.log }, stdio: 'ignore' });
  let watcher;
  t.after(() => {
    for (const pid of [watcher, control.pid]) if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(f.dir, { recursive: true, force: true });
  });
  watcher = startWatcher(f);
  await until('both processes', () => alive(watcher) && alive(control.pid));
  await sleep(300);
  const pids = collected(f);
  assert.ok(pids.includes(control.pid), `collect did not list the control ${control.pid}, so this check proves nothing: ${pids.join(' ')}`);
  assert.ok(!pids.includes(watcher), `collect lists the watcher ${watcher}: a restart of node1 would stop it`);
});

test('a gate log watcher reads mismatch lines across a rotation, outlives SIGHUP and SIGINT, and notes a SIGTERM', async (t) => {
  const f = fixture();
  let watcher;
  t.after(() => {
    if (watcher && alive(watcher)) process.kill(watcher, 'SIGKILL');
    rmSync(f.dir, { recursive: true, force: true });
  });
  watcher = startWatcher(f);
  const line = (n) => `2099-01-01 00:00:0${n} [read-graph-check] Read graph <urn:read-graph:${n}> does not match its member graphs`;
  appendFileSync(f.log, `unrelated line\n${line(1)}\n`);
  await until('the first mismatch line', () => readFileSync(f.out, 'utf8').includes(line(1)));
  // The daemon rotates daemon.log by renaming it: a line written just before the rename, and one in the new file.
  appendFileSync(f.log, `${line(2)}\n`);
  renameSync(f.log, `${f.log}.1`);
  writeFileSync(f.log, `${line(3)}\n`);
  await until('the lines around the rotation', () => {
    const out = readFileSync(f.out, 'utf8');
    return out.includes(line(2)) && out.includes(line(3));
  });
  assert.ok(!readFileSync(f.out, 'utf8').includes('unrelated line'));
  // A run under nohup ignores SIGHUP, and its background jobs SIGINT, but a Node child resets both to their defaults.
  process.kill(watcher, 'SIGHUP');
  process.kill(watcher, 'SIGINT');
  await sleep(500);
  assert.ok(alive(watcher), 'the watcher stopped on SIGHUP or SIGINT');
  process.kill(watcher, 'SIGTERM');
  await until('the watcher to stop', () => !alive(watcher));
  assert.match(readFileSync(f.stopped, 'utf8'), /SIGTERM/);
  watcher = undefined;
});

// A child process the test's own HTTP server can answer while it runs (spawnSync would block the server).
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// A local stand-in for node1's API that keeps every request it receives, whole.
async function fakeNode(t) {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/context-graph/create') { res.writeHead(201); res.end('{"created":true}'); return; }
      if (req.method === 'POST' && req.url === '/api/knowledge-assets') { res.writeHead(200); res.end('{"status":"swm-shared","swmShared":true}'); return; }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const devnet = mkdtempSync(join(tmpdir(), 'read-graphs-upload-'));
  mkdirSync(join(devnet, 'node1'), { recursive: true });
  writeFileSync(join(devnet, 'node1', 'auth.token'), '# devnet node token\ntest-token\n');
  t.after(() => { server.close(); rmSync(devnet, { recursive: true, force: true }); });
  return { received, devnet, port: String(server.address().port) };
}

// The restart drill's upload of two default-size assets to node1, after <setup> (shell code run before it).
function uploadTwoAssets(node, setup = '') {
  return run('bash', ['-c', `
    set -eu
    source "$1"
    source "$2"
    DEVNET_DIR="$3"; API_PORT_BASE="$4"; RESTART_ASSET_TRIPLES="$5"; RESTART_TRIPLES=$(( 2 * $5 ))
    ${setup}
    restart_drill_graph 1 read-graphs-restart-test
  `, 'bash', DEVNET_LIB, LIB, node.devnet, node.port, String(DEFAULT_ASSET_TRIPLES)]);
}

test("the restart drill's default-size assets reach the node whole, through curl", async (t) => {
  assert.ok(DEFAULT_ASSET_TRIPLES > 0, "the runner's default RESTART_ASSET_TRIPLES could not be read");
  const node = await fakeNode(t);
  const result = await uploadTwoAssets(node);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const assets = node.received.filter((request) => request.url === '/api/knowledge-assets');
  assert.equal(assets.length, 2);
  for (const [i, asset] of assets.entries()) {
    assert.equal(asset.auth, 'Bearer test-token');
    const body = JSON.parse(asset.body);
    assert.equal(body.name, `restart-drill-${i + 1}`);
    assert.equal(body.contextGraphId, 'read-graphs-restart-test');
    assert.equal(body.alsoShareSwm, true);
    assert.equal(body.quads.length, DEFAULT_ASSET_TRIPLES);
    assert.equal(new Set(body.quads.map((quad) => quad.object)).size, DEFAULT_ASSET_TRIPLES);
    // More than Linux takes in one command-line argument: as one curl argument, this body would not be sent there.
    assert.ok(Buffer.byteLength(asset.body) > LINUX_ARGUMENT_BYTES, `a default-size body is only ${Buffer.byteLength(asset.body)} bytes`);
  }
});

test('on Linux, a default-size asset body cannot go to curl as one argument', { skip: process.platform !== 'linux' && 'only Linux limits one argument' }, async (t) => {
  const node = await fakeNode(t);
  // The transport before api_file: the body as one argument, as devnet-lib.sh's api passes it.
  const result = await uploadTwoAssets(node, 'api_file() { api "$1" "$2" "$3" "$(cat "$4")"; }');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /asset 1 of 2: HTTP 0+/);
  assert.equal(node.received.filter((request) => request.url === '/api/knowledge-assets').length, 0);
});
