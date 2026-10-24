import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CASES, LAYOUTS, PROFILE, SCHEMA, digest, fileIdentity, readJson, verifyBundle, verifyCertificate } from './bundle.mjs';
import { run, requireCleanSource } from './prepare.mjs';
import { startRegistry } from './registry.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function execute(command, args, { cwd, log, timeout = 20 * 60_000 } = {}) {
  const fd = fs.openSync(log, 'a');
  const child = spawn(command, args, { cwd, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, `${command} failed (${code}); see ${path.basename(log)}`);
  } finally { clearTimeout(timer); }
}
async function startChain(rootDir, output) {
  const contextFile = path.join(output, 'chain-context.json');
  const fd = fs.openSync(path.join(output, 'chain.log'), 'w');
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(scripts, 'chain-fixture.mjs'), contextFile], {
    cwd: rootDir, detached: true, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  const exited = new Promise(resolve => child.once('exit', resolve));
  const stop = async () => {
    if (child.exitCode !== null) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
    const timeout = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }, 30_000);
    await exited;
    clearTimeout(timeout);
  };
  try {
    for (let i = 0; i < 600; i++) {
      if (fs.existsSync(contextFile)) return { ...readJson(contextFile), stop };
      assert.equal(child.exitCode, null, 'Hardhat fixture exited; see chain.log');
      await sleep(500);
    }
    throw new Error('Hardhat fixture startup timed out');
  } catch (error) { await stop(); throw error; }
}
export async function certifyInstall({ rootDir, bundle, output, expected, image = 'node:22.23.4-bookworm-slim', negativeControl }) {
  const manifest = verifyBundle(bundle, expected);
  assert.equal(requireCleanSource(rootDir), expected.commit, 'controller checkout is not intended candidate');
  assert.ok(!negativeControl || negativeControl === 'missing-ui', 'unknown negative control');
  fs.mkdirSync(output);
  const runId = randomUUID();
  const owner = `dkg-cert-${runId}`;
  const egress = `${owner}-install`;
  const isolated = `${owner}-runtime`;
  const gateway = `${owner}-fixture`;
  const receipt = {
    schemaVersion: SCHEMA, runId, profile: PROFILE, requiredCases: CASES,
    packageSetDigest: manifest.packageSetDigest, commit: expected.commit,
    toolRevision: run('git', ['rev-parse', 'HEAD'], { cwd: rootDir }),
    startedAt: new Date().toISOString(), outcome: 'INCOMPLETE', layouts: [], evidence: [],
    ci: process.env.GITHUB_RUN_ID ? { workflow: process.env.GITHUB_WORKFLOW, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT } : null,
    ...(negativeControl ? { negativeControl } : {}),
    timings: {}, errors: [],
  };
  let chain, registry;
  const containers = new Set();
  const networks = new Set();
  const docker = (args, log = 'controller.log') => execute('docker', args, { log: path.join(output, log) });
  try {
    const started = Date.now();
    chain = await startChain(rootDir, output);
    receipt.timings.chain = Date.now() - started;
    registry = await startRegistry({ bundle, manifest, rpcUrl: chain.rpcUrl, log: path.join(output, 'registry.jsonl') });
    await docker(['network', 'create', egress]); networks.add(egress);
    await docker(['network', 'create', '--internal', isolated]); networks.add(isolated);
    // A tiny, restricted control-plane gateway. The product has no source mounts;
    // at runtime its only network is internal and this gateway exposes only the
    // owned chain. The registry handler is disabled outside installation.
    const proxy = `const http=require('http');http.createServer((q,s)=>{const r=http.request({host:'host.docker.internal',port:${registry.port},path:q.url,method:q.method,headers:q.headers},p=>{s.writeHead(p.statusCode,p.headers);p.pipe(s)});r.on('error',()=>{s.writeHead(502);s.end()});q.pipe(r)}).listen(4873,'0.0.0.0')`;
    await docker(['run', '-d', '--name', gateway, '--network', egress, '--network-alias', 'fixture', '--add-host=host.docker.internal:host-gateway', image, 'node', '-e', proxy]); containers.add(gateway);
    await docker(['network', 'connect', '--alias', 'fixture', isolated, gateway]);
    receipt.containerImage = JSON.parse(run('docker', ['image', 'inspect', image]))[0].Id;
    for (const layout of LAYOUTS) {
      const container = `${owner}-${layout}`;
      const installStart = Date.now();
      try {
        registry.setInstalling(true);
        await docker(['run', '-d', '--name', container, '--network', egress, '--mount', `type=bind,src=${bundle},dst=/bundle,readonly`, '--mount', `type=bind,src=${output},dst=/evidence`, image, 'node', '-e', 'setInterval(()=>{},100000)']); containers.add(container);
        await docker(['exec', container, 'mkdir', '-p', '/harness']);
        for (const file of ['installed-smoke.mjs', 'bundle.mjs']) await docker(['cp', path.join(scripts, file), `${container}:/harness/${file}`]);
        await docker(['exec', container, 'node', '/harness/installed-smoke.mjs', 'install', layout, runId, chain.hubAddress], `${layout}-observer.log`);
        receipt.timings[`${layout}-install`] = Date.now() - installStart;
        registry.setInstalling(false);
        await docker(['network', 'disconnect', egress, container]);
        await docker(['network', 'connect', isolated, container]);
        const inspection = JSON.parse(run('docker', ['inspect', container]))[0];
        assert.deepEqual(Object.keys(inspection.NetworkSettings.Networks), [isolated]);
        fs.writeFileSync(path.join(output, `${layout}-isolation.json`), JSON.stringify({ networks: ['internal-only'], mounts: inspection.Mounts.map(m => ({ destination: m.Destination, readOnly: !m.RW })) }, null, 2));
        if (negativeControl) {
          const base = layout === 'edge-global' ? '/install/prefix/lib' : '/install/slot';
          // Deliberate damage AFTER successful npm installation. This exercises
          // the actual installed boundary, not just a synthetic verifier fixture.
          const tree = readJson(path.join(output, `${layout}-tree.json`));
          const ui = tree.packages.find(pkg => pkg.name === '@origintrail-official/dkg-node-ui');
          await docker(['exec', container, 'rm', `${base}/${ui.path}/dist-ui/index.html`]);
        }
        const smokeStart = Date.now();
        await docker(['exec', container, 'node', '/harness/installed-smoke.mjs', 'smoke', layout, runId, chain.hubAddress], `${layout}-observer.log`);
        receipt.timings[`${layout}-smoke`] = Date.now() - smokeStart;
      } catch (error) { receipt.errors.push({ layout, message: error.message }); }
      finally {
        if (containers.has(container)) {
          await docker(['cp', `${container}:/install/data`, path.join(output, `${layout}-data`)]).catch(() => {});
          await docker(['rm', '-f', container]); containers.delete(container);
        }
        const treeFile = path.join(output, `${layout}-tree.json`);
        receipt.layouts.push({ layout, report: `${layout}-report.json`, tree: `${layout}-tree.json`, installLog: `${layout}-install.log`, ...(fs.existsSync(treeFile) ? { treeDigest: digest(readJson(treeFile)) } : {}) });
      }
    }
  } catch (error) { receipt.errors.push({ phase: 'controller', message: error.message }); }
  finally {
    for (const container of containers) await docker(['rm', '-f', container]).catch(error => receipt.errors.push({ phase: 'cleanup', message: error.message }));
    for (const network of networks) await docker(['network', 'rm', network]).catch(error => receipt.errors.push({ phase: 'cleanup', message: error.message }));
    await registry?.close();
    await chain?.stop();
    receipt.endedAt = new Date().toISOString();
    // Data directories are retained for local diagnosis, but contain disposable
    // wallet keys and are NOT part of portable evidence or CI upload globs.
    receipt.evidence = fs.readdirSync(output).filter(name => fs.statSync(path.join(output, name)).isFile()).sort().map(name => ({ path: name, sha256: fileIdentity(path.join(output, name)).sha256 }));
    receipt.outcome = receipt.errors.length ? (receipt.layouts.some(l => fs.existsSync(path.join(output, l.report)) && readJson(path.join(output, l.report)).cases.some(c => c.outcome === 'FAIL')) ? 'FAIL' : 'INCOMPLETE') : 'PASS';
    const receiptFile = path.join(output, 'receipt.json');
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    if (receipt.outcome === 'PASS') {
      try {
        assert.equal(requireCleanSource(rootDir), expected.commit, 'controller source changed during certification');
        verifyCertificate(bundle, receiptFile, expected);
      }
      catch (error) {
        receipt.outcome = 'INCOMPLETE'; receipt.errors.push({ phase: 'verification', message: error.message });
        fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
      }
    }
  }
  if (receipt.outcome !== 'PASS') throw new Error(`Package certification ${receipt.outcome}; retained ${path.join(output, 'receipt.json')}`);
  return receipt;
}
