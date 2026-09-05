// Hermetic tests for lib/ssh.mjs — no real SSH, no network; injected fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sshExec, mapLimit, parseKvOutput, snapshotCommand, unitFullName } from '../lib/ssh.mjs';

// ── fakes ────────────────────────────────────────────────────────────────────

function fakeProc({ code = 0, stdout = '', stderr = '', neverExit = false, emitError = null } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  queueMicrotask(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    if (emitError) { proc.emit('error', emitError); return; }
    if (!neverExit) proc.emit('close', code, null);
  });
  return proc;
}

function fakeSpawn(script) {
  const calls = [];
  const fn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const spec = script[Math.min(calls.length - 1, script.length - 1)];
    return fakeProc(spec);
  };
  fn.calls = calls;
  return fn;
}

const TARGET = { host: '203.0.113.5', sshUser: 'obs', sshIdentity: '~/.ssh/id_test' };

// ── sshExec ──────────────────────────────────────────────────────────────────

test('sshExec composes the exact ssh argv (with identity)', async () => {
  const spy = fakeSpawn([{ code: 0, stdout: 'hi\n' }]);
  const res = await sshExec(TARGET, 'echo hi', { _spawn: spy, connectTimeoutSec: 8 });
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);
  assert.equal(res.stdout, 'hi\n');
  assert.equal(res.timedOut, false);
  assert.equal(spy.calls[0].cmd, 'ssh');
  assert.deepEqual(spy.calls[0].args, [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=8',
    '-i', '~/.ssh/id_test', '-o', 'IdentitiesOnly=yes',
    'obs@203.0.113.5',
    '--',
    'echo hi',
  ]);
});

test('sshExec omits identity flags when no sshIdentity', async () => {
  const spy = fakeSpawn([{ code: 0 }]);
  await sshExec({ host: 'h1', sshUser: 'u1' }, 'true', { _spawn: spy, connectTimeoutSec: 3 });
  assert.deepEqual(spy.calls[0].args, [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=3',
    'u1@h1',
    '--',
    'true',
  ]);
});

test('sshExec retries once on connect failure (exit 255)', async () => {
  const spy = fakeSpawn([{ code: 255, stderr: 'ssh: connect refused' }, { code: 0, stdout: 'ok\n' }]);
  const res = await sshExec(TARGET, 'echo ok', { _spawn: spy, _retryDelayMs: 0 });
  assert.equal(spy.calls.length, 2);
  assert.equal(res.ok, true);
  assert.equal(res.stdout, 'ok\n');
});

test('sshExec gives up after two 255 attempts', async () => {
  const spy = fakeSpawn([{ code: 255, stderr: 'no route' }]);
  const res = await sshExec(TARGET, 'true', { _spawn: spy, _retryDelayMs: 0 });
  assert.equal(spy.calls.length, 2);
  assert.equal(res.ok, false);
  assert.equal(res.code, 255);
});

test('sshExec does NOT retry a non-255 remote failure', async () => {
  const spy = fakeSpawn([{ code: 1, stderr: 'remote command failed' }]);
  const res = await sshExec(TARGET, 'false', { _spawn: spy, _retryDelayMs: 0 });
  assert.equal(spy.calls.length, 1);
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  assert.equal(res.stderr, 'remote command failed');
});

test('sshExec times out a hung command and reports timedOut', async () => {
  const spy = fakeSpawn([{ neverExit: true, stdout: 'partial' }]);
  const res = await sshExec(TARGET, 'sleep 999', { _spawn: spy, timeoutMs: 25, _retryDelayMs: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.equal(res.code, null);
  assert.equal(res.stdout, 'partial');
});

test('sshExec never rejects on spawn error events', async () => {
  const spy = fakeSpawn([{ emitError: new Error('spawn ssh ENOENT') }]);
  const res = await sshExec(TARGET, 'true', { _spawn: spy, _retryDelayMs: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.code, null);
  assert.match(res.stderr, /ENOENT/);
});

test('sshExec returns a failure result for a malformed target', async () => {
  const spy = fakeSpawn([{ code: 0 }]);
  const res = await sshExec({ host: '' }, 'true', { _spawn: spy });
  assert.equal(res.ok, false);
  assert.equal(spy.calls.length, 0);
});

// ── mapLimit ─────────────────────────────────────────────────────────────────

test('mapLimit preserves order and honors the concurrency cap', async () => {
  let active = 0;
  let maxActive = 0;
  const items = [10, 20, 30, 40, 50];
  const results = await mapLimit(items, 2, async (n) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return n * 2;
  });
  assert.deepEqual(results, [20, 40, 60, 80, 100]);
  assert.ok(maxActive <= 2, `expected concurrency <= 2, saw ${maxActive}`);
  assert.ok(maxActive >= 2, 'expected the pool to actually run in parallel');
});

test('mapLimit never rejects: thrown fn becomes an {ok:false, error} placeholder', async () => {
  const results = await mapLimit([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom-2');
    return n;
  });
  assert.equal(results[0], 1);
  assert.deepEqual(results[1], { ok: false, error: 'boom-2' });
  assert.equal(results[2], 3);
});

test('mapLimit handles empty input', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

// ── parseKvOutput ────────────────────────────────────────────────────────────

test('parseKvOutput parses plain k=v lines and ignores noise', () => {
  const out = parseKvOutput([
    'active_state=active',
    'n_restarts=2',
    'this line has no marker at all',   // ignored: no '='
    '  === weird banner ===',           // ignored: bad key
    'value_with_equals=a=b=c',          // value keeps embedded '='
    'empty_value=',
    'spaced_key name=x',                // ignored: key fails identifier check
  ].join('\n'));
  assert.deepEqual(out, {
    active_state: 'active',
    n_restarts: '2',
    value_with_equals: 'a=b=c',
    empty_value: '',
  });
});

test('parseKvOutput transparently decodes b64: values (paths, spaces)', () => {
  const raw = 'Mon 2026-07-13 09:14:02 UTC';
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  const out = parseKvOutput(`exec_main_start=b64:${b64}\nempty_b64=b64:\nplain=ok`);
  assert.equal(out.exec_main_start, raw);
  assert.equal(out.empty_b64, '');
  assert.equal(out.plain, 'ok');
});

test('parseKvOutput tolerates CRLF and duplicate keys (last wins)', () => {
  const out = parseKvOutput('a=1\r\na=2\r\n');
  assert.deepEqual(out, { a: '2' });
});

// ── snapshotCommand ──────────────────────────────────────────────────────────

const CORE = { systemdUnit: 'dkg-node', listenPort: 9090, storeFilesystem: '/' };

test('snapshotCommand (light) carries every review-mandated probe', () => {
  const cmd = snapshotCommand(CORE, { light: true });
  for (const needle of [
    'systemctl show dkg-node.service --property=ActiveState',
    '--property=SubState',
    '--property=NRestarts',
    '--property=ExecMainStartTimestamp',
    '--property=MainPID',
    '--property=ControlGroup',
    '/system.slice/dkg-node.service',
    'memory.current', 'memory.peak', 'memory.high', 'memory.max',
    'memory.events', 'oom_kill',
    'memory.pressure', 'avg10',
    'ss -H -tln sport = :9090',
    "timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/9090'",
    'probe_ok=1', 'probe_ok=0',
    'df -B1 --output=avail,pcent /',
    'df -P -B1 /',
    'pgrep -P',
    'base64 -w0',
    'snapshot_complete=1',
  ]) {
    assert.ok(cmd.includes(needle), `light command missing: ${needle}`);
  }
  assert.ok(!cmd.includes('journalctl'), 'light must not touch the journal');
  assert.ok(!cmd.includes('du -sb'), 'light must not du the store');
});

test('snapshotCommand (full) adds store size + journal cursor', () => {
  const cmd = snapshotCommand(CORE, { light: false });
  assert.ok(cmd.includes('du -sb'));
  assert.ok(cmd.includes('--property=WorkingDirectory'));
  assert.ok(cmd.includes('journalctl -u dkg-node.service -n 0 --show-cursor --no-pager'));
  assert.ok(cmd.includes('-- cursor: '));
});

test('snapshotCommand never emits remote paths that could leak a username (S6)', () => {
  const cmd = snapshotCommand(CORE, { light: false });
  // The WorkingDirectory heuristic must consume $wd remotely, never echo it.
  assert.ok(!/echo [a-z_]*=\$wd\b/.test(cmd), 'must not emit the store dir path');
  assert.ok(!cmd.includes('echo cwd'), 'must not emit the process cwd');
  assert.ok(!cmd.includes('hostname'), 'must not emit the hostname');
});

test('snapshotCommand is strictly read-only (S2 audit)', () => {
  for (const light of [true, false]) {
    const cmd = snapshotCommand(CORE, { light });
    assert.ok(!/\bsudo\b/.test(cmd), 'no sudo');
    for (const m of cmd.matchAll(/systemctl\s+(\S+)/g)) {
      assert.equal(m[1], 'show', `only 'systemctl show' allowed, saw 'systemctl ${m[1]}'`);
    }
    assert.ok(!/\b(rm|mv|cp|dd|tee|truncate|chmod|chown|mkdir|touch|ln|kill|pkill|reboot|shutdown|systemd-run|sysctl)\b/.test(cmd),
      'no state-changing binaries');
    assert.ok(!cmd.includes('--vacuum'), 'no journal vacuum');
    assert.ok(!cmd.includes('curl'), 'no in-band store queries');
    // Every '>' must belong to a /dev/null redirect or the /dev/tcp probe.
    const stripped = cmd
      .replaceAll('2>/dev/null', '')
      .replaceAll('3<>/dev/tcp/127.0.0.1/9090', '');
    assert.ok(!stripped.includes('>'), `unexpected redirect in: ${cmd}`);
    assert.ok(!stripped.includes('<'), `unexpected input redirect in: ${cmd}`);
  }
});

test('snapshotCommand rejects shell-unsafe fleet values', () => {
  assert.throws(() => snapshotCommand({ ...CORE, systemdUnit: 'dkg;rm -rf' }), TypeError);
  assert.throws(() => snapshotCommand({ ...CORE, systemdUnit: 'dkg node' }), TypeError);
  assert.throws(() => snapshotCommand({ ...CORE, listenPort: 'x' }), TypeError);
  assert.throws(() => snapshotCommand({ ...CORE, listenPort: 0 }), TypeError);
  assert.throws(() => snapshotCommand({ ...CORE, storeFilesystem: '/; rm -rf /' }), TypeError);
  assert.throws(() => snapshotCommand({ ...CORE, storeFilesystem: '$(reboot)' }), TypeError);
});

test('unitFullName normalizes and validates', () => {
  assert.equal(unitFullName('dkg-node'), 'dkg-node.service');
  assert.equal(unitFullName('dkg-node.service'), 'dkg-node.service');
  assert.throws(() => unitFullName('a b'), TypeError);
  assert.throws(() => unitFullName(''), TypeError);
  assert.throws(() => unitFullName("dkg'"), TypeError);
});
