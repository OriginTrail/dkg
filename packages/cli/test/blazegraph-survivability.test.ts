import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBlazegraphHeapMb, defaultDockerRunner, buildBlazegraphRunArgs, blazegraphHealthCmd, blazegraphVolumeName, deriveBlazegraphContainerName, parseBlazegraphNamespaceEndpoint, fetchWithDeadline, waitForBlazegraphReady, BLAZEGRAPH_IMAGE, BLAZEGRAPH_CONTAINER_PORT, BLAZEGRAPH_DATA_DIR } from '../src/daemon/blazegraph-docker.js';
describe('computeBlazegraphHeapMb', () => {
  const GiB = 2 ** 30;

  it('returns 40% of host RAM on a mid-size host (7.5 GiB → 3072 MB)', () => {
    expect(computeBlazegraphHeapMb(7.5 * GiB)).toBe(3072);
  });

  it('clamps up to the 2 GiB floor on small hosts (4 GiB → 2048 MB)', () => {
    expect(computeBlazegraphHeapMb(4 * GiB)).toBe(2048);
  });

  it('clamps down to the 8 GiB cap on large hosts (32 GiB → 8192 MB)', () => {
    expect(computeBlazegraphHeapMb(32 * GiB)).toBe(8192);
  });

  it('honours the DKG_BLAZEGRAPH_HEAP_MB override verbatim (unclamped)', () => {
    expect(computeBlazegraphHeapMb(7.5 * GiB, '6000')).toBe(6000);
    // The operator override deliberately escapes the clamp.
    expect(computeBlazegraphHeapMb(7.5 * GiB, '12000')).toBe(12000);
  });

  it('falls back to the computed value on a garbage override', () => {
    expect(computeBlazegraphHeapMb(7.5 * GiB, 'lots')).toBe(3072);
    expect(computeBlazegraphHeapMb(7.5 * GiB, '-4')).toBe(3072);
    expect(computeBlazegraphHeapMb(7.5 * GiB, '')).toBe(3072);
    expect(computeBlazegraphHeapMb(7.5 * GiB, '3.5')).toBe(3072);
  });

  it('accepts ONLY plain decimal digits — 0x/exponent/zero forms fall back (MINOR-12)', () => {
    // Number('0x10') === 16 and Number('6e3') === 6000 — both must be
    // rejected: an operator typo must never silently become a 16 MB heap.
    expect(computeBlazegraphHeapMb(7.5 * GiB, '0x10')).toBe(3072);
    expect(computeBlazegraphHeapMb(7.5 * GiB, '6e3')).toBe(3072);
    expect(computeBlazegraphHeapMb(7.5 * GiB, '1e2')).toBe(3072);
    expect(computeBlazegraphHeapMb(7.5 * GiB, '0')).toBe(3072);
    expect(computeBlazegraphHeapMb(7.5 * GiB, '+4096')).toBe(3072);
    expect(computeBlazegraphHeapMb(7.5 * GiB, ' 4096 ')).toBe(4096); // trimmed decimal is fine
  });
});

describe('defaultDockerRunner (real spawn against a fake docker on PATH)', () => {
  let fakeBinDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    fakeBinDir = mkdtempSync(join(tmpdir(), 'dkg-fake-docker-'));
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  function installFakeDocker(script: string): void {
    const path = join(fakeBinDir, 'docker');
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    // Prepend (not replace) so the fake shadows any real docker while the
    // script's own tools (sleep, echo) still resolve from /bin.
    process.env.PATH = `${fakeBinDir}:${savedPath ?? ''}`;
  }

  it('treats the timeout SIGKILL as FAILURE (exitCode -1), never `exitCode ?? 0` fake success (MAJOR-5)', async () => {
    // `exec` so SIGKILL lands on the sleeping process itself and the stdio
    // pipes close immediately (no 5s orphan holding the close event).
    installFakeDocker('exec sleep 5');
    const res = await defaultDockerRunner().run(['ps'], { timeoutMs: 150 });
    expect(res.exitCode).toBe(-1);
    expect(res.stderr).toMatch(/signal SIGKILL/);
    expect(res.stderr).toMatch(/150ms timeout/);
  });

  it('reports an externally signal-killed child as failure too', async () => {
    // Script kills itself with SIGTERM: close(null, 'SIGTERM') with no
    // timeout involved — still must not resolve as success.
    installFakeDocker('kill -TERM $$; sleep 5');
    const res = await defaultDockerRunner().run(['ps']);
    expect(res.exitCode).toBe(-1);
    expect(res.stderr).toMatch(/signal SIGTERM/);
  });

  it('passes real exits (0 and non-zero) through unchanged', async () => {
    installFakeDocker('echo out; echo err >&2; exit 3');
    const res = await defaultDockerRunner().run(['ps']);
    expect(res).toEqual({ stdout: 'out\n', stderr: 'err\n', exitCode: 3 });

    installFakeDocker('echo fine');
    const okRes = await defaultDockerRunner().run(['ps'], { timeoutMs: 5000 });
    expect(okRes.exitCode).toBe(0);
    expect(okRes.stdout).toBe('fine\n');
    expect(okRes.stderr).toBe('');
  });

  it('rejects with the friendly message when docker is not on PATH', async () => {
    process.env.PATH = fakeBinDir; // empty dir — no docker binary
    await expect(defaultDockerRunner().run(['--version']))
      .rejects.toThrow(/docker CLI not found on PATH/);
  });
});

describe('buildBlazegraphRunArgs', () => {
  const args = buildBlazegraphRunArgs({
    containerName: 'dkg-blazegraph-dkg',
    hostPort: 9999,
    namespace: 'dkg',
    heapMb: 3072,
  });

  it('produces the full hardened golden argv', () => {
    expect(args).toEqual([
      'run',
      '-d',
      '--restart', 'unless-stopped',
      '--name', 'dkg-blazegraph-dkg',
      '-p', `127.0.0.1:9999:${BLAZEGRAPH_CONTAINER_PORT}`,
      '-e', 'TOMCAT_JAVA_OPTS=-Xmx3072m -XX:+ExitOnOutOfMemoryError',
      '--mount', `type=volume,source=dkg-blazegraph-dkg-data,target=${BLAZEGRAPH_DATA_DIR}`,
      '--log-driver', 'local',
      '--log-opt', 'max-size=200m',
      '--log-opt', 'max-file=20',
      '--health-cmd', blazegraphHealthCmd('dkg'),
      '--health-interval', '30s',
      '--health-timeout', '10s',
      '--health-retries', '3',
      '--health-start-period', '120s',
      BLAZEGRAPH_IMAGE,
    ]);
  });

  it('carries the JVM memory policy through the verified TOMCAT_JAVA_OPTS hook', () => {
    const env = args[args.indexOf('-e') + 1];
    expect(env).toContain('-Xmx3072m');
    // OOME → JVM exit → `--restart unless-stopped` auto-heals, instead of
    // the alive-but-deaf JVM the fleet wedged on.
    expect(env).toContain('-XX:+ExitOnOutOfMemoryError');
  });

  it('health-cmd is a bounded empty-pattern ASK against the namespace', () => {
    const healthCmd = args[args.indexOf('--health-cmd') + 1];
    expect(healthCmd).toContain('ASK%7B%7D');
    expect(healthCmd).toContain('/bigdata/namespace/dkg/sparql');
    expect(healthCmd).toContain('-m 8');
  });

  it('binds only the loopback interface and honours an image override', () => {
    expect(args).toContain(`127.0.0.1:9999:${BLAZEGRAPH_CONTAINER_PORT}`);
    const custom = buildBlazegraphRunArgs({
      containerName: 'c', hostPort: 1, namespace: 'n', heapMb: 2048, image: 'x/y:z',
    });
    expect(custom.at(-1)).toBe('x/y:z');
  });
});

describe('blazegraphVolumeName', () => {
  it('derives the journal volume from the container name', () => {
    expect(blazegraphVolumeName('dkg-blazegraph-dkg')).toBe('dkg-blazegraph-dkg-data');
  });
});

describe('deriveBlazegraphContainerName', () => {
  it('derives from the fleet-shaped store URL (namespace, NOT node name)', () => {
    expect(deriveBlazegraphContainerName({
      managedByDkg: true,
      url: 'http://127.0.0.1:9999/bigdata/namespace/dkg/sparql',
    })).toBe('dkg-blazegraph-dkg');
  });

  it('prefers a persisted options.containerName over URL parsing', () => {
    expect(deriveBlazegraphContainerName({
      containerName: 'my-custom-container',
      url: 'http://127.0.0.1:9999/bigdata/namespace/dkg/sparql',
    })).toBe('my-custom-container');
  });

  it('returns null for missing or non-namespace URLs', () => {
    expect(deriveBlazegraphContainerName(undefined)).toBeNull();
    expect(deriveBlazegraphContainerName({})).toBeNull();
    expect(deriveBlazegraphContainerName({ url: 42 })).toBeNull();
    expect(deriveBlazegraphContainerName({ url: 'http://127.0.0.1:9999/sparql' })).toBeNull();
    expect(deriveBlazegraphContainerName({ url: 'not a url' })).toBeNull();
  });

  it('sanitises a namespace with URL-encoded characters', () => {
    expect(deriveBlazegraphContainerName({
      url: 'http://127.0.0.1:9999/bigdata/namespace/My%20Node/sparql',
    })).toBe('dkg-blazegraph-my-node');
  });
});

describe('parseBlazegraphNamespaceEndpoint (the ONE managed-endpoint parser)', () => {
  it('parses namespace, base URL and canonical SPARQL URL from a fleet-shaped URL', () => {
    expect(parseBlazegraphNamespaceEndpoint('http://127.0.0.1:9999/bigdata/namespace/dkg/sparql'))
      .toEqual({
        namespace: 'dkg',
        baseUrl: 'http://127.0.0.1:9999',
        sparqlUrl: 'http://127.0.0.1:9999/bigdata/namespace/dkg/sparql',
      });
  });

  it('decodes an encoded namespace and re-encodes it canonically', () => {
    expect(parseBlazegraphNamespaceEndpoint('http://h:1/bigdata/namespace/My%20Node/sparql'))
      .toEqual({
        namespace: 'My Node',
        baseUrl: 'http://h:1',
        sparqlUrl: 'http://h:1/bigdata/namespace/My%20Node/sparql',
      });
  });

  it('rejects non-strings and non-namespace URLs', () => {
    expect(parseBlazegraphNamespaceEndpoint(undefined)).toBeNull();
    expect(parseBlazegraphNamespaceEndpoint(42)).toBeNull();
    expect(parseBlazegraphNamespaceEndpoint('http://h:1/sparql')).toBeNull();
    expect(parseBlazegraphNamespaceEndpoint('not a url')).toBeNull();
  });
});

describe('bounded store probes (post-rename hang fix)', () => {
  it('fetchWithDeadline rejects after the deadline even when the fetch IGNORES its abort signal', async () => {
    const neverSettles: typeof globalThis.fetch =
      (async () => new Promise<never>(() => {})) as typeof globalThis.fetch;
    const started = Date.now();
    await expect(fetchWithDeadline(neverSettles, 'http://x/probe', {}, 20))
      .rejects.toThrow(/timed out after 20ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('waitForBlazegraphReady times out (instead of hanging) when every status fetch never settles', async () => {
    const neverSettles: typeof globalThis.fetch =
      (async () => new Promise<never>(() => {})) as typeof globalThis.fetch;
    await expect(waitForBlazegraphReady({
      url: 'http://127.0.0.1:1',
      fetch: neverSettles,
      intervalMs: 1,
      timeoutMs: 60,
      probeTimeoutMs: 10,
      log: () => {},
    })).rejects.toThrow(/did not become ready within 60ms/);
  });

  it('waitForBlazegraphReady still succeeds through a slow-but-settling probe', async () => {
    const slowOk: typeof globalThis.fetch = (async () => {
      await new Promise((res) => setTimeout(res, 5));
      return new Response('ok', { status: 200 });
    }) as typeof globalThis.fetch;
    await expect(waitForBlazegraphReady({
      url: 'http://127.0.0.1:1',
      fetch: slowOk,
      intervalMs: 1,
      timeoutMs: 5_000,
      probeTimeoutMs: 1_000,
      log: () => {},
    })).resolves.toBeUndefined();
  });
});
