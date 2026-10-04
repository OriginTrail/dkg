import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { provisionBlazegraphDocker, defaultDockerRunner, blazegraphVolumeName, blazegraphMigrationVolumeName, BLAZEGRAPH_JOURNAL_FILE, waitForBlazegraphReady } from '../src/daemon/blazegraph-docker.js';
import { executeHardenMigration } from '../src/daemon/blazegraph-harden.js';

// test-disable-allow: D1 #2974 -- owner=cli lane=bura-cli expires=2026-10-25 Real Docker journal roundtrip runs explicitly in CLI shard 1.
it.skipIf(process.env.BLAZEGRAPH_HARDEN_INTEGRATION_TEST !== '1').each(['named-volume', 'writable-layer', 'unbounded-logs'] as const)('preserves ordinary RDF records in the replacement and original backup using the pinned image (%s)', async (journalSource) => {
const name = `dkg-harden-test-${process.pid}-${Date.now()}`;
const namespace = 'harden-roundtrip';
const docker = defaultDockerRunner();
const volumes = [blazegraphVolumeName(name), blazegraphMigrationVolumeName(name)];
for (const container of [name, `${name}-backup`]) {
  assert.notEqual((await docker.run(['inspect', container])).exitCode, 0, `Existing smoke container ${container}`);
}
for (const volume of volumes) assert.notEqual((await docker.run(['volume', 'inspect', volume])).exitCode, 0, `Existing smoke volume ${volume}`);
const temporary = await mkdtemp(join(tmpdir(), 'dkg-harden-roundtrip-'));
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
  const result = await executeHardenMigration({ containerName: name, namespace, migrationDir: `${temporary}/journal`,
    dkgHome: `${temporary}/config`, env: { DKG_BLAZEGRAPH_HEAP_MB: '256' }, docker,
    readyTimeoutMs: 60000, readyIntervalMs: 500, log: console.log });
  assert.equal(result.outcome, 'hardened');
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
    migrationDir: `${temporary}/journal`, dkgHome: `${temporary}/config`, docker: uncertainDocker,
    env: { DKG_BLAZEGRAPH_HEAP_MB: '256' }, log: console.log }), /Cannot determine whether primary container/);
  assert.deepEqual(uncertainCalls, [['inspect', name]]);
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
  const resumed = await executeHardenMigration({ containerName: name, namespace, migrationDir: `${temporary}/journal`,
    dkgHome: `${temporary}/config`, env: { DKG_BLAZEGRAPH_HEAP_MB: '256' }, docker,
    readyTimeoutMs: 60000, readyIntervalMs: 500, log: console.log });
  assert.equal(resumed.outcome, 'hardened');
  const latest = await fetch(provisioned.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' }, body: `query=${encodeURIComponent('SELECT ?v WHERE { GRAPH <urn:dkg:smoke-2974> { <urn:test:subject> <urn:test:predicate> ?v } }')}` });
  assert.equal((await latest.json()).results.bindings[0].v.value, 'latest-copy');

} finally {
  for (const container of [name, `${name}-backup`]) await docker.run(['rm', '-f', container]);
  for (const volume of volumes) await docker.run(['volume', 'rm', volume]);
  await rm(temporary, { recursive: true, force: true });
}

}, 240000);
