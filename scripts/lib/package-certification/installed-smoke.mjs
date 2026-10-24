// Runs inside a disposable Linux container containing ONLY prepared packages,
// this builtin-only observer, and its owned installation/data/evidence directories.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { CASES, CLI, PROFILE, digest, hash, readJson, validateTree, validateRdfReadback } from './bundle.mjs';

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
  DO_NOT_TRACK: '1', OPENUI_TELEMETRY_DISABLED: '1',
};
const save = () => fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function capture(command, args, log, timeout = 15 * 60_000) {
  const result = spawnSync(command, args, { cwd: slot, env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  if (log) {
    fs.writeFileSync(`${evidence}/${log}`, log.endsWith('.json') ? result.stdout ?? '' : `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    if (log.endsWith('.json') && result.stderr) fs.writeFileSync(`${evidence}/${log}.stderr.log`, result.stderr);
  }
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
async function captureCacheArchives() {
  // npm does not write a lockfile for global installs. Preserve its fresh cache's
  // actual fetched archive identities instead of inventing a global lockfile.
  const npm = fs.realpathSync(capture('which', ['npm']));
  const cache = createRequire(npm)('cacache');
  const directory = '/install/cache/_cacache';
  const entries = Object.values(await cache.ls(directory));
  const cached = new Set(entries.map(e => e.integrity));
  const archives = {};
  for (const entry of entries) {
    if (entry.key.includes('/tarballs/')) {
      const bytes = await cache.get.byDigest(directory, entry.integrity);
      const prepared = manifest.packages.find(p => entry.key.endsWith(`/registry/${p.tarball}`));
      assert.ok(prepared, 'unexpected candidate archive request');
      const integrity = `sha512-${hash(bytes, 'sha512', 'base64')}`;
      assert.equal(integrity, prepared.integrity, 'candidate cache archive differs');
      archives[`${prepared.name}@${prepared.version}`] = { integrity, resolved: entry.key.replace('make-fetch-happen:request-cache:', '') };
      continue;
    }
    if (entry.key.includes('.tgz')) continue;
    const bytes = await cache.get.byDigest(directory, entry.integrity);
    if (bytes[0] !== 123) continue;
    let metadata;
    try { metadata = JSON.parse(bytes); } catch { continue; }
    if (!metadata.name || metadata.name.startsWith('@origintrail-official/')) continue;
    for (const version of Object.values(metadata.versions ?? {})) {
      if (version.dist?.integrity && cached.has(version.dist.integrity)) archives[`${metadata.name}@${version.version}`] = { integrity: version.dist.integrity, resolved: version.dist.tarball };
    }
  }
  fs.writeFileSync(`${evidence}/${layout}-archives.json`, JSON.stringify(archives, null, 2));
}
function installedTree() {
  const lockPath = `${root}/node_modules/.package-lock.json`;
  const lock = fs.existsSync(lockPath) ? readJson(lockPath) : { packages: {} };
  const archives = readJson(`${evidence}/${layout}-archives.json`);
  const packages = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    assert.ok(!fs.lstatSync(directory).isSymbolicLink(), `linked node_modules directory: ${directory}`);
    for (const entry of fs.readdirSync(directory)) {
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) { visit(path.join(directory, entry)); continue; }
      const location = path.join(directory, entry);
      assert.ok(!fs.lstatSync(location).isSymbolicLink(), `workspace link in installation: ${location}`);
      if (!fs.existsSync(path.join(location, 'package.json'))) continue;
      const metadata = readJson(path.join(location, 'package.json'));
      const relative = path.relative(root, location);
      const locked = lock.packages[relative] ?? archives[`${metadata.name}@${metadata.version}`] ?? {};
      if (metadata.name.startsWith('@origintrail-official/')) {
        assert.ok(archives[`${metadata.name}@${metadata.version}`], `candidate archive not fetched: ${metadata.name}`);
      }
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
  let timer;
  const result = await Promise.race([ended, new Promise(resolve => { timer = setTimeout(() => resolve(null), 30_000); })]);
  clearTimeout(timer);
  if (!result) { child.kill('SIGKILL'); await ended; throw new Error('graceful shutdown timed out'); }
  assert.equal(result.code, 0, `daemon did not exit gracefully (${result.signal})`);
}
async function api(route, body, timeout = 30_000) {
  const response = await fetch(`http://127.0.0.1:19200${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
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
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assert.equal(daemon.exitCode, null, `daemon exited during startup (${daemon.exitCode}); see ${logName}`);
    try {
      const identity = await api('/api/status', undefined, 1000);
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
async function readFixture(field) {
  const response = await api('/api/query', {
    contextGraphId: 'package-certification', view: 'working-memory',
    sparql: 'SELECT ?value WHERE { <urn:package-certification:subject> <urn:package-certification:value> ?value }',
  });
  report[field] = response;
  return validateRdfReadback(response);
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
    await observe('dependency-policy', async () => {
      capture('npm', ['ls', '--all', '--long', '--json', ...(layout === 'edge-global' ? ['--global', '--prefix', prefix] : [])], `${layout}-npm-ls.json`);
      await captureCacheArchives();
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
      // Use the shipped genesis overlay, as the existing Hardhat fixtures do,
      // with every network endpoint explicitly replaced or disabled below.
      name: 'installed-package-certification', networkConfig: 'testnet',
      apiHost: '127.0.0.1', apiPort: 19200, listenPort: 19201, nodeRole: 'edge',
      relay: 'none', bootstrapPeers: [], contextGraphs: [], auth: { enabled: false },
      autoUpdate: { enabled: false },
      chain: { type: 'evm', rpcUrl: 'http://fixture:4873/rpc', rpcUrls: [], walletRpcUrls: ['http://fixture:4873/rpc'], hubAddress, chainId: 'evm:31337' },
      // No store override: exercise the production default persistent worker.
    }, null, 2));
    await observe('daemon-status', async () => { report.identity = await start(1); });
    await observe('rdf-readback', async () => {
      await api('/api/context-graph/create', { id: 'package-certification', name: 'Package certification', register: false });
      await api('/api/knowledge-assets', { contextGraphId: 'package-certification', name: 'fixture', finalize: false, quads: [{ subject: 'urn:package-certification:subject', predicate: 'urn:package-certification:value', object: '"installed-package-certification"', graph: '' }] });
      report.rdfValue = await readFixture('rdfResponse');
    });
    await observe('graceful-restart', async () => {
      await stop();
      report.restartedIdentity = await start(2);
      report.restartedRdfValue = await readFixture('restartedRdfResponse');
      await stop();
    });
  }
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  try { await stop(); } catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  // daemon-worker writes its structured runtime log beneath DKG_HOME. Retain
  // this log separately from the private disposable wallet/store directory.
  if (fs.existsSync('/install/data/daemon.log')) {
    const logName = `${layout}-daemon-runtime.log`;
    fs.copyFileSync('/install/data/daemon.log', `${evidence}/${logName}`);
    report.logs.push(logName);
  }
  save();
}
