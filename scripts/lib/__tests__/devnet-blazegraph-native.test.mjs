import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The rule this file pins: `stop` signals a process only when it can prove that
// `start` of this script launched it. A pid on record and a listener on the port
// are not proof; a `stop` that goes by either has killed services that were not
// its own.
const SCRIPT = fileURLToPath(new URL('../../devnet-blazegraph-native.sh', import.meta.url));

// Stands in for the Blazegraph JVM: serves the status page on -Djetty.port and
// records how it was started. It is found on PATH as `java`.
const JAVA_STUB = `#!/usr/bin/env node
const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('-version')) { console.error('java version "stub"'); process.exit(0); }
const port = Number((args.find(a => a.startsWith('-Djetty.port=')) || '=0').split('=')[1]);
writeFileSync(process.env.JAVA_STUB_RECORD, JSON.stringify({ args, cwd: process.cwd(), pid: process.pid }));
createServer((req, res) => { res.statusCode = req.url === '/blazegraph/status' ? 200 : 404; res.end('ok'); }).listen(port, '127.0.0.1');
`;
// A service that is not ours. Its command line looks like a JVM running a JAR.
const SERVICE = `const { createServer } = require('node:http');
const blazegraph = process.argv.includes('--answers-as-blazegraph');
const port = Number(process.argv.find(a => a.startsWith('-Djetty.port=')).split('=')[1]);
createServer((req, res) => { res.statusCode = blazegraph && req.url === '/blazegraph/status' ? 200 : 404; res.end('ok'); })
  .listen(port, '127.0.0.1', () => process.send && process.send('listening'));
`;

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

function checkout(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-bz-native-')));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'caller'));
  cpSync(SCRIPT, join(root, 'scripts/devnet-blazegraph-native.sh'));
  writeFileSync(join(root, 'bin/java'), JAVA_STUB, { mode: 0o755 });
  writeFileSync(join(root, 'service.js'), SERVICE);
  writeFileSync(join(root, 'caller/my.jar'), 'not a real jar');
  const started = [];
  t.after(() => {
    for (const pid of started) if (alive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, '.devnet/blazegraph-native');
  return {
    root, home, started,
    record: join(root, 'java-record.json'),
    run(command, port, env = {}, cwd = root) {
      const result = spawnSync('bash', [join(root, 'scripts/devnet-blazegraph-native.sh'), command], {
        cwd, encoding: 'utf8', timeout: 120_000,
        env: {
          ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, BLAZEGRAPH_PORT: String(port),
          BLAZEGRAPH_NAMESPACES: ' ', BLAZEGRAPH_JAR: '', BLAZEGRAPH_KEEP_JOURNAL: '', JAVA_STUB_RECORD: join(root, 'java-record.json'), ...env,
        },
      });
      return { status: result.status, output: result.stdout + result.stderr };
    },
    // `java -Djetty.port=<port> -jar /opt/service.jar`, as `ps` shows it, listening on the port.
    async service(port, ...flags) {
      const child = spawn(process.execPath, [join(root, 'service.js'), `-Djetty.port=${port}`, '-jar', '/opt/service.jar', ...flags],
        { argv0: 'java', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      started.push(child.pid);
      await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('the service did not start'))); });
      child.disconnect(); child.unref();
      const shown = spawnSync('ps', ['-p', String(child.pid), '-o', 'args='], { encoding: 'utf8' }).stdout;
      assert.match(shown, /java .*-jar \/opt\/service\.jar/, 'the service looks like a JVM running a JAR');
      return child.pid;
    },
  };
}

test('stop leaves another Java service on the port alone, also when its pid is on record', async t => {
  const checkoutDir = checkout(t);
  const port = await freePort();
  const service = await checkoutDir.service(port);

  const first = checkoutDir.run('stop', port);
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /not running/);
  assert.ok(alive(service), 'a listener on the port is not ours because it listens there');

  // A pid file can outlive its JVM, and the pid can be another process by now.
  mkdirSync(checkoutDir.home, { recursive: true });
  writeFileSync(join(checkoutDir.home, 'blazegraph.pid'), `${service}\n`);
  const second = checkoutDir.run('stop', port);
  assert.equal(second.status, 0, second.output);
  assert.doesNotMatch(second.output, /stopped/);
  assert.ok(alive(service), 'a pid on record is not ours because it is on record');
  assert.ok(!existsSync(join(checkoutDir.home, 'blazegraph.pid')));
});

test('a Blazegraph this script did not start is left running, and stop says so', async t => {
  const checkoutDir = checkout(t);
  const port = await freePort();
  const foreign = await checkoutDir.service(port, '--answers-as-blazegraph');
  const { status, output } = checkoutDir.run('stop', port);
  assert.equal(status, 0, output);
  assert.match(output, /not started by this script: a Blazegraph answers on :\d+\/blazegraph and was left running/);
  assert.ok(alive(foreign));
  // start does not take it for its own either.
  const again = checkoutDir.run('start', port);
  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /a Blazegraph this script did not start is serving/);
  assert.ok(!existsSync(checkoutDir.record), 'no second JVM was started');
});

test('start runs a jar given relative to the caller, and stop ends exactly the JVM it started', async t => {
  const checkoutDir = checkout(t);
  const port = await freePort();
  const caller = join(checkoutDir.root, 'caller');

  const started = checkoutDir.run('start', port, { BLAZEGRAPH_JAR: './my.jar' }, caller);
  assert.equal(started.status, 0, started.output);
  const jvm = JSON.parse(readFileSync(checkoutDir.record, 'utf8'));
  checkoutDir.started.push(jvm.pid);
  assert.match(started.output, new RegExp(`ready \\(pid ${jvm.pid}\\)`), 'the recorded pid is the JVM itself');
  // The JVM runs in the journal directory, so the jar it was given must not depend on where the caller stood.
  assert.equal(realpathSync(jvm.cwd), checkoutDir.home);
  const jar = jvm.args[jvm.args.indexOf('-jar') + 1];
  assert.ok(isAbsolute(jar), jar);
  assert.equal(realpathSync(jar), join(caller, 'my.jar'));
  assert.ok(jvm.args.includes(`-Ddkg.devnet.blazegraph.home=${checkoutDir.home}`), jvm.args.join(' '));
  assert.ok(jvm.args.includes('-Djetty.host=127.0.0.1'));

  // Another JVM-looking service runs beside it and has even taken over the pid file.
  const service = await checkoutDir.service(await freePort());
  writeFileSync(join(checkoutDir.home, 'blazegraph.pid'), `${service}\n`);
  const stopped = checkoutDir.run('stop', port);
  assert.equal(stopped.status, 0, stopped.output);
  assert.match(stopped.output, new RegExp(`stopped \\(pid ${jvm.pid}\\)`));
  assert.ok(await gone(jvm.pid), 'the JVM this script started is gone');
  assert.ok(alive(service), 'the other service is still there');

  const again = checkoutDir.run('stop', port);
  assert.match(again.output, /not running/);
  assert.ok(alive(service));
});

test('an absolute jar path is used as given, and a jar that does not exist starts nothing', async t => {
  const checkoutDir = checkout(t);
  const port = await freePort();
  const missing = checkoutDir.run('start', port, { BLAZEGRAPH_JAR: './missing.jar' }, join(checkoutDir.root, 'caller'));
  assert.equal(missing.status, 1, missing.output);
  assert.match(missing.output, /FATAL: BLAZEGRAPH_JAR=.*missing\.jar does not exist/);
  assert.ok(!existsSync(checkoutDir.record));

  const absolute = join(checkoutDir.root, 'caller/my.jar');
  const started = checkoutDir.run('start', port, { BLAZEGRAPH_JAR: absolute });
  assert.equal(started.status, 0, started.output);
  const jvm = JSON.parse(readFileSync(checkoutDir.record, 'utf8'));
  checkoutDir.started.push(jvm.pid);
  assert.equal(jvm.args[jvm.args.indexOf('-jar') + 1], absolute);
  assert.equal(checkoutDir.run('stop', port).status, 0);
  assert.ok(await gone(jvm.pid));
});
