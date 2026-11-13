import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The D1 runner's gate log watchers (scripts/devnet-read-graphs-run-lib.sh) run in the background while the devnet's
// own scripts stop and restart nodes. Devnet process control stops every process it counts as a node's own.
const LIB = fileURLToPath(new URL('../../devnet-read-graphs-run-lib.sh', import.meta.url));
const PROCESS_CONTROL = fileURLToPath(new URL('../../devnet-node-process-control.mjs', import.meta.url));

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
