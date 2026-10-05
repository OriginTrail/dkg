import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'vitest';
import { provisionBlazegraphDocker, defaultDockerRunner, blazegraphVolumeName, blazegraphMigrationVolumeName, BLAZEGRAPH_JOURNAL_FILE, BLAZEGRAPH_IMAGE, buildBlazegraphRunArgs, waitForBlazegraphReady } from '../src/daemon/blazegraph-docker.js';
import { assertStoreMigrationInactive } from '../src/daemon/store-maintenance-gate.js';
import { executeHardenMigration, planHardenMigration } from '../src/daemon/blazegraph-harden.js';

// test-disable-allow: D1 #2974 -- owner=cli lane=bura-cli expires=2026-10-25 Real Docker journal roundtrip runs explicitly in CLI shard 1.
describe.skipIf(process.env.BLAZEGRAPH_HARDEN_INTEGRATION_TEST !== '1')('real pinned Docker hardening', () => {
it('recovers an actual SIGKILL after replacement creation only after journal verification', async () => {
  const name = `dkg-harden-crash-${process.pid}-${Date.now()}`, namespace = 'crash-owner';
  const root = await mkdtemp(join(tmpdir(), 'harden-real-kill-')), home = join(root, 'config'), migrationDir = join(root, 'export');
  const docker = defaultDockerRunner(), volumes = [blazegraphVolumeName(name), blazegraphMigrationVolumeName(name)];
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const legacyDocker = { run: async (args: string[], options?: Parameters<typeof docker.run>[1]) => {
      if (args[0] === 'run' && args[1] === '-d') {
        const stripped: string[] = [], removed = new Set(['-e', '--health-cmd', '--health-interval', '--health-timeout', '--health-retries', '--health-start-period']);
        for (let i = 0; i < args.length; i++) { if (removed.has(args[i]!)) i++; else stripped.push(args[i]!); }
        args = stripped;
      }
      return docker.run(args, options);
    } };
    const provisioned = await provisionBlazegraphDocker({ namespace, containerName: name, port: 21000 + process.pid % 1000,
      docker: legacyDocker, env: { DKG_BLAZEGRAPH_HEAP_MB: '256' }, pollTimeoutMs: 60000, pollIntervalMs: 500, log: console.log });
    const data = 'INSERT DATA { GRAPH <urn:dkg:store-meta> { <urn:dkg:store-tag> <urn:dkg:storeTaggedFor> "actual-killed-owner" } GRAPH <urn:crash-data> { <urn:s> <urn:p> "retained" } }';
    const inserted = await fetch(provisioned.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `update=${encodeURIComponent(data)}` });
    assert.equal(inserted.ok, true, await inserted.text());
    const options = { containerName: name, namespace, migrationDir, dkgHome: home, env: { DKG_BLAZEGRAPH_HEAP_MB: '256' }, readyTimeoutMs: 60000, readyIntervalMs: 500 };
    child = spawn(process.execPath, ['--import', fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/harden-crash-owner.ts', import.meta.url)), root, 'real', JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostic = ''; child.stderr?.on('data', bytes => { diagnostic += String(bytes); });
    const stopped = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child!.once('error', reject); child!.once('exit', (code, signal) => resolve({ code, signal })); });
    await new Promise<void>((resolve, reject) => {
      child!.once('message', message => { assert.deepEqual(message, { replacementCreated: true, ownerPid: child!.pid }); resolve(); });
      child!.once('exit', () => reject(new Error(`owner exited before creation: ${diagnostic}`)));
    });
    assert.equal(child.kill('SIGKILL'), true, 'The live issued migration must receive SIGKILL');
    assert.deepEqual(await stopped, { code: null, signal: 'SIGKILL' });
    await assert.rejects(assertStoreMigrationInactive(home), /Store hardening marker/);
    const invalidIdentity: typeof globalThis.fetch = (...args) => String(args[1]?.body).includes('SELECT')
      ? Promise.resolve(new Response(JSON.stringify({ results: { bindings: [] } }))) : fetch(...args);
    await assert.rejects(executeHardenMigration({ ...options, log: console.log, recover: true, fetch: invalidIdentity }), /identity-tag/);
    await assert.rejects(assertStoreMigrationInactive(home), /Store hardening marker/);
    const recoveredCalls: string[][] = [];
    const result = await executeHardenMigration({ ...options, log: console.log, recover: true, docker: { run(args, options) {
      recoveredCalls.push([...args]); return docker.run(args, options);
    } } });
    assert.equal(result.outcome, 'recovered');
    assert.ok(recoveredCalls.every(args => ['inspect', 'exec', 'volume'].includes(args[0]!)));
    await assertStoreMigrationInactive(home);
    const response = await fetch(provisioned.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' },
      body: `query=${encodeURIComponent('SELECT ?value WHERE { GRAPH <urn:crash-data> { <urn:s> <urn:p> ?value } }')}` });
    assert.equal((await response.json()).results.bindings[0].value.value, 'retained');
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const container of [name, `${name}-backup`]) await docker.run(['rm', '-f', container]);
    for (const volume of volumes) await docker.run(['volume', 'rm', volume]);
    await rm(root, { recursive: true, force: true });
  }
}, 180000);

it.each(['named-volume', 'writable-layer', 'unbounded-logs', 'relative-directory'] as const)('preserves ordinary RDF records in the replacement and original backup using the pinned image (%s)', async (journalSource) => {
const name = `dkg-harden-test-${process.pid}-${Date.now()}`;
const namespace = 'harden-roundtrip';
const docker = defaultDockerRunner();
const volumes = [blazegraphVolumeName(name), blazegraphMigrationVolumeName(name)];
for (const container of [name, `${name}-backup`]) {
  assert.notEqual((await docker.run(['inspect', container])).exitCode, 0, `Existing smoke container ${container}`);
}
for (const volume of volumes) assert.notEqual((await docker.run(['volume', 'inspect', volume])).exitCode, 0, `Existing smoke volume ${volume}`);
const temporary = await mkdtemp(join(tmpdir(), 'dkg-harden-roundtrip-'));
const migrationDir = journalSource === 'relative-directory' ? `${name}-export` : `${temporary}/journal`;
const seedCommands: string[][] = [];
const migrationDocker = { run: async (args: string[], options?: Parameters<typeof docker.run>[1]) => {
  if (args[0] === 'run' && args.includes('--rm')) seedCommands.push([...args]);
  return docker.run(args, options);
} };
if (journalSource === 'relative-directory') assert.notEqual((await docker.run(['volume', 'inspect', migrationDir])).exitCode, 0);
await mkdir(temporary, { recursive: true });
try {
  const legacyDocker = { run: async (args, options) => {
    if (args[0] === 'run' && args[1] === '-d') {
      const stripped = [];
      const removed = new Set(journalSource === 'unbounded-logs'
        ? ['--log-driver', '--log-opt']
        : ['-e', '--health-cmd', '--health-interval', '--health-timeout', '--health-retries', '--health-start-period',
          ...(journalSource === 'writable-layer' ? ['--mount'] : [])]);
      for (let i=0; i<args.length; i++) { if (removed.has(args[i])) { i++; continue; } stripped.push(args[i]); }
      args = stripped;
    }
    return docker.run(args, options);
  }};
  const provisioned = await provisionBlazegraphDocker({ namespace, containerName: name, port: 19000 + process.pid % 1000,
    docker: legacyDocker, env: { DKG_BLAZEGRAPH_HEAP_MB: '256' }, pollTimeoutMs: 60000,
    pollIntervalMs: 500, log: console.log });
  const insert = `INSERT DATA { GRAPH <urn:dkg:store-meta> { <urn:dkg:store-tag> <urn:dkg:storeTaggedFor> "smoke-2974" } GRAPH <urn:dkg:smoke-2974> { <urn:test:subject> <urn:test:predicate> "preserve-me" } }`;
  const write = await fetch(provisioned.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `update=${encodeURIComponent(insert)}` });
  assert.equal(write.ok, true, await write.text());
  const before = JSON.parse((await docker.run(['inspect', name])).stdout)[0];
  if (journalSource === 'writable-layer') assert.deepEqual(before.Mounts, []);
  else assert.ok(before.Mounts.some(m => m.Name === volumes[0]));
  assert.equal(before.Config.Env.some(e => e.includes('ExitOnOutOfMemoryError')), journalSource === 'unbounded-logs');
  if (journalSource === 'unbounded-logs') {
    assert.equal(before.HostConfig.LogConfig.Type, 'json-file');
    assert.equal(before.HostConfig.LogConfig.Config['max-size'], undefined);
    assert.ok(before.Config.Healthcheck.Test.join(' ').includes('ASK%7B%7D'));
  }
  const result = await executeHardenMigration({ containerName: name, namespace, migrationDir,
    dkgHome: `${temporary}/config`, env: { DKG_BLAZEGRAPH_HEAP_MB: '256' }, docker: migrationDocker,
    readyTimeoutMs: 60000, readyIntervalMs: 500, log: console.log });
  assert.equal(result.outcome, 'hardened');
  assert.equal(result.exportPath, join(resolve(migrationDir), 'bigdata.jnl'));
  assert.ok(seedCommands[0].includes(`${resolve(migrationDir)}:/seed:ro`));
  if (journalSource === 'relative-directory') assert.notEqual((await docker.run(['volume', 'inspect', migrationDir])).exitCode, 0, 'The journal export must be a bind mount, never a named volume');
  const after = JSON.parse((await docker.run(['inspect', name])).stdout)[0];
  assert.ok(after.Mounts.some(m => m.Name === volumes[1]));
  assert.ok(after.Config.Env.some(e => e.includes('-Xmx256m') && e.includes('ExitOnOutOfMemoryError')));
  assert.ok(after.Config.Healthcheck.Test.join(' ').includes('ASK%7B%7D'));
  assert.equal(after.HostConfig.LogConfig.Type, 'local');
  assert.deepEqual(after.HostConfig.LogConfig.Config, { 'max-size': '200m', 'max-file': '20' });
  // Inspect the running JVM rather than merely trusting Docker's saved env.
  const jvms = await docker.run(['exec', '--user', 'tomcat', name, 'jcmd', '-l']);
  assert.equal(jvms.exitCode, 0, jvms.stderr);
  const javaPid = jvms.stdout.match(/^(\d+)\s+org\.apache\.catalina\.startup\.Bootstrap\b/m)?.[1];
  assert.ok(javaPid, jvms.stdout);
  const flags = await docker.run(['exec', '--user', 'tomcat', name, 'jcmd', javaPid, 'VM.flags', '-all']);
  assert.equal(flags.exitCode, 0, flags.stderr);
  assert.match(flags.stdout, /MaxHeapSize\s*=\s*268435456\b/);
  assert.match(flags.stdout, /ExitOnOutOfMemoryError\s*=\s*true\b/);
  const health = after.Config.Healthcheck.Test;
  assert.equal(health[0], 'CMD-SHELL');
  assert.equal(health.length, 2);
  const healthResult = await docker.run(['exec', name, 'sh', '-c', health[1]]);
  assert.equal(healthResult.exitCode, 0, healthResult.stderr);
  assert.match(healthResult.stdout, /(?:"boolean"\s*:\s*true|<boolean>\s*true\s*<\/boolean>)/);
  const backup = JSON.parse((await docker.run(['inspect', `${name}-backup`])).stdout)[0];
  assert.equal(backup.Id, before.Id, 'Backup rename must preserve the captured original Docker identity');
  if (journalSource === 'writable-layer') assert.deepEqual(backup.Mounts, []);
  else assert.ok(backup.Mounts.some(m => m.Name === volumes[0]));
  const response = await fetch(provisioned.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' }, body: `query=${encodeURIComponent('SELECT ?v WHERE { GRAPH <urn:dkg:smoke-2974> { <urn:test:subject> <urn:test:predicate> ?v } }')}` });
  const rows = await response.json();
  assert.equal(rows.results.bindings[0].v.value, 'preserve-me');
  // The retained backup predates a write to the authoritative replacement.
  // A transient primary inspect error must never seed that stale backup over it.
  const newerUpdate = 'INSERT DATA { GRAPH <urn:dkg:new-after-migration> { <urn:new> <urn:value> "newer-primary" } }';
  const newerWrite = await fetch(provisioned.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `update=${encodeURIComponent(newerUpdate)}` });
  assert.equal(newerWrite.ok, true, await newerWrite.text());
  const uncertainCalls: string[][] = [];
  const uncertainDocker = { run: async (args: string[], options?: Parameters<typeof docker.run>[1]) => {
    uncertainCalls.push([...args]);
    if (args[0] === 'inspect' && args[1] === name)
      return { stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 };
    return docker.run(args, options);
  } };
  await assert.rejects(executeHardenMigration({ containerName: name, namespace,
    migrationDir, dkgHome: `${temporary}/config`, docker: uncertainDocker,
    env: { DKG_BLAZEGRAPH_HEAP_MB: '256' }, log: console.log }), /Cannot determine whether primary container/);
  assert.deepEqual(uncertainCalls, [['inspect', name]]);
  // A diagnostic naming another container cannot release verification of this retained backup.
  const backupCalls: string[][] = [];
  const wrongMissingBackup = { run: async (args: string[], options?: Parameters<typeof docker.run>[1]) => {
    backupCalls.push([...args]);
    return args[0] === 'inspect' && args[1] === `${name}-backup`
      ? { stdout: '', stderr: `Error: No such object: ${name}-other`, exitCode: 1 }
      : docker.run(args, options);
  } };
  await assert.rejects(executeHardenMigration({ containerName: name, namespace, migrationDir,
    dkgHome: `${temporary}/config`, docker: wrongMissingBackup, env: { DKG_BLAZEGRAPH_HEAP_MB: '256' }, log: console.log }),
    /Cannot determine whether migration backup/);
  assert.deepEqual(backupCalls, [['inspect', name], ['inspect', `${name}-backup`]]);
  const newerRead = await fetch(provisioned.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' }, body: `query=${encodeURIComponent('SELECT ?v WHERE { GRAPH <urn:dkg:new-after-migration> { <urn:new> <urn:value> ?v } }')}` });
  assert.equal((await newerRead.json()).results.bindings[0].v.value, 'newer-primary');
  assert.equal((await docker.run(['stop', '-t', '120', name])).exitCode, 0);
  assert.equal((await docker.run(['start', `${name}-backup`])).exitCode, 0);
  await waitForBlazegraphReady({ url: `http://127.0.0.1:${provisioned.port}`, fetch, intervalMs: 500, timeoutMs: 60000, log: console.log });
  const preserved = await fetch(provisioned.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' }, body: `query=${encodeURIComponent('SELECT ?v WHERE { GRAPH <urn:dkg:smoke-2974> { <urn:test:subject> <urn:test:predicate> ?v } }')}` });
  assert.equal((await preserved.json()).results.bindings[0].v.value, 'preserve-me');
  // A resumed backup may have accepted writes while the earlier export stayed
  // unchanged. Reuse equal-size RWStore pages to prove size is not freshness.
  const oldSize = (await docker.run(['exec', `${name}-backup`, 'stat', '-c', '%s', BLAZEGRAPH_JOURNAL_FILE])).stdout.trim();
  const replace = 'DELETE DATA { GRAPH <urn:dkg:smoke-2974> { <urn:test:subject> <urn:test:predicate> "preserve-me" } }; INSERT DATA { GRAPH <urn:dkg:smoke-2974> { <urn:test:subject> <urn:test:predicate> "latest-copy" } }';
  const updated = await fetch(provisioned.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `update=${encodeURIComponent(replace)}` });
  assert.equal(updated.ok, true, await updated.text());
  assert.equal((await docker.run(['exec', `${name}-backup`, 'stat', '-c', '%s', BLAZEGRAPH_JOURNAL_FILE])).stdout.trim(), oldSize);
  assert.equal((await docker.run(['rm', name])).exitCode, 0);
  const retainedHash = async () => {
    const result = await docker.run(['run', '--rm', '--entrypoint', '/bin/sh', '-v', `${volumes[1]}:/data:ro`,
      BLAZEGRAPH_IMAGE, '-c', `sha256sum ${BLAZEGRAPH_JOURNAL_FILE}`]);
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout;
  };
  const originalReplacementHash = await retainedHash(), refusedCommands: string[][] = [];
  const refusedDocker = { run: async (args: string[], options?: Parameters<typeof docker.run>[1]) => {
    refusedCommands.push([...args]); return docker.run(args, options);
  } };
  await assert.rejects(executeHardenMigration({ containerName: name, namespace, migrationDir,
    dkgHome: `${temporary}/config`, env: { DKG_BLAZEGRAPH_HEAP_MB: '256' }, docker: refusedDocker,
    readyTimeoutMs: 60000, readyIntervalMs: 500, log: console.log }), /Refusing to reseed.*replacement journal/s);
  assert.ok(refusedCommands.every(args => args[0] === 'inspect' || args[0] === 'volume' && args[1] === 'inspect'));
  assert.equal(await retainedHash(), originalReplacementHash, 'Refusal must not alter the newest retained journal');
  // Reattach the retained replacement volume without seeding it. Its newer
  // acknowledged write must still exist independently of the old backup.
  assert.equal((await docker.run(['stop', '-t', '120', `${name}-backup`])).exitCode, 0);
  assert.equal((await docker.run(buildBlazegraphRunArgs({ containerName: name, hostPort: provisioned.port,
    namespace, heapMb: 256, volumeName: volumes[1] }))).exitCode, 0);
  await waitForBlazegraphReady({ url: `http://127.0.0.1:${provisioned.port}`, fetch, intervalMs: 500, timeoutMs: 60000, log: console.log });
  const retained = await fetch(provisioned.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' },
    body: `query=${encodeURIComponent('SELECT ?v WHERE { GRAPH <urn:dkg:new-after-migration> { <urn:new> <urn:value> ?v } }')}` });
  assert.equal((await retained.json()).results.bindings[0].v.value, 'newer-primary');


} finally {
  for (const container of [name, `${name}-backup`]) await docker.run(['rm', '-f', container]);
  for (const volume of volumes) await docker.run(['volume', 'rm', volume]);
  if (journalSource === 'relative-directory') {
    await docker.run(['volume', 'rm', migrationDir]);
    await rm(resolve(migrationDir), { recursive: true, force: true });
  }
  await rm(temporary, { recursive: true, force: true });
}

}, 240000);

// The same explicit CLI shard also executes the seed publication boundary.
it('seed-time refusal preserves a journal appearing before or during the copy', async () => {
  const name = `dkg-harden-seed-${process.pid}-${Date.now()}`, docker = defaultDockerRunner();
  const volume = blazegraphMigrationVolumeName(name), migrationDir = await mkdtemp(join(tmpdir(), 'dkg-seed-guard-'));
  try {
    await writeFile(join(migrationDir, 'bigdata.jnl'), 'older-export');
    assert.equal((await docker.run(['volume', 'create', volume])).exitCode, 0);
    const args = planHardenMigration({ containerName: name, namespace: 'seed-guard', hostPort: 9999,
      heapMb: 256, migrationDir, state: 'legacy' }).find(step => step.id === 'seed-volume')!.dockerArgs!;
    const shell = args.at(-1)!;
    const run = async (script: string) => docker.run([...args.slice(0, -1), script]);
    assert.equal((await run(`printf newer-journal > ${BLAZEGRAPH_JOURNAL_FILE}`)).exitCode, 0);
    const beforeCopy = await run(shell);
    assert.notEqual(beforeCopy.exitCode, 0, 'An already present journal must refuse seeding');
    assert.match(beforeCopy.stderr, /Refusing to seed an existing replacement journal/);
    assert.equal((await run(`cat ${BLAZEGRAPH_JOURNAL_FILE}`)).stdout, 'newer-journal');
    assert.equal((await run(`rm ${BLAZEGRAPH_JOURNAL_FILE}`)).exitCode, 0);
    const duringCopy = await run(`cp() { command cp "$@" && printf newer-raced-journal > ${BLAZEGRAPH_JOURNAL_FILE}; }; ${shell}`);
    assert.notEqual(duringCopy.exitCode, 0, 'A target appearing during copy must fail exclusive publication');
    assert.equal((await run(`cat ${BLAZEGRAPH_JOURNAL_FILE}`)).stdout, 'newer-raced-journal');
    assert.equal((await run(`rm ${BLAZEGRAPH_JOURNAL_FILE}`)).exitCode, 0);
    const racedDirectory = await run(`cp() { command cp "$@" && mkdir /data/foreign-dir && ln -s /data/foreign-dir ${BLAZEGRAPH_JOURNAL_FILE}; }; ${shell}`);
    assert.notEqual(racedDirectory.exitCode, 0, 'Exclusive publication cannot follow a raced directory symlink');
    assert.equal((await run(`readlink ${BLAZEGRAPH_JOURNAL_FILE}`)).stdout.trim(), '/data/foreign-dir');
    assert.equal((await run('ls -A /data/foreign-dir')).stdout, '');

    assert.equal((await run(`rm ${BLAZEGRAPH_JOURNAL_FILE}; ln -s /data/missing ${BLAZEGRAPH_JOURNAL_FILE}`)).exitCode, 0);
    const danglingTarget = await run(shell);
    assert.notEqual(danglingTarget.exitCode, 0);
    assert.match(danglingTarget.stderr, /Refusing to seed an existing replacement journal/);
    assert.equal((await run(`readlink ${BLAZEGRAPH_JOURNAL_FILE}`)).stdout.trim(), '/data/missing');
    assert.equal((await run(`rm ${BLAZEGRAPH_JOURNAL_FILE}; printf untouched > /data/foreign; ln -s /data/foreign /data/.seed.tmp`)).exitCode, 0);
    const fresh = await run(shell);
    assert.equal(fresh.exitCode, 0, fresh.stderr);
    assert.equal(fresh.stdout.trim(), String('older-export'.length));
    assert.equal((await run(`cat ${BLAZEGRAPH_JOURNAL_FILE}`)).stdout, 'older-export');
    assert.equal((await run('cat /data/foreign')).stdout, 'untouched', 'The copy cannot follow a preexisting temporary symlink');
    assert.equal((await run('readlink /data/.seed.tmp')).stdout.trim(), '/data/foreign');
    assert.equal((await run(`stat -c '%a %u:%g' ${BLAZEGRAPH_JOURNAL_FILE}`)).stdout.trim(), '644 100:1000');
    assert.equal((await run('for f in /data/.seed.*; do basename "$f"; done')).stdout.trim(), '.seed.tmp', 'Only our unique temporary inode is cleaned');

  } finally {
    await docker.run(['volume', 'rm', volume]);
    await rm(migrationDir, { recursive: true, force: true });
  }
}, 60000);

});
