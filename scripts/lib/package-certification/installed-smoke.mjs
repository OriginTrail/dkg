// Runs inside a disposable Linux container containing ONLY prepared packages,
// this builtin-only observer, and its owned installation/data/evidence directories.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { CASES, CLI, PROFILE, digest, hash, readJson, validateTree } from './bundle.mjs';

const [operation, layout, runId, hubAddress] = process.argv.slice(2);
const manifest = readJson('/bundle/manifest.json');
const evidence = '/evidence';
const prefix = '/install/prefix';
const slot = '/install/slot';
const root = layout === 'edge-global' ? `${prefix}/lib` : slot;
const executable = layout === 'edge-global' ? `${prefix}/bin/dkg` : `${slot}/node_modules/.bin/dkg`;
const cliRoot = `${root}/node_modules/${CLI}`;
const reportFile = `${evidence}/${layout}-report.json`;
const report = operation === 'install' ? {
  profile: PROFILE, layout, runId, packageSetDigest: manifest.packageSetDigest,
  runtime: { os: os.platform(), arch: os.arch(), node: process.version },
  cases: CASES.map(id => ({ id, outcome: 'NOT_RUN' })), logs: [],
} : readJson(reportFile);
const env = {
  PATH: process.env.PATH, HOME: '/install/home',
  NPM_CONFIG_USERCONFIG: '/install/npmrc', NPM_CONFIG_GLOBALCONFIG: '/install/global-npmrc',
  NPM_CONFIG_CACHE: '/install/cache',
  DKG_HOME: '/install/data', DKG_NO_BLUE_GREEN: '1', DKG_DISABLE_TELEMETRY: '1',
};
const save = () => fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function capture(command, args, log, timeout = 15 * 60_000) {
  const result = spawnSync(command, args, { cwd: slot, env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  if (log) fs.writeFileSync(`${evidence}/${log}`, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.equal(result.status, 0, `${command} failed: ${result.error?.message ?? result.stderr?.slice(-3000)}`);
  return result.stdout.trim();
}
async function observe(id, fn) {
  const result = report.cases.find(c => c.id === id);
  result.startedAt = new Date().toISOString();
  try { await fn(); result.outcome = 'PASS'; }
  catch (error) { result.outcome = 'FAIL'; result.error = error.message; throw error; }
  finally { result.endedAt = new Date().toISOString(); save(); }
}
function installedTree() {
  // npm writes this for both real global and local installations. Read the
  // integrity attached to the physical installed path, never infer it by version.
  const lock = readJson(`${root}/node_modules/.package-lock.json`);
  const packages = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory)) {
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) { visit(path.join(directory, entry)); continue; }
      const location = path.join(directory, entry);
      assert.ok(!fs.lstatSync(location).isSymbolicLink(), `workspace link in installation: ${location}`);
      if (!fs.existsSync(path.join(location, 'package.json'))) continue;
      const metadata = readJson(path.join(location, 'package.json'));
      const relative = path.relative(root, location);
      const locked = lock.packages[relative];
      assert.ok(locked, `npm integrity record missing: ${relative}`);
      const pkg = { path: relative, name: metadata.name, version: metadata.version, integrity: locked.integrity ?? null, resolved: locked.resolved ?? null, dependencies: metadata.dependencies ?? {} };
      if (metadata.name.startsWith('@origintrail-official/')) {
        const prepared = manifest.packages.find(p => p.name === metadata.name);
        assert.ok(prepared, `unknown internal package: ${metadata.name}`);
        const actual = {};
        for (const file of Object.keys(prepared.files)) {
          const target = path.join(location, file);
          assert.ok(fs.realpathSync(target).startsWith(`${location}/`), `installed file escapes package: ${file}`);
          actual[file] = hash(fs.readFileSync(target));
        }
        pkg.filesDigest = digest(actual);
      }
      packages.push(pkg);
      visit(path.join(location, 'node_modules'));
    }
  };
  visit(`${root}/node_modules`);
  packages.sort((a, b) => a.path.localeCompare(b.path));
  return { layout, packages, permittedNonFamilyDrift: packages.filter(p => !manifest.familyPolicy[p.name] && !p.name.startsWith('@origintrail-official/') && !manifest.lockPackages.includes(`${p.name}@${p.version}`)).map(p => ({ name: p.name, version: p.version, reason: 'profile permits unrelated npm transitive resolution; retained for review' })) };
}

let daemon;
async function stop() {
  if (!daemon) return;
  const child = daemon;
  daemon = undefined;
  if (child.exitCode !== null) throw new Error(`daemon exited before graceful stop: ${child.exitCode}`);
  const ended = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const result = await Promise.race([ended, sleep(30_000).then(() => null)]);
  if (!result) { child.kill('SIGKILL'); await ended; throw new Error('graceful shutdown timed out'); }
  assert.equal(result.code, 0, `daemon did not exit gracefully (${result.signal})`);
}
async function api(route, body) {
  const response = await fetch(`http://127.0.0.1:19200${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  assert.ok(response.ok, `${route} HTTP ${response.status}: ${text.slice(0, 2000)}`);
  return JSON.parse(text);
}
async function start(attempt) {
  const logName = `${layout}-daemon-${attempt}.log`;
  report.logs.push(logName);
  const fd = fs.openSync(`${evidence}/${logName}`, 'w');
  daemon = spawn(executable, ['daemon-worker'], { cwd: slot, env, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  for (let i = 0; i < 120; i++) {
    assert.equal(daemon.exitCode, null, `daemon exited during startup (${daemon.exitCode}); see ${logName}`);
    try {
      const identity = await api('/api/status');
      assert.equal(identity.version, manifest.version);
      for (const key of ['commit', 'buildTime', 'distTag']) assert.equal(identity[key], manifest.buildIdentity[key], `status ${key} mismatch`);
      assert.equal(identity.storeBackend, 'oxigraph-worker');
      return identity;
    } catch (error) {
      if (error.code === 'ERR_ASSERTION' && !error.message.includes('HTTP')) throw error;
    }
    await sleep(500);
  }
  throw new Error('daemon startup timeout');
}
async function readFixture() {
  const response = await api('/api/query', {
    contextGraphId: 'package-certification', view: 'working-memory',
    sparql: 'SELECT ?value WHERE { <urn:package-certification:subject> <urn:package-certification:value> ?value }',
  });
  const bindings = response.bindings ?? response.results?.bindings;
  assert.equal(bindings?.length, 1, `exact RDF row count: ${JSON.stringify(response).slice(0, 1000)}`);
  const value = bindings[0].value?.value ?? bindings[0].value;
  assert.equal(value, 'installed-package-certification');
  return value;
}
try {
  if (operation === 'install') {
    for (const dir of [slot, '/install/home', '/install/data']) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync('/install/npmrc', '');
    fs.writeFileSync('/install/global-npmrc', '');
    fs.writeFileSync(`${slot}/package.json`, '{"name":"package-certificate-slot","version":"1.0.0","private":true}');
    report.runtime.npm = capture('npm', ['--version']);
    await observe('install', () => {
      capture('npm', ['install', ...(layout === 'edge-global' ? ['--global', '--prefix', prefix] : []), `${CLI}@${manifest.version}`, '--registry=http://fixture:4873/registry/', '--foreground-scripts', '--no-audit', '--no-fund'], `${layout}-install.log`);
      assert.ok(fs.existsSync(executable), 'installed dkg executable absent');
    });
    await observe('dependency-policy', () => {
      capture('npm', ['ls', '--all', '--long', '--json', ...(layout === 'edge-global' ? ['--global', '--prefix', prefix] : [])], `${layout}-npm-ls.json`);
      const tree = installedTree();
      fs.writeFileSync(`${evidence}/${layout}-tree.json`, `${JSON.stringify(tree, null, 2)}\n`);
      validateTree(tree, manifest);
    });
  } else {
    assert.equal(operation, 'smoke');
    await observe('cli-identity', () => {
      assert.equal(capture(executable, ['--version'], `${layout}-version.log`), manifest.version);
      assert.deepEqual(readJson(`${cliRoot}/build-info.json`), manifest.buildIdentity);
    });
    await observe('runtime-assets', () => {
      const tree = installedTree(); // Repeat after any deliberate damage.
      validateTree(tree, manifest);
      for (const [name, files] of Object.entries(manifest.requiredAssets)) {
        const pkg = tree.packages.find(p => p.name === name);
        for (const file of files) assert.ok(fs.statSync(path.join(root, pkg.path, file)).size > 0, `missing asset: ${file}`);
      }
    });
    fs.writeFileSync('/install/data/config.json', JSON.stringify({
      name: 'installed-package-certification', networkConfig: 'package-certification-local',
      apiHost: '127.0.0.1', apiPort: 19200, listenPort: 19201, nodeRole: 'edge',
      relay: 'none', bootstrapPeers: [], contextGraphs: [], auth: { enabled: false },
      autoUpdate: { enabled: false },
      chain: { type: 'evm', rpcUrl: 'http://fixture:4873/rpc', hubAddress, chainId: 'evm:31337' },
      // No store override: exercise the production default persistent worker.
    }, null, 2));
    await observe('daemon-status', async () => { report.identity = await start(1); });
    await observe('rdf-readback', async () => {
      await api('/api/context-graph/create', { id: 'package-certification', name: 'Package certification', register: false });
      await api('/api/knowledge-assets', { contextGraphId: 'package-certification', name: 'fixture', quads: [{ subject: 'urn:package-certification:subject', predicate: 'urn:package-certification:value', object: '"installed-package-certification"', graph: '' }] });
      report.rdfValue = await readFixture();
    });
    await observe('graceful-restart', async () => {
      await stop();
      report.restartedIdentity = await start(2);
      report.restartedRdfValue = await readFixture();
      await stop();
    });
  }
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  try { await stop(); } catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  save();
}
