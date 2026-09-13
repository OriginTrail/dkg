// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  createRemoteCanaryDryRunArtifactV1,
  runRemoteCanaryArtifactLifecycleV1,
  writeArtifactAtomicV1,
} from './certify.mjs';
import {
  stableJsonStringify,
  writeStableJsonArtifact,
} from '../rfc64-artifact-publication-v1.mjs';
import { writeGateArtifactAtomicV1 } from '../../packages/agent/devnet/rfc64-private-catalog/gate-artifact.mjs';
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

async function createTemporaryDirectoryV1(prefix) {
  return mkdtemp(join(await realpath(tmpdir()), prefix));
}

test('private gate and remote canary publish through one canonical artifact writer', async () => {
  const directory = await createTemporaryDirectoryV1('rfc64-shared-artifact-writer-');
  const privatePath = join(directory, 'private.json');
  const remotePath = join(directory, 'remote.json');
  const directPath = join(directory, 'direct.json');
  const remoteValue = createRemoteCanaryDryRunArtifactV1(
    baseConfig(),
    () => new Date('2026-09-11T01:00:00.000Z'),
  );
  const privateValue = structuredClone(remoteValue);
  try {
    const privateWritten = await writeGateArtifactAtomicV1(privatePath, privateValue);
    const remoteWritten = await writeArtifactAtomicV1(remotePath, remoteValue);
    const directWritten = writeStableJsonArtifact(directPath, remoteValue);
    const expectedBytes = stableJsonStringify(remoteValue);

    assert.equal(await readFile(privatePath, 'utf8'), expectedBytes);
    assert.equal(await readFile(remotePath, 'utf8'), expectedBytes);
    assert.equal(await readFile(directPath, 'utf8'), expectedBytes);
    assert.deepEqual(privateWritten, directWritten);
    assert.deepEqual(remoteWritten, directWritten);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
  const directory = await createTemporaryDirectoryV1('rfc64-remote-canary-cli-dry-run-');
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
  for (const aliasKind of ['same', 'normalized', 'symlink', 'hard-link', 'whitespace']) {
    const directory = await createTemporaryDirectoryV1('rfc64-remote-canary-alias-test-');
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
      } else if (aliasKind === 'whitespace') {
        artifactPath = `${configPath} `;
      }
      await assert.rejects(
        execFileAsync(process.execPath, [
          RUNNER_PATH,
          '--config', configPath,
          '--artifact', artifactPath,
        ], { cwd: AGENT_DIRECTORY }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(
            error.stderr,
            aliasKind === 'whitespace'
              ? /FAIL runner-failed/u
              : /FAIL config-artifact-path-alias/u,
          );
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
  const source = await startIncompleteDaemon('12D3KooIncompleteSource');
  const receiver = await startIncompleteDaemon('12D3KooIncompleteReceiver');

  const directory = await createTemporaryDirectoryV1('rfc64-remote-canary-cli-incomplete-');
  const artifactPath = join(directory, 'result.json');
  const configPath = join(directory, 'config.json');
  const config = baseConfig({
    nodes: [
      {
        id: 'alpha-source',
        role: 'source',
        baseUrl: source.baseUrl,
        auth: { kind: 'none' },
      },
      {
        id: 'beta-receiver',
        role: 'receiver',
        baseUrl: receiver.baseUrl,
        auth: { kind: 'none' },
      },
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
    await Promise.all([source.close(), receiver.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

async function startIncompleteDaemon(daemonIdentity) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/status' && ['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(200);
      response.end(JSON.stringify(statusBody({ daemonIdentity })));
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
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections?.();
      await closed;
    },
  };
}

test('runner rejects malformed configuration without changing a prior artifact', async () => {
  const directory = await createTemporaryDirectoryV1('rfc64-remote-canary-runner-test-');
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
    assert.equal(await readFile(artifactPath, 'utf8'), JSON.stringify({
      status: 'PASS',
      secret: SOURCE_SECRET,
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runner never replaces configured credential or RPC evidence inputs', async () => {
  for (const scenario of [
    { label: 'credential-direct-dry', input: 'credential', alias: 'direct', dryRun: true },
    { label: 'credential-normalized-live', input: 'credential', alias: 'normalized', dryRun: false },
    { label: 'credential-whitespace-live', input: 'credential', alias: 'whitespace', dryRun: false },
    { label: 'evidence-symlink-dry', input: 'evidence', alias: 'symlink', dryRun: true },
    { label: 'evidence-hard-link-live', input: 'evidence', alias: 'hard-link', dryRun: false },
    { label: 'evidence-whitespace-dry', input: 'evidence', alias: 'whitespace', dryRun: true },
    { label: 'companion-direct-dry', input: 'companion', alias: 'direct', dryRun: true },
  ]) {
    const directory = await createTemporaryDirectoryV1(`rfc64-input-alias-${scenario.label}-`);
    const inputPath = join(directory, 'configured-input');
    const configPath = join(directory, 'config.json');
    const original = `sensitive-${scenario.label}`;
    let artifactPath = inputPath;
    try {
      await writeFile(inputPath, original);
      if (scenario.alias === 'normalized') {
        await mkdir(join(directory, 'nested'));
        artifactPath = join(directory, 'nested', '..', 'configured-input');
      } else if (scenario.alias === 'symlink') {
        artifactPath = join(directory, 'artifact.json');
        await symlink(inputPath, artifactPath);
      } else if (scenario.alias === 'hard-link') {
        artifactPath = join(directory, 'artifact.json');
        await link(inputPath, artifactPath);
      } else if (scenario.alias === 'whitespace') {
        artifactPath = `${inputPath} `;
      }
      const config = baseConfig();
      if (scenario.input === 'credential') {
        config.nodes[0].auth.secretFile = inputPath;
      } else if (scenario.input === 'evidence') {
        config.rpcUsage.path = inputPath;
      } else {
        config.authorizationChecks = {
          unauthorized: {
            kind: 'not-exposed',
            reasonCode: 'catalog-protocol-api-not-exposed',
          },
          revoked: {
            kind: 'not-exposed',
            reasonCode: 'revocation-api-not-exposed',
          },
          companionEvidence: {
            kind: 'private-gate-artifact',
            path: inputPath,
          },
        };
      }
      await writeFile(configPath, JSON.stringify(config));
      await assert.rejects(
        execFileAsync(process.execPath, [
          RUNNER_PATH,
          '--config', configPath,
          '--artifact', artifactPath,
          ...(scenario.dryRun ? ['--dry-run'] : []),
        ], { cwd: AGENT_DIRECTORY }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(
            error.stderr,
            scenario.alias === 'whitespace'
              ? /FAIL runner-failed/u
              : /FAIL artifact-input-path-alias/u,
          );
          return true;
        },
        scenario.label,
      );
      assert.equal(await readFile(inputPath, 'utf8'), original, scenario.label);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('artifact lifecycle requires a configuration loader before touching output', async () => {
  const directory = await createTemporaryDirectoryV1('rfc64-remote-canary-loader-test-');
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
  const directory = await createTemporaryDirectoryV1('rfc64-remote-canary-test-');
  const artifactPath = join(directory, 'latest.json');
  try {
    await writeFile(artifactPath, JSON.stringify({ status: 'PASS', secret: SOURCE_SECRET }));
    const dependencies = {
      readFileFn: async () => SOURCE_SECRET,
      fetchFn: async () => {
        const starting = JSON.parse(await readFile(artifactPath, 'utf8'));
        assert.equal(starting.status, 'INCOMPLETE');
        assert.equal(starting.phase, 'starting');
        throw new Error(`sensitive ${SOURCE_URL} ${SOURCE_SECRET}`);
      },
      now: () => new Date('2026-09-11T00:02:30.000Z'),
    };
    await assert.rejects(runRemoteCanaryArtifactLifecycleV1({
      loadConfig: async () => baseConfig(),
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
