/**
 * Blazegraph Docker provisioner — unit tests with full mock injection.
 *
 * Plan: `.cursor/plans/blazegraph_v10_support_178da670.plan.md` §PR 3
 * items 1, 2.
 *
 * Locks in:
 *   - Hard fail when `docker` CLI is missing (no silent Oxigraph
 *     fallback like devnet.sh — operator opted into Docker).
 *   - Idempotent reuse when a running container with the same name
 *     exists (no re-pull, no recreate).
 *   - Stopped container restarted instead of recreated.
 *   - Stopped container that can't restart → recreated cleanly.
 *   - Port-collision auto-bump scans up to the configured range.
 *   - Port range exhaustion throws with a clear message.
 *   - `/bigdata/status` polling times out cleanly.
 *   - Namespace creation failure surfaces an actionable error.
 *   - `managedByDkg: true` always set (signals scoped-DELETE in PR 1
 *     wipe is unnecessary — DROP ALL is safe).
 *   - Namespace XML body contains the V10-required quad mode.
 *
 * No real Docker, no real fetch, no real ports. Everything's
 * injectable; tests run in <50 ms.
 */
import { describe, it, expect } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeAssetPaths } from '../src/runtime-assets.js';
import {
  provisionBlazegraphDocker,
  normaliseBlazegraphNamespace,
  isDockerAvailable,
  BLAZEGRAPH_IMAGE,
  BLAZEGRAPH_CONTAINER_PORT,
  BLAZEGRAPH_DATA_PATH,
  BLAZEGRAPH_LOG_MAX_SIZE,
  BLAZEGRAPH_LOG_MAX_FILE,
  BLAZEGRAPH_NAMESPACE_XML_TEMPLATE,
  type DockerRunner,
  type DockerCommandResult,
} from '../src/daemon/blazegraph-docker.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function runDevnetBlazegraphSmoke(metadata: string): {
  status: number | null;
  stderr: string;
  dockerArgs: string[] | null;
} {
  const root = mkdtempSync(join(tmpdir(), 'dkg-devnet-blazegraph-'));
  const capture = join(root, 'docker-run.args');
  const parserDir = join(root, 'packages', 'cli');
  mkdirSync(parserDir, { recursive: true });
  copyFileSync(
    resolve(REPO_ROOT, 'packages/cli/blazegraph-image-metadata.cjs'),
    join(parserDir, 'blazegraph-image-metadata.cjs'),
  );
  writeFileSync(join(root, 'blazegraph-image.json'), metadata);
  try {
    const result = spawnSync('bash', [
      resolve(REPO_ROOT, 'packages/cli/test/fixtures/devnet-blazegraph-smoke.sh'),
      root,
      capture,
    ], { encoding: 'utf-8' });
    return {
      status: result.status,
      stderr: result.stderr,
      dockerArgs: existsSync(capture)
        ? readFileSync(capture, 'utf-8').trim().split('\n')
        : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface MockDockerScript {
  /**
   * Sequence of responses keyed by argv prefix; map iteration order
   * matters here for cases that ask the same docker subcommand more
   * than once (e.g. inspect → start → inspect).
   */
  matchers: Array<{
    when: (args: readonly string[]) => boolean;
    respond: (args: readonly string[]) => DockerCommandResult;
  }>;
}

function mockDocker(script: MockDockerScript): { runner: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: DockerRunner = {
    async run(args) {
      calls.push([...args]);
      for (const matcher of script.matchers) {
        if (matcher.when(args)) {
          return matcher.respond(args);
        }
      }
      // Default: pretend success so tests that don't care about a
      // particular subcommand stay short.
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  return { runner, calls };
}

function dockerVersionOk(): DockerCommandResult {
  return { stdout: 'Docker version 24.0.6, build ed223bc', stderr: '', exitCode: 0 };
}

function dockerInspectNotFound(): DockerCommandResult {
  return {
    stdout: '',
    stderr: 'Error: No such object: dkg-blazegraph-node',
    exitCode: 1,
  };
}

function dockerInspectRunning(hostPort = 9999): DockerCommandResult {
  return {
    stdout: JSON.stringify([
      {
        State: { Running: true },
        NetworkSettings: {
          Ports: {
            [`${BLAZEGRAPH_CONTAINER_PORT}/tcp`]: [{ HostIp: '0.0.0.0', HostPort: String(hostPort) }],
          },
        },
        Mounts: [{
          Type: 'volume',
          Name: 'dkg-blazegraph-mynode-data',
          Destination: BLAZEGRAPH_DATA_PATH,
        }],
        HostConfig: {
          LogConfig: {
            Type: 'local',
            Config: {
              'max-size': BLAZEGRAPH_LOG_MAX_SIZE,
              'max-file': BLAZEGRAPH_LOG_MAX_FILE,
            },
          },
        },
      },
    ]),
    stderr: '',
    exitCode: 0,
  };
}

function dockerInspectStopped(): DockerCommandResult {
  return {
    stdout: JSON.stringify([
      {
        State: { Running: false },
        NetworkSettings: {
          Ports: {
            [`${BLAZEGRAPH_CONTAINER_PORT}/tcp`]: [{ HostIp: '0.0.0.0', HostPort: '9999' }],
          },
        },
        Mounts: [{
          Type: 'volume',
          Name: 'dkg-blazegraph-mynode-data',
          Destination: BLAZEGRAPH_DATA_PATH,
        }],
        HostConfig: {
          LogConfig: {
            Type: 'local',
            Config: {
              'max-size': BLAZEGRAPH_LOG_MAX_SIZE,
              'max-file': BLAZEGRAPH_LOG_MAX_FILE,
            },
          },
        },
      },
    ]),
    stderr: '',
    exitCode: 0,
  };
}

function mockFetch(handler: (url: string, init?: any) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: typeof globalThis.fetch = (async (input: any, init?: any) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

function valuesForDockerFlag(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) => (
    arg === flag && typeof args[index + 1] === 'string' ? [args[index + 1]] : []
  ));
}

describe('provisionBlazegraphDocker', () => {
  it('throws an actionable error when the docker CLI is missing', async () => {
    const docker: DockerRunner = {
      async run() {
        const err: NodeJS.ErrnoException = new Error('spawn docker ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
    };
    await expect(
      provisionBlazegraphDocker({
        namespace: 'mynode',
        docker,
        log: () => {},
      }),
    ).rejects.toThrow();
  });

  it('throws when `docker --version` returns non-zero (daemon dead)', async () => {
    const { runner } = mockDocker({
      matchers: [
        { when: (a) => a[0] === '--version', respond: () => ({ stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 }) },
      ],
    });
    await expect(
      provisionBlazegraphDocker({
        namespace: 'mynode',
        docker: runner,
        log: () => {},
      }),
    ).rejects.toThrow(/docker --version.*failed|Docker daemon/);
  });

  it('reuses a running container without re-creating it', async () => {
    const { runner, calls } = mockDocker({
      matchers: [
        { when: (a) => a[0] === '--version', respond: dockerVersionOk },
        { when: (a) => a[0] === 'inspect', respond: () => dockerInspectRunning(9999) },
      ],
    });
    const { fn, calls: httpCalls } = mockFetch((url) => {
      if (url.endsWith('/bigdata/status')) return new Response('ok', { status: 200 });
      if (url.includes('/sparql/properties')) return new Response(null, { status: 200 });
      return new Response(null, { status: 200 });
    });
    const result = await provisionBlazegraphDocker({
      namespace: 'mynode',
      docker: runner,
      fetch: fn,
      isPortFree: async () => true,
      log: () => {},
    });
    expect(result.reused).toBe(true);
    expect(result.managedByDkg).toBe(true);
    expect(result.url).toBe('http://127.0.0.1:9999/bigdata/namespace/mynode/sparql');
    expect(calls.some((c) => c[0] === 'run')).toBe(false);
    expect(httpCalls.some((c) => c.url.endsWith('/bigdata/status'))).toBe(true);
  });

  it('warns about legacy storage and logs while reusing its mapped host port', async () => {
    const legacyHostPort = 10001;
    const legacyInspect: DockerCommandResult = {
      stdout: JSON.stringify([{
        State: { Running: true },
        NetworkSettings: {
          Ports: {
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(legacyHostPort) }],
          },
        },
      }]),
      stderr: '',
      exitCode: 0,
    };
    const { runner, calls } = mockDocker({
      matchers: [
        { when: (a) => a[0] === '--version', respond: dockerVersionOk },
        { when: (a) => a[0] === 'inspect', respond: () => legacyInspect },
      ],
    });
    const { fn, calls: httpCalls } = mockFetch(() => new Response('ok', { status: 200 }));
    const logs: string[] = [];

    const result = await provisionBlazegraphDocker({
      namespace: 'mynode',
      docker: runner,
      fetch: fn,
      log: (message) => logs.push(message),
    });

    expect(result.reused).toBe(true);
    expect(result.port).toBe(legacyHostPort);
    expect(result.url).toBe(
      `http://127.0.0.1:${legacyHostPort}/bigdata/namespace/mynode/sparql`,
    );
    expect(httpCalls[0]?.url).toBe(`http://127.0.0.1:${legacyHostPort}/bigdata/status`);
    expect(calls.some((call) => call[0] === 'run')).toBe(false);
    expect(logs.some((message) => (
      message.includes('WARNING: Reused container')
      && message.includes(`no named Docker volume mounted at ${BLAZEGRAPH_DATA_PATH}`)
      && message.includes('will not recreate it automatically')
    ))).toBe(true);
    expect(logs.some((message) => (
      message.includes('WARNING: Reused container')
      && message.includes('does not use the bounded local log policy')
      && message.includes('4 GB rotation budget')
    ))).toBe(true);
  });

  it('creates the namespace when reusing a container with no existing namespace', async () => {
    const { runner } = mockDocker({
      matchers: [
        { when: (a) => a[0] === '--version', respond: dockerVersionOk },
        { when: (a) => a[0] === 'inspect', respond: () => dockerInspectRunning() },
      ],
    });
    const { fn, calls: httpCalls } = mockFetch((url) => {
      if (url.endsWith('/bigdata/status')) return new Response('ok', { status: 200 });
      if (url.includes('/sparql/properties')) return new Response(null, { status: 404 });
      if (url.endsWith('/bigdata/namespace')) return new Response(null, { status: 200 });
      return new Response(null, { status: 200 });
    });
    const result = await provisionBlazegraphDocker({
      namespace: 'mynode',
      docker: runner,
      fetch: fn,
      isPortFree: async () => true,
      log: () => {},
    });
    expect(result.namespaceCreated).toBe(true);
    const createCall = httpCalls.find((c) => c.url.endsWith('/bigdata/namespace'));
    expect(createCall).toBeDefined();
    expect(String(createCall?.init?.body)).toContain('<entry key="com.bigdata.rdf.sail.namespace">mynode</entry>');
    expect(String(createCall?.init?.body)).toContain('quads">true');
  });

  it('starts an existing stopped container instead of recreating', async () => {
    let inspectCount = 0;
    const { runner, calls } = mockDocker({
      matchers: [
        { when: (a) => a[0] === '--version', respond: dockerVersionOk },
        {
          when: (a) => a[0] === 'inspect',
          respond: () => {
            inspectCount += 1;
            // First inspect → stopped. Second inspect (after `start`) → running.
            return inspectCount === 1 ? dockerInspectStopped() : dockerInspectRunning();
          },
        },
        { when: (a) => a[0] === 'start', respond: () => ({ stdout: 'dkg-blazegraph-node', stderr: '', exitCode: 0 }) },
      ],
    });
    const { fn } = mockFetch((url) => {
      if (url.endsWith('/bigdata/status')) return new Response('ok', { status: 200 });
      if (url.includes('/sparql/properties')) return new Response(null, { status: 200 });
      return new Response(null, { status: 200 });
    });
    const result = await provisionBlazegraphDocker({
      namespace: 'mynode',
      docker: runner,
      fetch: fn,
      isPortFree: async () => true,
      log: () => {},
    });
    expect(result.reused).toBe(true);
    expect(calls.some((c) => c[0] === 'start')).toBe(true);
    expect(calls.some((c) => c[0] === 'run')).toBe(false);
  });

  it('recreates the container when `docker start` fails on a stopped container', async () => {
    const { runner, calls } = mockDocker({
      matchers: [
        { when: (a) => a[0] === '--version', respond: dockerVersionOk },
        { when: (a) => a[0] === 'inspect', respond: () => dockerInspectStopped() },
        { when: (a) => a[0] === 'start', respond: () => ({ stdout: '', stderr: 'config drift', exitCode: 1 }) },
        { when: (a) => a[0] === 'rm', respond: () => ({ stdout: '', stderr: '', exitCode: 0 }) },
        { when: (a) => a[0] === 'run', respond: () => ({ stdout: 'container-id', stderr: '', exitCode: 0 }) },
      ],
    });
    const { fn } = mockFetch((url) => {
      if (url.endsWith('/bigdata/status')) return new Response('ok', { status: 200 });
      if (url.endsWith('/bigdata/namespace')) return new Response(null, { status: 200 });
      return new Response(null, { status: 200 });
    });
    const result = await provisionBlazegraphDocker({
      namespace: 'mynode',
      docker: runner,
      fetch: fn,
      isPortFree: async () => true,
      log: () => {},
    });
    expect(result.reused).toBe(false);
    expect(calls.some((c) => c[0] === 'rm')).toBe(true);
    expect(calls.some((c) => c[0] === 'run')).toBe(true);
  });

  it('auto-bumps the port and provisions durable data with bounded local-driver logs', async () => {
    const takenPorts = new Set([9999, 10000]);
    const { runner, calls } = mockDocker({
      matchers: [
        { when: (a) => a[0] === '--version', respond: dockerVersionOk },
        { when: (a) => a[0] === 'inspect', respond: dockerInspectNotFound },
      ],
    });
    const { fn } = mockFetch((url) => {
      if (url.endsWith('/bigdata/status')) return new Response('ok', { status: 200 });
      if (url.endsWith('/bigdata/namespace')) return new Response(null, { status: 200 });
      return new Response(null, { status: 200 });
    });
    const result = await provisionBlazegraphDocker({
      namespace: 'mynode',
      docker: runner,
      fetch: fn,
      isPortFree: async (p) => !takenPorts.has(p),
      log: () => {},
    });
    expect(result.port).toBe(10001);
    const runCall = calls.find((c) => c[0] === 'run');
    expect(BLAZEGRAPH_LOG_MAX_SIZE).toBe('200m');
    expect(BLAZEGRAPH_LOG_MAX_FILE).toBe('20');
    expect(runCall).toBeDefined();
    const runArgs = runCall ?? [];
    expect(valuesForDockerFlag(runArgs, '-p')).toEqual([
      `127.0.0.1:10001:${BLAZEGRAPH_CONTAINER_PORT}`,
    ]);
    expect(valuesForDockerFlag(runArgs, '--mount')).toEqual([
      `type=volume,source=dkg-blazegraph-mynode-data,target=${BLAZEGRAPH_DATA_PATH}`,
    ]);
    expect(valuesForDockerFlag(runArgs, '--log-driver')).toEqual(['local']);
    expect(valuesForDockerFlag(runArgs, '--log-opt')).toEqual([
      `max-size=${BLAZEGRAPH_LOG_MAX_SIZE}`,
      `max-file=${BLAZEGRAPH_LOG_MAX_FILE}`,
    ]);
    expect(runArgs.at(-1)).toBe(BLAZEGRAPH_IMAGE);
    const metadata = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'blazegraph-image.json'), 'utf-8'),
    ) as { image: string; containerPort: number; dataPath: string };
    expect(BLAZEGRAPH_IMAGE).toBe(metadata.image);
    expect(BLAZEGRAPH_CONTAINER_PORT).toBe(metadata.containerPort);
    expect(BLAZEGRAPH_DATA_PATH).toBe(metadata.dataPath);
    expect(runtimeAssetPaths('blazegraph-image.json')[0]).toBe(
      resolve(REPO_ROOT, 'blazegraph-image.json'),
    );
  });

  it('executes the devnet Docker path with the exact shared image and loopback port mapping', () => {
    const image = 'example/blazegraph@sha256:smoke';
    const result = runDevnetBlazegraphSmoke(JSON.stringify({
      image,
      containerPort: 80,
      dataPath: '/data',
    }));

    expect(result.status, result.stderr).toBe(0);
    expect(result.dockerArgs).toEqual([
      'run',
      '-d',
      '--name',
      'devnet-blazegraph-smoke',
      '-p',
      '127.0.0.1:19099:80',
      image,
    ]);
  });

  it('fails closed before docker run when devnet image metadata is invalid', () => {
    const result = runDevnetBlazegraphSmoke(JSON.stringify({ image: 'example/blazegraph' }));

    expect(result.status).toBe(42);
    expect(result.dockerArgs).toBeNull();
  });

  it('throws when every port in the scan range is taken', async () => {
    const { runner } = mockDocker({
      matchers: [
        { when: (a) => a[0] === '--version', respond: dockerVersionOk },
        { when: (a) => a[0] === 'inspect', respond: dockerInspectNotFound },
      ],
    });
    await expect(
      provisionBlazegraphDocker({
        namespace: 'mynode',
        docker: runner,
        fetch: globalThis.fetch,
        isPortFree: async () => false,
        portRange: 3,
        log: () => {},
      }),
    ).rejects.toThrow(/No free port found in the range 9999\.\.10001/);
  });

  it('times out cleanly when /bigdata/status never responds', async () => {
    const { runner } = mockDocker({
      matchers: [
        { when: (a) => a[0] === '--version', respond: dockerVersionOk },
        { when: (a) => a[0] === 'inspect', respond: dockerInspectNotFound },
        { when: (a) => a[0] === 'run', respond: () => ({ stdout: 'id', stderr: '', exitCode: 0 }) },
      ],
    });
    const { fn } = mockFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      provisionBlazegraphDocker({
        namespace: 'mynode',
        docker: runner,
        fetch: fn,
        isPortFree: async () => true,
        pollIntervalMs: 5,
        pollTimeoutMs: 30,
        log: () => {},
      }),
    ).rejects.toThrow(/did not become ready within 30ms/);
  });

  it('surfaces a clear error when namespace POST returns non-2xx', async () => {
    const { runner } = mockDocker({
      matchers: [
        { when: (a) => a[0] === '--version', respond: dockerVersionOk },
        { when: (a) => a[0] === 'inspect', respond: dockerInspectNotFound },
        { when: (a) => a[0] === 'run', respond: () => ({ stdout: 'id', stderr: '', exitCode: 0 }) },
      ],
    });
    const { fn } = mockFetch((url) => {
      if (url.endsWith('/bigdata/status')) return new Response('ok', { status: 200 });
      if (url.endsWith('/bigdata/namespace')) return new Response('namespace exists already', { status: 409 });
      return new Response(null, { status: 200 });
    });
    await expect(
      provisionBlazegraphDocker({
        namespace: 'mynode',
        docker: runner,
        fetch: fn,
        isPortFree: async () => true,
        log: () => {},
      }),
    ).rejects.toThrow(/Failed to create Blazegraph namespace "mynode" — HTTP 409/);
  });

  it('sanitises the container name for tricky namespaces', async () => {
    const { runner, calls } = mockDocker({
      matchers: [
        { when: (a) => a[0] === '--version', respond: dockerVersionOk },
        { when: (a) => a[0] === 'inspect', respond: dockerInspectNotFound },
        { when: (a) => a[0] === 'run', respond: () => ({ stdout: 'id', stderr: '', exitCode: 0 }) },
      ],
    });
    const { fn, calls: httpCalls } = mockFetch((url) => {
      if (url.endsWith('/bigdata/status')) return new Response('ok', { status: 200 });
      if (url.endsWith('/bigdata/namespace')) return new Response(null, { status: 200 });
      return new Response(null, { status: 200 });
    });
    const result = await provisionBlazegraphDocker({
      // Embedded spaces + apostrophes + uppercase and path/query-sensitive
      // characters get slugified down once before Docker, XML, and URL use.
      namespace: "Bob's Node / Main & Co",
      docker: runner,
      fetch: fn,
      isPortFree: async () => true,
      log: () => {},
    });
    const inspectCall = calls.find((c) => c[0] === 'inspect');
    expect(inspectCall?.[1]).toMatch(/^dkg-blazegraph-/);
    expect(inspectCall?.[1]).not.toMatch(/['\s]/);
    expect(result.url).toBe(
      'http://127.0.0.1:9999/bigdata/namespace/bob-s-node-main-co/sparql',
    );
    const createCall = httpCalls.find((c) => c.url.endsWith('/bigdata/namespace'));
    expect(String(createCall?.init?.body)).toContain(
      '<entry key="com.bigdata.rdf.sail.namespace">bob-s-node-main-co</entry>',
    );
  });

  it('normalises operator node names into safe Blazegraph namespace names', () => {
    expect(normaliseBlazegraphNamespace("Bob's Node / Main & Co")).toBe(
      'bob-s-node-main-co',
    );
    expect(normaliseBlazegraphNamespace('dkg.node_01')).toBe('dkg.node_01');
    expect(normaliseBlazegraphNamespace('   ')).toBe('dkg-node');
  });
});

describe('isDockerAvailable', () => {
  it('returns true when docker --version succeeds', async () => {
    const { runner } = mockDocker({
      matchers: [{ when: (a) => a[0] === '--version', respond: dockerVersionOk }],
    });
    await expect(isDockerAvailable(runner)).resolves.toBe(true);
  });

  it('returns false when docker --version fails', async () => {
    const { runner } = mockDocker({
      matchers: [{ when: (a) => a[0] === '--version', respond: () => ({ stdout: '', stderr: '', exitCode: 1 }) }],
    });
    await expect(isDockerAvailable(runner)).resolves.toBe(false);
  });

  it('returns false when the runner throws', async () => {
    const runner: DockerRunner = {
      async run() { throw new Error('ENOENT'); },
    };
    await expect(isDockerAvailable(runner)).resolves.toBe(false);
  });
});

describe('BLAZEGRAPH_NAMESPACE_XML_TEMPLATE', () => {
  it('parameterises the namespace and locks in DKG V10 settings', () => {
    const body = BLAZEGRAPH_NAMESPACE_XML_TEMPLATE.replace('{namespace}', 'mynode');
    expect(body).toContain('<entry key="com.bigdata.rdf.sail.namespace">mynode</entry>');
    // Quads MUST be true for DKG V10 (named-graph scoping). Any
    // change to false would break scoped DELETE wipe.
    expect(body).toContain('com.bigdata.rdf.store.AbstractTripleStore.quads">true');
    expect(body).toContain('truthMaintenance">false');
    expect(body).toContain('statementIdentifiers">false');
    // Blazegraph requires the Java properties DOCTYPE for XML parsing.
    expect(body).toContain('<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">');
    // Quads mode requires inference disabled via NoAxioms.
    expect(body).toContain('axiomsClass">com.bigdata.rdf.axioms.NoAxioms');
  });
});
