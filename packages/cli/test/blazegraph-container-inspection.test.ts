import { describe, expect, it } from 'vitest';
import { blazegraphNamespaceEndpointParts } from '@origintrail-official/dkg-storage';
import { classifyBlazegraphContainerInspection, inspectBlazegraphContainerFacts, parseBlazegraphContainerInspection } from '../src/daemon/blazegraph-container-inspection.js';
import { parseBlazegraphNamespaceEndpoint } from '../src/daemon/blazegraph-container-policy.js';
import { BLAZEGRAPH_LOG_MAX_SIZE, BLAZEGRAPH_LOG_MAX_FILE } from '../src/daemon/blazegraph-docker.js';
import { inspectHardenState } from '../src/daemon/harden/state.js';
import { ok, uncertainInspectionResults } from './_helpers/blazegraph-harden-fixtures.js';

const name = 'dkg-blazegraph-facts';
const policy = { containerName: name, dataPath: '/data', containerPort: 8080,
  logMaxSize: BLAZEGRAPH_LOG_MAX_SIZE, logMaxFile: BLAZEGRAPH_LOG_MAX_FILE };

describe('canonical Docker inspection outcome', () => {
  it('requires successful, valid found-container evidence independently of stderr', () => {
    const response = { ...ok(JSON.stringify([{ State: { Running: false }, Mounts: [] }])), stderr: `Error: No such object: ${name}` };
    expect(classifyBlazegraphContainerInspection(response, name, policy)).toMatchObject({ kind: 'found', facts: { running: false } });
    expect(classifyBlazegraphContainerInspection({ ...response, exitCode: 1, stderr: 'permission denied' }, name, policy))
      .toEqual({ kind: 'failed', reason: 'command', detail: 'permission denied' });
  });
  it.each(['Error: No such object:', 'Error: No such container:', 'Error response from daemon: No such object:', 'Error response from daemon: No such container:'])('certifies only the exact queried name (%s)', prefix => {
    const response = { stdout: '', stderr: `${prefix} ${name}`, exitCode: 1 };
    expect(classifyBlazegraphContainerInspection(response, name, policy)).toEqual({ kind: 'missing' });
    expect(classifyBlazegraphContainerInspection(response, `${name}-backup`, policy).kind).toBe('failed');
  });
  it.each(uncertainInspectionResults(name))('does not infer absence from %s', async (_, response) => {
    expect(classifyBlazegraphContainerInspection(response, name, policy).kind).toBe('failed');
    const calls: string[][] = [];
    await expect(inspectHardenState({ run: async args => { calls.push([...args]); return response; } }, name)).rejects.toThrow();
    expect(calls).toEqual([['inspect', name]]);
  });
  it.each(['[]', '[null]', '[{}]', '[[]]', '[{"State":{}}]', '[{"State":{"Running":false}},{"State":{"Running":true}}]'])('rejects malformed container output (%s)', stdout => {
    expect(classifyBlazegraphContainerInspection(ok(stdout), name, policy)).toEqual({ kind: 'failed', reason: 'output', detail: 'unparseable container facts' });
  });
  it('reports an empty failed command without interpreting valid-looking stdout', () => {
    expect(classifyBlazegraphContainerInspection({ stdout: '[]', stderr: '', exitCode: 1 }, name, policy))
      .toEqual({ kind: 'failed', reason: 'command', detail: 'Docker inspect failed' });
  });
});

describe('shared Blazegraph inspection facts', () => {
  it.each(['data', 'hardened-data'])('recognizes %s journal volumes for provisioning and migration', async suffix => {
    const info = {
      Mounts: [{ Type: 'volume', Name: `${name}-${suffix}`, Destination: '/data' }],
      Config: { Env: ['TOMCAT_JAVA_OPTS=-Xmx256m -XX:+ExitOnOutOfMemoryError'],
        Healthcheck: { Test: ['CMD-SHELL', 'curl ASK%7B%7D'] } },
      HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: '9999' }] },
        LogConfig: { Type: 'local', Config: { 'max-size': BLAZEGRAPH_LOG_MAX_SIZE, 'max-file': BLAZEGRAPH_LOG_MAX_FILE } } },
      State: { Running: false },
    };
    expect(inspectBlazegraphContainerFacts(info, policy)).toMatchObject({
      journalVolumeName: `${name}-${suffix}`, journalMountIsVolume: true, boundedJvm: true,
      healthProbe: true, boundedLogs: true, hostPort: 9999, running: false,
    });
    const docker = { run: async () => ({ stdout: JSON.stringify([info]), stderr: '', exitCode: 0 }) };
    expect(await inspectHardenState(docker, name)).toEqual({ state: 'hardened', hostPort: 9999, running: false });
    info.Config.Env = ['TOMCAT_JAVA_OPTS=-Xmx0m'];
    expect(inspectBlazegraphContainerFacts(info, policy).boundedJvm).toBe(false);
    expect(await inspectHardenState(docker, name)).toMatchObject({ state: 'legacy',
      ...(suffix === 'hardened-data' ? { usesMigrationVolume: true } : {}) });
  });

  it('rejects foreign and bind mounts and malformed facts without guessing a port', () => {
    for (const info of [null, [], { Mounts: [{ Type: 'bind', Name: `${name}-data`, Destination: '/data' }] },
      { Mounts: [{ Type: 'volume', Name: 'other-data', Destination: '/data' }] }]) {
      expect(inspectBlazegraphContainerFacts(info, policy)).toMatchObject({
        journalVolumeName: undefined, journalMountIsVolume: false, boundedJvm: false,
        healthProbe: false, boundedLogs: false, hostPort: undefined,
      });
    }
  });

  it('normalizes export-integrity facts and mounts without exposing Docker field shapes', () => {
    const mounts = [{ Destination: '/data', Name: `${name}-hardened-data`, Type: 'volume' },
      { Destination: 9, Name: false }, null];
    const facts = inspectBlazegraphContainerFacts({ Mounts: mounts, State: {
      Running: false, StartedAt: '2026-10-04T08:00:00Z', FinishedAt: '2026-10-04T09:00:00Z',
    }, SizeRw: 123 }, policy);
    expect(facts).toMatchObject({ mounts: [
      { destination: '/data', name: `${name}-hardened-data`, type: 'volume' }, {},
    ], startedAt: '2026-10-04T08:00:00Z', finishedAt: '2026-10-04T09:00:00Z', writableLayerSize: 123 });
    expect(inspectBlazegraphContainerFacts({ State: { StartedAt: 3 }, SizeRw: -1 }, policy))
      .toMatchObject({ mounts: [], startedAt: undefined, writableLayerSize: undefined });
  });

  it('refuses invalid inspect roots and preserves explicit rollback mount policy', () => {
    for (const stdout of ['bad json', '[]', '[null]', '[3]', '[[]]', '{}']) {
      expect(parseBlazegraphContainerInspection(stdout, policy)).toBeNull();
    }
    const stdout = JSON.stringify([{ Mounts: [{ Destination: '/data', Name: `${name}-hardened-data`, Type: 'bind' }] }]);
    expect(parseBlazegraphContainerInspection(stdout, policy)?.journalVolumeName).toBeUndefined();
    expect(parseBlazegraphContainerInspection(stdout, { ...policy,
      journalVolumeNames: [`${name}-hardened-data`], journalMountType: 'any',
    })?.journalVolumeName).toBe(`${name}-hardened-data`);
    const original = { Mounts: [{ Destination: '/data', Name: `${name}-data`, Type: 'volume' }] };
    const facts = inspectBlazegraphContainerFacts(original, policy);
    original.Mounts[0]!.Name = 'changed';
    expect(facts.mounts[0]?.name).toBe(`${name}-data`);
  });

  it('expresses published reuse and configured migration port policies over the same parser', () => {
    const info = { HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: '9998' }] } },
      NetworkSettings: { Ports: { '8080/tcp': [{ HostPort: '9999' }] } } };
    expect(inspectBlazegraphContainerFacts(info, policy).hostPort).toBe(9998);
    expect(inspectBlazegraphContainerFacts(info, { ...policy, portSource: 'published' }).hostPort).toBe(9999);
    delete (info.NetworkSettings as { Ports?: unknown }).Ports;
    expect(inspectBlazegraphContainerFacts(info, policy).hostPort).toBe(9998);
    expect(inspectBlazegraphContainerFacts(info, { ...policy, portSource: 'published' }).hostPort).toBeUndefined();
  });
});

describe('storage-owned managed endpoint parser', () => {
  it.each(['http://localhost:9999/bigdata/namespace/my%20name/sparql',
    'https://example.test/proxy/bigdata/namespace/encoded%2Fname/sparql/'])('keeps CLI parts consistent for %s', url => {
    const { namespace, baseUrl, sparqlUrl } = blazegraphNamespaceEndpointParts(url);
    expect(parseBlazegraphNamespaceEndpoint(url)).toEqual({ namespace, baseUrl, sparqlUrl });
  });
  it.each(['http://user:password@localhost:9999/bigdata/namespace/ns/sparql',
    'http://localhost:9999/bigdata/namespace/ns/sparql?query=x',
    'http://localhost:9999/bigdata/namespace/ns/sparql#fragment',
    'http://localhost:9999/bigdata/namespace/%/sparql'])('rejects unsupported endpoint %s in both consumers', url => {
    expect(() => blazegraphNamespaceEndpointParts(url)).toThrow();
    expect(parseBlazegraphNamespaceEndpoint(url)).toBeNull();
  });
});
