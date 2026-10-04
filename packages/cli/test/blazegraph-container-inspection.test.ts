import { describe, expect, it } from 'vitest';
import { blazegraphNamespaceEndpointParts } from '@origintrail-official/dkg-storage';
import { inspectBlazegraphContainerFacts } from '../src/daemon/blazegraph-container-inspection.js';
import { parseBlazegraphNamespaceEndpoint } from '../src/daemon/blazegraph-container-policy.js';
import { inspectHardenState } from '../src/daemon/harden/state.js';

const name = 'dkg-blazegraph-facts';
const policy = { containerName: name, dataPath: '/data', containerPort: 8080,
  logMaxSize: '100m', logMaxFile: '4' };

describe('shared Blazegraph inspection facts', () => {
  it.each(['data', 'hardened-data'])('recognizes %s journal volumes for provisioning and migration', async suffix => {
    const info = {
      Mounts: [{ Type: 'volume', Name: `${name}-${suffix}`, Destination: '/data' }],
      Config: { Env: ['TOMCAT_JAVA_OPTS=-Xmx256m -XX:+ExitOnOutOfMemoryError'],
        Healthcheck: { Test: ['CMD-SHELL', 'curl ASK%7B%7D'] } },
      HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: '9999' }] },
        LogConfig: { Type: 'local', Config: { 'max-size': '100m', 'max-file': '4' } } },
      State: { Running: false },
    };
    expect(inspectBlazegraphContainerFacts(info, policy)).toEqual({
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
