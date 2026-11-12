import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TemporaryEdges } from '../member-sharing/temporary-edges.mjs';

const PRELOAD = fileURLToPath(new URL('../member-sharing/worker-exit-trace.cjs', import.meta.url));
// The supervisor as cli-supervisor.ts starts its worker: spawn by a named import, every stream ignored.
const SUPERVISOR = `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [process.argv[2], 'daemon-worker'], { stdio: ['ignore', 'ignore', 'ignore'], env: process.env });
child.once('exit', code => { process.exitCode = code === null ? 70 : code; });
`;

function folders(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg exit trace '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'node7');
  mkdirSync(home);
  return { dir, home };
}

/** A supervised worker running `workerCode` under the preload. Returns the trace, the worker's stderr, and the supervisor's exit code. */
function supervised(t, workerCode, { home: given, supervisorCode = SUPERVISOR } = {}) {
  const { dir, home } = folders(t);
  const folder = given ?? home;
  writeFileSync(join(dir, 'supervisor.mjs'), supervisorCode);
  writeFileSync(join(dir, 'worker.mjs'), workerCode);
  const run = spawnSync(process.execPath, [join(dir, 'supervisor.mjs'), join(dir, 'worker.mjs'), 'daemon-supervisor'], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, DKG_HOME: folder, NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}` },
  });
  const read = name => { try { return readFileSync(join(folder, name), 'utf8'); } catch { return ''; } };
  return {
    status: run.status,
    output: run.stdout + run.stderr,
    trace: read('worker-exits.jsonl').split('\n').filter(Boolean).map(line => JSON.parse(line)),
    stderr: read('worker-stderr.log'),
  };
}
const workerExits = trace => trace.filter(entry => entry.event === 'worker-exit');
const fromWorker = trace => trace.filter(entry => entry.role === 'daemon-worker');

test('a worker killed by a signal: its supervisor records the signal, and the worker itself says nothing', t => {
  const { trace, status } = supervised(t, "process.kill(process.pid, 'SIGKILL'); setTimeout(() => {}, 10_000);");
  assert.equal(status, 70);
  const [end] = workerExits(trace);
  assert.equal(end.code, null);
  assert.equal(end.signal, 'SIGKILL');
  assert.deepEqual(fromWorker(trace), []);
});

test('a worker that calls exit: its supervisor records the code, and the worker the stack that called it', t => {
  const { trace, status } = supervised(t, 'function leavesTheDaemon() { process.exit(3); } leavesTheDaemon();');
  assert.equal(status, 3);
  assert.equal(workerExits(trace)[0].code, 3);
  assert.equal(workerExits(trace)[0].signal, null);
  const [exit] = fromWorker(trace);
  assert.equal(exit.event, 'exit');
  assert.equal(exit.code, 3);
  assert.match(exit.stack, /leavesTheDaemon/);
});

test('an exception nothing caught is recorded by the worker, with what it wrote to stderr', t => {
  const { trace, stderr } = supervised(t, "throw new Error('nobody caught this');");
  assert.equal(workerExits(trace)[0].code, 1);
  assert.match(fromWorker(trace).find(entry => entry.event === 'uncaught').stack, /nobody caught this/);
  assert.match(stderr, /nobody caught this/);
});

test('what a worker writes to its stderr outside JavaScript is kept, though its supervisor asked for it to be ignored', t => {
  const { stderr } = supervised(t, "import { writeSync } from 'node:fs'; writeSync(2, 'FATAL ERROR: as V8 writes it\\n');");
  assert.equal(stderr, 'FATAL ERROR: as V8 writes it\n');
});

test('only the worker is traced: its threads say nothing, and another child of the supervisor is left as it was started', t => {
  const threads = supervised(t, `
    import { Worker } from 'node:worker_threads';
    await new Promise(resolve => new Worker('1', { eval: true }).once('exit', resolve));
  `);
  assert.deepEqual(threads.trace.map(entry => entry.event), ['exit', 'worker-exit', 'supervisor-exit']);
  const other = supervised(t, '', {
    supervisorCode: `
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', 'console.log("from another child")'], { stdio: ['ignore', 'inherit', 'ignore'], env: process.env });
      child.once('exit', code => { process.exitCode = code; });
    `,
  });
  assert.match(other.output, /from another child/);
  assert.deepEqual(workerExits(other.trace), []);
  assert.equal(other.stderr, '');
});

test('a trace that cannot be written changes nothing: the worker runs and ends as it would have', t => {
  const { dir } = folders(t);
  const { status, output, trace } = supervised(t, 'process.exit(3);', { home: join(dir, 'no-such-folder') });
  assert.equal(status, 3);
  assert.equal(output, '');
  assert.deepEqual(trace, []);
});

test('a process that is neither supervisor nor worker writes nothing', t => {
  const { home } = folders(t);
  const run = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
    env: { ...process.env, DKG_HOME: home, NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}` },
  });
  assert.equal(run.status, 0);
  assert.ok(!existsSync(join(home, 'worker-exits.jsonl')));
});

test('every temporary node preloads the trace, keeping what the caller set, and node reads that setting as it stands', async t => {
  const { dir, home } = folders(t);
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--no-deprecation';
  t.after(() => { if (saved === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved; });
  const devnetDir = join(dir, 'devnet');
  const edges = new TemporaryEdges({ dir: devnetDir, nodeDir: node => join(devnetDir, `node${typeof node === 'object' ? node.number : node}`), listening: () => false, nodePorts: () => [] }, { stamp: 'S', log: { say() {}, note() {} } });
  edges.allocate({ relay1: 'r1', relay2: 'r2' });
  for (const node of [edges.owner, edges.member1, edges.member2, edges.feeder]) {
    assert.equal(node.env.NODE_OPTIONS, `--no-deprecation --require ${JSON.stringify(PRELOAD)}`);
  }
  // Member 2's own settings are still there.
  assert.equal(edges.member2.env.DKG_SYNC_GLOBAL_MAX_INFLIGHT, '1');
  // A path with a space, as a node would be given it (the folders of this test have one).
  const copy = join(dir, 'worker exit trace.cjs');
  writeFileSync(copy, readFileSync(PRELOAD));
  const run = spawnSync(process.execPath, ['-e', 'process.exit(5)', 'daemon-worker'], {
    env: { ...process.env, DKG_HOME: home, NODE_OPTIONS: `--no-deprecation --require ${JSON.stringify(copy)}` },
  });
  assert.equal(run.status, 5);
  assert.match(readFileSync(join(home, 'worker-exits.jsonl'), 'utf8'), /"event":"exit","code":5/);
});
