import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CASES, LAYOUTS, PROFILE, SCHEMA, digest, readJson, verifyBundle, verifyReceipt } from './bundle.mjs';
import { run } from '../release-process.mjs';
import { requireCleanSource } from './source.mjs';
import { startRegistry } from './registry.mjs';
import { recordAttempt } from './attempt.mjs';
import { ownProcess } from '../../testing/owned-process.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
async function execute(command, args, { cwd, log, signal, timeout = 20 * 60_000 } = {}) {
  signal?.throwIfAborted();
  const fd = fs.openSync(log, 'a');
  const child = spawn(command, args, { cwd, signal, killSignal: 'SIGKILL', env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  await ownProcess(child, { label: `${command}; see ${path.basename(log)}` }).waitForExit(timeout);
}
async function startChain(rootDir, output, signal) {
  signal.throwIfAborted();
  const contextFile = path.join(output, 'chain-context.json');
  const fd = fs.openSync(path.join(output, 'chain.log'), 'w');
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(scripts, 'chain-fixture.mjs'), contextFile], {
    cwd: rootDir, detached: true, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  const killGroup = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const owner = ownProcess(child, { label: 'Hardhat fixture; see chain.log', graceMs: 30_000, kill: killGroup });
  const stop = async () => {
    try { await owner.stop(); }
    finally { killGroup('SIGKILL'); } // Reap descendants even if the controller already closed.
  };
  try {
    const context = await owner.ready(() => fs.existsSync(contextFile) ? readJson(contextFile) : undefined,
      { timeoutMs: 300_000, intervalMs: 500, signal });
    return { ...context, stop };
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
  const cleanupDocker = args => execute('docker', args, { log: path.join(output, 'controller.log'), timeout: 30_000 });
  return recordAttempt({ output, receipt, work: async signal => {
    const docker = (args, log = 'controller.log') => execute('docker', args, { log: path.join(output, log), signal });
    const started = Date.now();
    chain = await startChain(rootDir, output, signal);
    receipt.timings.chain = Date.now() - started;
    registry = await startRegistry({ bundle, manifest, rpcUrl: chain.rpcUrl, log: path.join(output, 'registry.jsonl') });
    // Register ownership before dispatch: cancellation can kill the Docker
    // client after the daemon has already created the named resource.
    networks.add(egress); await docker(['network', 'create', egress]);
    networks.add(isolated); await docker(['network', 'create', '--internal', isolated]);
    // A tiny, restricted control-plane gateway. The product has no source mounts;
    // at runtime its only network is internal and this gateway exposes only the
    // owned chain. The registry handler is disabled outside installation.
    containers.add(gateway);
    await docker(['create', '--name', gateway, '--network', egress, '--network-alias', 'fixture', ...(process.platform === 'linux' ? ['--add-host=host.docker.internal:host-gateway'] : []), image, 'node', '/fixture-gateway.mjs', String(registry.port)]);
    await docker(['cp', path.join(scripts, 'fixture-gateway.mjs'), `${gateway}:/fixture-gateway.mjs`]);
    await docker(['start', gateway]);
    await docker(['network', 'connect', '--alias', 'fixture', isolated, gateway]);
    receipt.containerImage = JSON.parse(run('docker', ['image', 'inspect', image]))[0].Id;
    for (const layout of LAYOUTS) {
      signal.throwIfAborted();
      const container = `${owner}-${layout}`;
      const installStart = Date.now();
      try {
        registry.setInstalling(true);
        containers.add(container);
        await docker(['run', '-d', '--name', container, '--network', egress, '--mount', `type=bind,src=${bundle},dst=/bundle,readonly`, '--mount', `type=bind,src=${output},dst=/evidence`, image, 'node', '-e', 'setInterval(()=>{},100000)']);
        await docker(['exec', container, 'mkdir', '-p', '/harness/lib/package-certification', '/harness/testing']);
        for (const file of ['installed-smoke.mjs', 'bundle.mjs', 'npm-cache.mjs']) await docker(['cp', path.join(scripts, file), `${container}:/harness/lib/package-certification/${file}`]);
        await docker(['cp', path.join(scripts, '../../testing/owned-process.mjs'), `${container}:/harness/testing/owned-process.mjs`]);
        await docker(['exec', container, 'node', '/harness/lib/package-certification/installed-smoke.mjs', 'install', layout, runId, chain.hubAddress], `${layout}-observer.log`);
        receipt.timings[`${layout}-install`] = Date.now() - installStart;
        registry.setInstalling(false);
        await docker(['network', 'disconnect', egress, container]);
        await docker(['network', 'connect', isolated, container]);
        const inspection = JSON.parse(run('docker', ['inspect', container]))[0];
        assert.deepEqual(Object.keys(inspection.NetworkSettings.Networks), [isolated]);
        fs.writeFileSync(path.join(output, `${layout}-isolation.json`), JSON.stringify({ networks: ['internal-only'], mounts: inspection.Mounts.map(m => ({ destination: m.Destination, readOnly: !m.RW })) }, null, 2));
        const smokeStart = Date.now();
        await docker(['exec', container, 'node', '/harness/lib/package-certification/installed-smoke.mjs', 'smoke', layout, runId, chain.hubAddress, ...(negativeControl ? [negativeControl] : [])], `${layout}-observer.log`);
        receipt.timings[`${layout}-smoke`] = Date.now() - smokeStart;
      } catch (error) { receipt.errors.push({ layout, message: error.message }); }
      finally {
        if (containers.has(container)) {
          await cleanupDocker(['cp', `${container}:/install/data`, path.join(output, `${layout}-data`)]).catch(() => {});
          await cleanupDocker(['rm', '-f', container]).then(() => containers.delete(container)).catch(error => receipt.errors.push({ phase: 'cleanup', message: error.message }));
        }
        const treeFile = path.join(output, `${layout}-tree.json`);
        receipt.layouts.push({ layout, report: `${layout}-report.json`, tree: `${layout}-tree.json`, installLog: `${layout}-install.log`, ...(fs.existsSync(treeFile) ? { treeDigest: digest(readJson(treeFile)) } : {}) });
      }
    }
  }, cleanup: async safely => {
    for (const container of containers) await safely('cleanup', () => cleanupDocker(['rm', '-f', container]));
    for (const network of networks) await safely('cleanup', () => cleanupDocker(['network', 'rm', network]));
    await safely('cleanup', () => registry?.close());
    await safely('cleanup', () => chain?.stop());
  }, verify: prospectiveReceipt => {
    assert.equal(requireCleanSource(rootDir), expected.commit, 'controller source changed during certification');
    verifyReceipt(bundle, prospectiveReceipt, output, expected);
  } });
}
