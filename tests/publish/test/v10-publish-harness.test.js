import { strict as assert } from 'assert';
import { spawn, spawnSync } from 'child_process';
import { createServer } from 'http';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  assertCompleteNodeRun,
  completionRate,
  requireJenkinsBuildExpectation,
  selectSingleNode,
  validateBearerToken,
  validateNodeBuild,
  validateConfirmedPublishIdentity,
  withAbortTimeout,
  withRunDeadline,
} from '../src/v10-publish-lib.js';
import { runNodeSuites } from '../scripts/run_node_suites.js';

describe('V10 Jenkins publish harness guards', () => {
  const nodes = [
    { name: 'Alpha', token: 'token-alpha' },
    { name: 'Beta', token: 'token-beta' },
  ];

  it('requires NODE_TO_TEST to identify exactly one configured node', () => {
    assert.equal(selectSingleNode(nodes, 'Beta').name, 'Beta');
    assert.throws(() => selectSingleNode(nodes, ''), /NODE_TO_TEST is required/);
    assert.throws(() => selectSingleNode(nodes, 'Missing'), /matched 0 nodes/);
    assert.throws(
      () => selectSingleNode([...nodes, { name: 'Beta' }], 'Beta'),
      /matched 2 nodes/,
    );
  });

  it('runs every node in an aggregate suite before returning failure', () => {
    const invoked = [];
    const exitCode = runNodeSuites(
      'base-mainnet',
      (script) => {
        invoked.push(script);
        return { status: script.includes('sbb') ? 1 : 0 };
      },
      { log() {}, error() {} },
    );
    assert.equal(exitCode, 1);
    assert.deepEqual(invoked, [
      'test:base:sbb:mainnet',
      'test:base:dmaast:mainnet',
    ]);
  });

  it('makes missing telemetry artifacts fail their importer steps', () => {
    const summaryImporter = fileURLToPath(new URL('../scripts/insert_summary_to_db.js', import.meta.url));
    const errorImporter = fileURLToPath(new URL('../scripts/insert_errors_to_db.js', import.meta.url));
    for (const importer of [summaryImporter, errorImporter]) {
      const noFiles = spawnSync(process.execPath, [importer], { encoding: 'utf8' });
      assert.equal(noFiles.status, 1, noFiles.stdout + noFiles.stderr);
      const missingFile = spawnSync(
        process.execPath,
        [importer, 'artifact-does-not-exist.json'],
        { encoding: 'utf8' },
      );
      assert.equal(missingFile.status, 1, missingFile.stdout + missingFile.stderr);
    }
  });

  it('rejects missing and placeholder bearer tokens without printing the value', () => {
    assert.equal(validateBearerToken('Alpha', '  real-secret  '), 'real-secret');
    assert.throws(() => validateBearerToken('Alpha', ''), /bearer token is missing/);
    assert.throws(() => validateBearerToken('Alpha', 'CHANGE-ME'), /placeholder text/);
  });

  it('checks expected node version and full-or-short commit', () => {
    const status = {
      version: '10.0.6',
      commit: 'abcdef1234567890',
      storeBackend: 'blazegraph',
    };
    assert.deepEqual(validateNodeBuild(status, 'v10.0.6', 'abcdef12'), {
      version: '10.0.6',
      commit: 'abcdef1234567890',
      storeBackend: 'blazegraph',
    });
    assert.throws(() => validateNodeBuild(status, '10.0.5', ''), /version mismatch/);
    assert.throws(() => validateNodeBuild(status, '', '12345678'), /commit mismatch/);
  });

  it('requires an exact deployment expectation in Jenkins', () => {
    assert.doesNotThrow(() => requireJenkinsBuildExpectation('', false));
    assert.doesNotThrow(() => requireJenkinsBuildExpectation('abcdef12', true));
    assert.throws(
      () => requireJenkinsBuildExpectation('', true),
      /EXPECTED_NODE_COMMIT is required in Jenkins/,
    );
  });

  it('requires a nonzero KA id and a fresh UAL before publish success', () => {
    assert.deepEqual(
      validateConfirmedPublishIdentity({ kaId: 17, ual: 'did:dkg:base:8453/17' }),
      { kaId: '17', ual: 'did:dkg:base:8453/17' },
    );
    for (const kaId of [undefined, null, -1, 0, '0', 'abc', '']) {
      assert.throws(
        () => validateConfirmedPublishIdentity({ kaId, ual: 'did:dkg:base:8453/17' }),
        /positive-decimal kaId/,
      );
    }
    assert.throws(
      () => validateConfirmedPublishIdentity({ kaId: 17 }),
      /valid DKG UAL/,
    );
    assert.throws(
      () => validateConfirmedPublishIdentity({ kaId: 17, ual: 'https://example.com/stale' }),
      /valid DKG UAL/,
    );
  });

  it('computes telemetry rates against the configured workload', () => {
    assert.equal(completionRate(9, 10), '90.00');
    assert.equal(completionRate(0, 10), '0.00');
    assert.equal(completionRate(0, 0), '0.00');
  });

  it('can exclude remote query from the authoritative lifecycle gate', () => {
    const stats = {
      publishSuccess: 2, publishFail: 0,
      querySuccess: 2, queryFail: 0,
      vmGetSuccess: 2, vmGetFail: 0,
      queryRemoteSuccess: 0, queryRemoteFail: 2,
    };
    assert.doesNotThrow(() => assertCompleteNodeRun('Alpha', stats, 2, false));
    assert.throws(
      () => assertCompleteNodeRun('Alpha', stats, 2, true),
      /Query Remote \(sync\): expected 2 success \/ 0 fail/,
    );
  });

  it('aborts and waits for publish-operation cleanup before rejecting', async () => {
    let abortObserved = false;
    let cleanupFinished = false;

    await assert.rejects(
      withAbortTimeout(
        (signal) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            abortObserved = true;
            setImmediate(() => {
              cleanupFinished = true;
              reject(signal.reason);
            });
          }, { once: true });
        }),
        'publish',
        'Alpha',
        10,
      ),
      (error) => error.code === 'PUBLISH_HTTP_TIMEOUT' && error.publishTimeout === true,
    );

    assert.equal(abortObserved, true);
    assert.equal(cleanupFinished, true);
  });

  it('aborts at the in-process run deadline and marks the cause', async () => {
    let abortObserved = false;
    await assert.rejects(
      withRunDeadline(
        (signal) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            abortObserved = true;
            reject(signal.reason);
          }, { once: true });
        }),
        'query',
        'Alpha',
        1000,
        Date.now() + 15,
      ),
      (error) => error.code === 'RUN_DEADLINE' && error.runDeadline === true,
    );
    assert.equal(abortObserved, true);
  });

  it('defaults remote verification off, makes no remote request, and reports null telemetry', async () => {
    let publishRequests = 0;
    let localReadRequests = 0;
    let remoteReadRequests = 0;
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          version: '10.0.6',
          commit: 'abcdef1234567890',
          storeBackend: 'blazegraph',
          peerId: 'fake-peer',
        }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/wallets') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ wallets: ['0xfake'], chainId: '8453' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/knowledge-assets') {
        publishRequests++;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'vm-confirmed',
          kaId: 17,
          ual: 'did:dkg:base:8453/0xasset/17',
          authorAddress: '0xpublisher',
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/query') {
        localReadRequests++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { bindings: [{ value: 'fresh' }] } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/query-remote') {
        remoteReadRequests++;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'remote verification must be skipped by default' }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const runDir = await mkdtemp(join(tmpdir(), 'dkg-publish-default-local-only-'));
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const mochaBin = fileURLToPath(new URL('../node_modules/mocha/bin/mocha.js', import.meta.url));
      const spec = fileURLToPath(new URL('../src/Base_Mainnet.spec.js', import.meta.url));
      const childEnv = {
        ...process.env,
        NODE_TO_TEST: 'SBB',
        SBB_API_URL: `http://127.0.0.1:${port}`,
        DMAAST_API_URL: `http://127.0.0.1:${port}`,
        V10_TOKEN_SBB: 'real-token',
        V10_TOKEN_DMAAST: 'real-token',
        TEST_KA_BATCHES: '1',
        TEST_ENTITY_COUNT: '1',
        TEST_CONTENT_SIZE_KB: '1',
        TEST_BATCH_DELAY_MS: '0',
        V10_READ_RETRIES: '0',
        V10_OP_TIMEOUT_MS: '250',
        V10_PUBLISH_TIMEOUT_MS: '500',
        V10_HTTP_TIMEOUT_MS: '1000',
        V10_RUN_TIMEOUT_MS: '2000',
        EXPECTED_NODE_VERSION: '10.0.6',
        EXPECTED_NODE_COMMIT: 'abcdef12',
        V10_CG_REGISTER: 'false',
        V10_CG_SUBSCRIBE: 'false',
      };
      // Prove the default rather than inheriting an opt-in from the test runner.
      delete childEnv.V10_ENABLE_REMOTE_QUERY;

      const child = spawn(process.execPath, [mochaBin, spec, '--exit'], {
        cwd: runDir,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`default local-only lifecycle spec did not finish:\n${output}`));
        }, 4000);
        child.once('error', reject);
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      const summary = JSON.parse(await readFile(join(runDir, 'summary_SBB.json'), 'utf8'));
      assert.equal(exitCode, 0, output);
      assert.equal(publishRequests, 1, output);
      assert.equal(localReadRequests, 2, output);
      assert.equal(remoteReadRequests, 0, output);
      assert.equal(summary.harness_error, null);
      assert.equal(summary.remote_query_enabled, false);
      assert.equal(summary.publish_success_rate, '100.00');
      assert.equal(summary.query_success_rate, '100.00');
      assert.equal(summary.publisher_get_success_rate, '100.00');
      assert.equal(summary.non_publisher_get_success_rate, null);
      assert.equal(summary.average_non_publisher_get_time, null);
      assert.match(output, /Query Remote \(sync\) skipped — not part of this release gate/);
      assert.match(output, /All assets processed successfully/);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('completes a fresh publish/query/VM lifecycle with opt-in remote verification', async () => {
    let publishRequests = 0;
    let localReadRequests = 0;
    let remoteReadRequests = 0;
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          version: '10.0.6',
          commit: 'abcdef1234567890',
          storeBackend: 'blazegraph',
          peerId: 'fake-peer',
        }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/wallets') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ wallets: ['0xfake'], chainId: '8453' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/knowledge-assets') {
        publishRequests++;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'vm-confirmed',
          kaId: 17,
          ual: 'did:dkg:base:8453/0xasset/17',
          authorAddress: '0xpublisher',
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/query') {
        localReadRequests++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { bindings: [{ value: 'fresh' }] } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/query-remote') {
        remoteReadRequests++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK', ntriples: '<urn:fresh> <urn:p> <urn:o> .' }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const runDir = await mkdtemp(join(tmpdir(), 'dkg-publish-success-'));
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const mochaBin = fileURLToPath(new URL('../node_modules/mocha/bin/mocha.js', import.meta.url));
      const spec = fileURLToPath(new URL('../src/Base_Mainnet.spec.js', import.meta.url));
      const child = spawn(process.execPath, [mochaBin, spec, '--exit'], {
        cwd: runDir,
        env: {
          ...process.env,
          NODE_TO_TEST: 'SBB',
          SBB_API_URL: `http://127.0.0.1:${port}`,
          DMAAST_API_URL: `http://127.0.0.1:${port}`,
          V10_TOKEN_SBB: 'real-token',
          V10_TOKEN_DMAAST: 'real-token',
          TEST_KA_BATCHES: '1',
          TEST_ENTITY_COUNT: '1',
          TEST_CONTENT_SIZE_KB: '1',
          TEST_BATCH_DELAY_MS: '0',
          V10_READ_RETRIES: '0',
          V10_OP_TIMEOUT_MS: '250',
          V10_PUBLISH_TIMEOUT_MS: '500',
          V10_HTTP_TIMEOUT_MS: '1000',
          V10_RUN_TIMEOUT_MS: '2000',
          EXPECTED_NODE_VERSION: '10.0.6',
          EXPECTED_NODE_COMMIT: 'abcdef12',
          V10_CG_REGISTER: 'false',
          V10_CG_SUBSCRIBE: 'false',
          V10_ENABLE_REMOTE_QUERY: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`successful lifecycle spec did not finish:\n${output}`));
        }, 4000);
        child.once('error', reject);
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      const summary = JSON.parse(await readFile(join(runDir, 'summary_SBB.json'), 'utf8'));
      assert.equal(exitCode, 0, output);
      assert.equal(publishRequests, 1, output);
      assert.equal(localReadRequests, 2, output);
      assert.equal(remoteReadRequests, 1, output);
      assert.equal(summary.harness_error, null);
      assert.equal(summary.remote_query_enabled, true);
      assert.equal(summary.publish_success_rate, '100.00');
      assert.equal(summary.query_success_rate, '100.00');
      assert.equal(summary.publisher_get_success_rate, '100.00');
      assert.equal(summary.non_publisher_get_success_rate, '100.00');
      assert.match(output, /All assets processed successfully/);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('aborts a hanging HTTP publish, stops after one KA, checkpoints, and exits nonzero', async () => {
    let publishRequests = 0;
    let abortedPublishes = 0;
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          version: '10.0.6',
          commit: 'abcdef1234567890',
          storeBackend: 'blazegraph',
          peerId: 'fake-peer',
          connectedPeers: 1,
        }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/wallets') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ wallets: ['0xfake'], chainId: '8453' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/knowledge-assets') {
        publishRequests++;
        req.resume();
        req.on('aborted', () => { abortedPublishes++; });
        res.on('close', () => {
          if (!res.writableEnded && abortedPublishes === 0) abortedPublishes++;
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const runDir = await mkdtemp(join(tmpdir(), 'dkg-publish-harness-'));
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const mochaBin = fileURLToPath(new URL('../node_modules/mocha/bin/mocha.js', import.meta.url));
      const spec = fileURLToPath(new URL('../src/Base_Mainnet.spec.js', import.meta.url));
      const child = spawn(process.execPath, [mochaBin, spec, '--exit'], {
        cwd: runDir,
        env: {
          ...process.env,
          NODE_TO_TEST: 'SBB',
          SBB_API_URL: `http://127.0.0.1:${port}`,
          V10_TOKEN_SBB: 'real-token',
          TEST_KA_BATCHES: '3',
          TEST_ENTITY_COUNT: '1',
          TEST_CONTENT_SIZE_KB: '1',
          TEST_BATCH_DELAY_MS: '0',
          V10_OP_TIMEOUT_MS: '40',
          V10_PUBLISH_TIMEOUT_MS: '40',
          V10_HTTP_TIMEOUT_MS: '1000',
          EXPECTED_NODE_VERSION: '10.0.6',
          EXPECTED_NODE_COMMIT: 'abcdef12',
          V10_CG_REGISTER: 'false',
          V10_CG_SUBSCRIBE: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`mock publish spec did not finish:\n${output}`));
        }, 4000);
        child.once('error', reject);
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      const summary = JSON.parse(await readFile(join(runDir, 'summary_SBB.json'), 'utf8'));
      assert.equal(exitCode, 1, output);
      assert.equal(publishRequests, 1, output);
      assert.equal(abortedPublishes, 1, output);
      assert.equal(summary.expected_ka_count, 3);
      assert.equal(summary.attempted_publish_count, 1);
      assert.equal(summary.publish_success_rate, '0.00');
      assert.match(summary.harness_error, /expected 3 success \/ 0 fail/);
      assert.match(output, /publish HTTP request was aborted; stopping remaining KAs/);
      assert.match(output, /Checkpointed summary in finally/);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('rejects a confirmed response without a fresh UAL and never reads fallback data', async () => {
    let publishRequests = 0;
    let readRequests = 0;
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          version: '10.0.6',
          commit: 'abcdef1234567890',
          storeBackend: 'blazegraph',
          peerId: 'fake-peer',
        }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/wallets') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ wallets: ['0xfake'], chainId: '8453' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/knowledge-assets') {
        publishRequests++;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'vm-confirmed', kaId: 17 }));
        return;
      }
      if (req.method === 'POST' && (req.url === '/api/query' || req.url === '/api/query-remote')) {
        readRequests++;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const runDir = await mkdtemp(join(tmpdir(), 'dkg-publish-missing-ual-'));
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const mochaBin = fileURLToPath(new URL('../node_modules/mocha/bin/mocha.js', import.meta.url));
      const spec = fileURLToPath(new URL('../src/Base_Mainnet.spec.js', import.meta.url));
      const child = spawn(process.execPath, [mochaBin, spec, '--exit'], {
        cwd: runDir,
        env: {
          ...process.env,
          NODE_TO_TEST: 'SBB',
          SBB_API_URL: `http://127.0.0.1:${port}`,
          V10_TOKEN_SBB: 'real-token',
          TEST_KA_BATCHES: '1',
          TEST_ENTITY_COUNT: '1',
          TEST_CONTENT_SIZE_KB: '1',
          TEST_BATCH_DELAY_MS: '0',
          V10_OP_TIMEOUT_MS: '100',
          V10_PUBLISH_TIMEOUT_MS: '500',
          V10_HTTP_TIMEOUT_MS: '1000',
          EXPECTED_NODE_VERSION: '10.0.6',
          EXPECTED_NODE_COMMIT: 'abcdef12',
          V10_CG_REGISTER: 'false',
          V10_CG_SUBSCRIBE: 'false',
          DKG_FALLBACK_UAL: 'did:dkg:base:8453/stale-data-must-not-be-read',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`missing-UAL spec did not finish:\n${output}`));
        }, 4000);
        child.once('error', reject);
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      const summary = JSON.parse(await readFile(join(runDir, 'summary_SBB.json'), 'utf8'));
      assert.equal(exitCode, 1, output);
      assert.equal(publishRequests, 1, output);
      assert.equal(readRequests, 0, output);
      assert.equal(summary.publish_success_rate, '0.00');
      assert.equal(summary.query_success_rate, '0.00');
      assert.match(summary.harness_error, /expected 1 success \/ 0 fail/);
      assert.match(output, /Confirmed publish response did not include a valid DKG UAL/);
      assert.match(output, /skipping reads.*publish produced no fresh UAL/i);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('checkpoints a wrong-deployment preflight with its cause', async () => {
    let publishRequests = 0;
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          version: '10.0.6',
          commit: 'abcdef1234567890',
          storeBackend: 'blazegraph',
          peerId: 'fake-peer',
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/knowledge-assets') publishRequests++;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const runDir = await mkdtemp(join(tmpdir(), 'dkg-publish-wrong-build-'));
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const mochaBin = fileURLToPath(new URL('../node_modules/mocha/bin/mocha.js', import.meta.url));
      const spec = fileURLToPath(new URL('../src/Base_Mainnet.spec.js', import.meta.url));
      const child = spawn(process.execPath, [mochaBin, spec, '--exit'], {
        cwd: runDir,
        env: {
          ...process.env,
          NODE_TO_TEST: 'SBB',
          SBB_API_URL: `http://127.0.0.1:${port}`,
          V10_TOKEN_SBB: 'real-token',
          TEST_KA_BATCHES: '1',
          TEST_ENTITY_COUNT: '1',
          TEST_CONTENT_SIZE_KB: '1',
          V10_OP_TIMEOUT_MS: '100',
          V10_PUBLISH_TIMEOUT_MS: '500',
          V10_HTTP_TIMEOUT_MS: '1000',
          EXPECTED_NODE_VERSION: '10.0.6',
          EXPECTED_NODE_COMMIT: 'deadbee',
          V10_CG_REGISTER: 'false',
          V10_CG_SUBSCRIBE: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`wrong-build spec did not finish:\n${output}`));
        }, 4000);
        child.once('error', reject);
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      const summary = JSON.parse(await readFile(join(runDir, 'summary_SBB.json'), 'utf8'));
      const errors = JSON.parse(await readFile(join(runDir, 'errors_SBB.json'), 'utf8'));
      assert.equal(exitCode, 1, output);
      assert.equal(publishRequests, 0, output);
      assert.equal(summary.node_commit, 'abcdef1234567890');
      assert.match(summary.harness_error, /Node commit mismatch/);
      assert.equal(Object.keys(errors.detailed).length, 1);
      assert.match(Object.keys(errors.detailed)[0], /Harness stopped before workload: Node commit mismatch/);
      assert.match(output, /Checkpointed summary in finally/);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('fails an incomplete or partially failed lifecycle run', () => {
    const complete = {
      publishSuccess: 2, publishFail: 0,
      querySuccess: 2, queryFail: 0,
      vmGetSuccess: 2, vmGetFail: 0,
      queryRemoteSuccess: 2, queryRemoteFail: 0,
    };
    assert.doesNotThrow(() => assertCompleteNodeRun('Alpha', complete, 2, true));
    assert.throws(
      () => assertCompleteNodeRun(
        'Alpha',
        { ...complete, publishSuccess: 1, publishFail: 1 },
        2,
        true,
      ),
      /publish: expected 2 success \/ 0 fail, got 1 success \/ 1 fail/,
    );
  });
});
