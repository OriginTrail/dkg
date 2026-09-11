// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  createRemoteCanaryDryRunArtifactV1,
  runRemoteCanaryArtifactLifecycleV1,
} from './certify.mjs';
import {
  CG,
  SOURCE_SECRET,
  RECEIVER_URL,
  SOURCE_URL,
  baseConfig,
  statusBody,
} from './test-support.mjs';

const execFileAsync = promisify(execFile);
const RUNNER_PATH = fileURLToPath(new URL('./run.mjs', import.meta.url));
const AGENT_DIRECTORY = fileURLToPath(new URL('../..', import.meta.url));

test('dry-run validates without reading secrets, calling nodes, or running commands', () => {
  const artifact = createRemoteCanaryDryRunArtifactV1(baseConfig(), () => (
    new Date('2026-09-11T01:00:00.000Z')
  ));
  assert.equal(artifact.status, 'DRY_RUN');
  assert.equal(artifact.plan.offlineCatchup, 'PLANNED');
  assert.equal(artifact.plan.vmParityEvidence, 'PLANNED');
  assert.equal(artifact.plan.catalogSwmEvidence, 'PLANNED');
  assert.equal(artifact.plan.rpcUsage, 'PLANNED');
  const serialized = JSON.stringify(artifact);
  for (const sensitive of [SOURCE_URL, RECEIVER_URL, CG, '/run/secrets', 'alpha-source', 'beta-receiver']) {
    assert.equal(serialized.includes(sensitive), false);
  }
});

test('operator CLI dry-run performs no network, secret, evidence, or command I/O', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rfc64-remote-canary-cli-dry-run-'));
  const artifactPath = join(directory, 'result.json');
  const configPath = join(directory, 'config.json');
  const sensitive = [
    'https://unreachable-source.invalid',
    'https://unreachable-receiver.invalid',
    '/definitely/missing/source-secret',
    '/definitely/missing/receiver-secret',
    '/definitely/missing/rpc-evidence.json',
    'must-never-run-lifecycle-command',
  ];
  const config = baseConfig({
    nodes: [
      {
        id: 'alpha-source',
        role: 'source',
        baseUrl: sensitive[0],
        auth: { kind: 'bearer-file', secretFile: sensitive[2] },
      },
      {
        id: 'beta-receiver',
        role: 'receiver',
        baseUrl: sensitive[1],
        auth: { kind: 'bearer-file', secretFile: sensitive[3] },
      },
    ],
    lifecycle: {
      receiverNodeId: 'beta-receiver',
      stop: { argv: [sensitive[5], 'stop'] },
      start: { argv: [sensitive[5], 'start'] },
    },
    rpcUsage: { kind: 'evidence-file', path: sensitive[4], minimumSamples: 2 },
  });
  try {
    await writeFile(configPath, JSON.stringify(config));
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--import', 'tsx',
      RUNNER_PATH,
      '--config', configPath,
      '--artifact', artifactPath,
      '--dry-run',
    ], { cwd: AGENT_DIRECTORY });
    assert.match(stdout, /^DRY_RUN /u);
    assert.equal(stderr, '');
    const artifactText = await readFile(artifactPath, 'utf8');
    assert.equal(JSON.parse(artifactText).status, 'DRY_RUN');
    for (const value of [...sensitive, CG, 'alpha-source', 'beta-receiver']) {
      assert.equal(artifactText.includes(value), false, value);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('operator CLI rejects config/artifact aliases before changing configuration bytes', async () => {
  for (const aliasKind of ['same', 'normalized', 'symlink', 'hard-link']) {
    const directory = await mkdtemp(join(tmpdir(), 'rfc64-remote-canary-alias-test-'));
    const configPath = join(directory, 'config.json');
    const original = JSON.stringify(baseConfig());
    let artifactPath = configPath;
    try {
      await writeFile(configPath, original);
      if (aliasKind === 'normalized') {
        await mkdir(join(directory, 'nested'));
        artifactPath = join(directory, 'nested', '..', 'config.json');
      } else if (aliasKind === 'symlink') {
        artifactPath = join(directory, 'artifact.json');
        await symlink(configPath, artifactPath);
      } else if (aliasKind === 'hard-link') {
        artifactPath = join(directory, 'artifact.json');
        await link(configPath, artifactPath);
      }
      await assert.rejects(
        execFileAsync(process.execPath, [
          '--import', 'tsx',
          RUNNER_PATH,
          '--config', configPath,
          '--artifact', artifactPath,
        ], { cwd: AGENT_DIRECTORY }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /FAIL config-artifact-path-alias/u);
          return true;
        },
        aliasKind,
      );
      assert.equal(await readFile(configPath, 'utf8'), original, aliasKind);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('operator CLI persists INCOMPLETE and exits 2 when required evidence is absent', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/status' && ['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(200);
      response.end(JSON.stringify(statusBody()));
      return;
    }
    if (request.url === '/api/knowledge-assets' && request.method === 'POST') {
      response.writeHead(200);
      response.end(JSON.stringify({ swmShared: true }));
      return;
    }
    if (request.url === '/api/query' && request.method === 'POST') {
      response.writeHead(200);
      response.end(JSON.stringify({ result: { type: 'boolean', value: true } }));
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');

  const directory = await mkdtemp(join(tmpdir(), 'rfc64-remote-canary-cli-incomplete-'));
  const artifactPath = join(directory, 'result.json');
  const configPath = join(directory, 'config.json');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const config = baseConfig({
    nodes: [
      { id: 'alpha-source', role: 'source', baseUrl, auth: { kind: 'none' } },
      { id: 'beta-receiver', role: 'receiver', baseUrl, auth: { kind: 'none' } },
    ],
    lifecycle: null,
    authorizationChecks: {
      unauthorized: {
        kind: 'not-exposed',
        reasonCode: 'catalog-protocol-api-not-exposed',
      },
      revoked: { kind: 'not-exposed', reasonCode: 'revocation-api-not-exposed' },
    },
    rpcUsage: { kind: 'required' },
  });
  try {
    await writeFile(configPath, JSON.stringify(config));
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--import', 'tsx',
        RUNNER_PATH,
        '--config', configPath,
        '--artifact', artifactPath,
      ], { cwd: AGENT_DIRECTORY }),
      (error) => {
        assert.equal(error.code, 2);
        assert.equal(error.stdout, `INCOMPLETE ${artifactPath}\n`);
        assert.equal(error.stderr, '');
        return true;
      },
    );
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
    assert.equal(artifact.status, 'INCOMPLETE');
    assert.equal(artifact.phase, 'evidence-required');
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections?.();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});

test('runner invalidates a stale PASS before reading malformed configuration JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rfc64-remote-canary-runner-test-'));
  const artifactPath = join(directory, 'latest.json');
  const configPath = join(directory, 'config.json');
  try {
    await writeFile(artifactPath, JSON.stringify({ status: 'PASS', secret: SOURCE_SECRET }));
    await writeFile(configPath, '{"schema":');
    await assert.rejects(execFileAsync(process.execPath, [
      RUNNER_PATH,
      '--config', configPath,
      '--artifact', artifactPath,
    ]));
    const artifactText = await readFile(artifactPath, 'utf8');
    const artifact = JSON.parse(artifactText);
    assert.equal(artifact.status, 'FAIL');
    assert.equal(artifact.failure.code, 'unexpected-execution-failure');
    assert.equal(artifactText.includes(SOURCE_SECRET), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('artifact lifecycle requires a configuration loader before touching output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rfc64-remote-canary-loader-test-'));
  const artifactPath = join(directory, 'latest.json');
  const original = JSON.stringify({ status: 'PASS' });
  try {
    await writeFile(artifactPath, original);
    await assert.rejects(
      runRemoteCanaryArtifactLifecycleV1({ artifactPath }),
      (error) => error instanceof TypeError && error.message === 'config-loader-required',
    );
    assert.equal(await readFile(artifactPath, 'utf8'), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('artifact lifecycle replaces a stale PASS with sanitized FAIL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rfc64-remote-canary-test-'));
  const artifactPath = join(directory, 'latest.json');
  try {
    await writeFile(artifactPath, JSON.stringify({ status: 'PASS', secret: SOURCE_SECRET }));
    const dependencies = {
      readFileFn: async () => SOURCE_SECRET,
      fetchFn: async () => {
        throw new Error(`sensitive ${SOURCE_URL} ${SOURCE_SECRET}`);
      },
      now: () => new Date('2026-09-11T00:02:30.000Z'),
    };
    await assert.rejects(runRemoteCanaryArtifactLifecycleV1({
      loadConfig: async () => {
        const starting = JSON.parse(await readFile(artifactPath, 'utf8'));
        assert.equal(starting.status, 'INCOMPLETE');
        assert.equal(starting.phase, 'starting');
        return baseConfig();
      },
      artifactPath,
      dependencies,
    }));
    const artifactText = await readFile(artifactPath, 'utf8');
    const artifact = JSON.parse(artifactText);
    assert.equal(artifact.status, 'FAIL');
    assert.equal(artifact.failure.code, 'node-request-failed');
    assert.equal(artifactText.includes(SOURCE_SECRET), false);
    assert.equal(artifactText.includes(SOURCE_URL), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
