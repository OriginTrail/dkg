import { strict as assert } from 'assert';
import { spawn, spawnSync } from 'child_process';
import { createServer } from 'http';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
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
  waitForBatchDelay,
  withAbortTimeout,
  withRunDeadline,
} from '../src/v10-publish-lib.js';
import { requireCompleteLifecyclePublishResponse } from '../src/v10-helpers.js';
import { importSummaries } from '../scripts/insert_summary_to_db.js';
import { importErrors } from '../scripts/insert_errors_to_db.js';
import { CHAIN_SUITE_MANIFEST, runNodeSuites } from '../scripts/run_node_suites.js';

const MOCHA_BIN = fileURLToPath(new URL('../node_modules/mocha/bin/mocha.js', import.meta.url));
const BASE_MAINNET_SPEC = fileURLToPath(new URL('../src/Base_Mainnet.spec.js', import.meta.url));
const SUMMARY_IMPORTER = fileURLToPath(new URL('../scripts/insert_summary_to_db.js', import.meta.url));
const ERROR_IMPORTER = fileURLToPath(new URL('../scripts/insert_errors_to_db.js', import.meta.url));
const EXPECTED_CONTEXT_GRAPH = 'sports';
const FRESH_UAL = 'did:dkg:base:8453/0xasset/17';
const STALE_UAL = 'did:dkg:base:8453/0xstale/9';
const EXPECTED_PEER_ID = 'fake-peer';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function statusResponse(overrides = {}) {
  return {
    version: '10.0.6',
    commit: 'abcdef1234567890',
    storeBackend: 'blazegraph',
    peerId: EXPECTED_PEER_ID,
    ...overrides,
  };
}

function rootFromPublish(body) {
  return body.quads?.find((quad) => quad.object === 'http://schema.org/Dataset')?.subject;
}

function createStrictLifecycleRouter({
  publishUal = FRESH_UAL,
  requiredRemoteUal = publishUal,
  publishHttpStatus = 201,
  publishResponse = {},
  retainPublishedRootInSwm = false,
} = {}) {
  const state = {
    publishBodies: [],
    localQueryBodies: [],
    swmQueryBodies: [],
    remoteQueryBodies: [],
    publishedRoot: null,
  };

  const handler = async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/status') {
      json(res, 200, statusResponse());
      return;
    }
    if (req.method === 'GET' && req.url === '/api/wallets') {
      json(res, 200, { wallets: ['0xfake'], chainId: '8453' });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/knowledge-assets') {
      const body = await readJsonBody(req);
      state.publishBodies.push(body);
      state.publishedRoot = rootFromPublish(body);
      if (!state.publishedRoot || body.contextGraphId !== EXPECTED_CONTEXT_GRAPH) {
        json(res, 400, { error: 'publish did not contain the expected fresh root/context graph' });
        return;
      }
      json(res, publishHttpStatus, {
        status: 'vm-confirmed',
        kaId: 17,
        ual: publishUal,
        authorAddress: '0xpublisher',
        ...publishResponse,
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/query') {
      const body = await readJsonBody(req);
      if (body.view === 'shared-working-memory') {
        state.swmQueryBodies.push(body);
        const targetsFreshRoot = Boolean(state.publishedRoot)
          && body.contextGraphId === EXPECTED_CONTEXT_GRAPH
          && typeof body.sparql === 'string'
          && body.sparql.includes(`<${state.publishedRoot}>`);
        json(res, 200, {
          result: {
            bindings: retainPublishedRootInSwm && targetsFreshRoot
              ? [{ predicate: 'urn:residue', object: 'still-present' }]
              : [],
          },
        });
        return;
      }
      state.localQueryBodies.push(body);
      const targetsFreshPublish = Boolean(state.publishedRoot)
        && body.contextGraphId === EXPECTED_CONTEXT_GRAPH
        && body.view === 'verifiable-memory'
        && typeof body.sparql === 'string'
        && body.sparql.includes(`<${state.publishedRoot}>`);
      json(res, 200, {
        result: { bindings: targetsFreshPublish ? [{ value: 'fresh' }] : [] },
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/query-remote') {
      const body = await readJsonBody(req);
      state.remoteQueryBodies.push(body);
      const targetsFreshPublish = body.peerId === EXPECTED_PEER_ID
        && body.contextGraphId === EXPECTED_CONTEXT_GRAPH
        && body.lookupType === 'ENTITY_BY_UAL'
        && body.ual === requiredRemoteUal;
      json(res, 200, {
        status: 'OK',
        ntriples: targetsFreshPublish ? '<urn:fresh> <urn:p> <urn:o> .' : '',
      });
      return;
    }
    json(res, 404, { error: 'not found' });
  };

  return { handler, state };
}

async function withMockNodeServer(handler, run) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) json(res, 500, { error: error.message });
      else res.destroy(error);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function readArtifact(runDir, filename) {
  try {
    return JSON.parse(await readFile(join(runDir, filename), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function runPublishSpec({
  baseUrl,
  env = {},
  timeoutMs = 4000,
  unsetEnv = [],
  prefix = 'dkg-publish-harness-',
}) {
  const runDir = await mkdtemp(join(tmpdir(), prefix));
  const childEnv = {
    ...process.env,
    NODE_TO_TEST: 'SBB',
    SBB_API_URL: baseUrl,
    DMAAST_API_URL: baseUrl,
    V10_TOKEN_SBB: 'real-token',
    V10_TOKEN_DMAAST: 'real-token',
    TEST_KA_BATCHES: '1',
    TEST_ENTITY_COUNT: '1',
    TEST_CONTENT_SIZE_KB: '1',
    TEST_BATCH_DELAY_MS: '0',
    V10_READ_RETRIES: '0',
    V10_READ_RETRY_MS: '1',
    V10_READ_TOTAL_TIMEOUT_MS: '300',
    V10_OP_TIMEOUT_MS: '250',
    V10_PUBLISH_TIMEOUT_MS: '500',
    V10_HTTP_TIMEOUT_MS: '1000',
    V10_RUN_TIMEOUT_MS: '2000',
    EXPECTED_NODE_VERSION: '10.0.6',
    EXPECTED_NODE_COMMIT: 'abcdef12',
    V10_CG_REGISTER: 'false',
    V10_CG_SUBSCRIBE: 'false',
    V10_ENABLE_REMOTE_QUERY: 'false',
    V10_SERVER_LOGS: 'false',
    DKG_CONTEXT_GRAPH_ID: EXPECTED_CONTEXT_GRAPH,
    ...env,
  };
  for (const key of unsetEnv) delete childEnv[key];

  try {
    const child = spawn(process.execPath, [MOCHA_BIN, BASE_MAINNET_SPEC, '--exit'], {
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
        reject(new Error(`publish lifecycle child did not finish:\n${output}`));
      }, timeoutMs);
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    return {
      exitCode,
      output,
      summary: await readArtifact(runDir, 'summary_SBB.json'),
      errors: await readArtifact(runDir, 'errors_SBB.json'),
    };
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

const quietLogger = { log() {}, error() {}, warn() {} };

class FakePgClient {
  constructor(store, { failConnect = false, failInsertAt = 0, failCommit = false } = {}) {
    this.store = store;
    this.failConnect = failConnect;
    this.failInsertAt = failInsertAt;
    this.failCommit = failCommit;
    this.calls = [];
    this.staged = [];
    this.insertCount = 0;
  }

  async connect() {
    this.calls.push('CONNECT');
    if (this.failConnect) throw new Error('injected connect failure');
  }

  async query(sql, values) {
    const operation = String(sql).trim().split(/\s+/)[0].toUpperCase();
    this.calls.push(operation);
    if (operation === 'INSERT') {
      this.insertCount++;
      if (this.insertCount === this.failInsertAt) throw new Error('injected insert failure');
      this.staged.push(values);
    }
    if (operation === 'COMMIT') {
      if (this.failCommit) throw new Error('injected commit failure');
      this.store.push(...this.staged);
      this.staged = [];
    }
    if (operation === 'ROLLBACK') this.staged = [];
  }

  async end() { this.calls.push('END'); }
}

describe('V10 Jenkins publish harness guards', () => {
  const nodes = [
    { name: 'Alpha', token: 'token-alpha' },
    { name: 'Beta', token: 'token-beta' },
  ];

  it('requires NODE_TO_TEST to identify exactly one configured node', () => {
    assert.equal(selectSingleNode(nodes, 'Beta').name, 'Beta');
    assert.throws(() => selectSingleNode(nodes, ''), /NODE_TO_TEST is required/);
    assert.throws(() => selectSingleNode(nodes, 'Missing'), /matched 0 nodes/);
    assert.throws(() => selectSingleNode([...nodes, { name: 'Beta' }], 'Beta'), /matched 2 nodes/);
  });

  it('uses one canonical manifest for aggregate and single-node suite execution', () => {
    const invoked = [];
    const exitCode = runNodeSuites(
      'base-mainnet',
      ({ spec, node }) => {
        invoked.push({ spec, name: node.name, report: node.reportFilename });
        return { status: node.name === 'SBB' ? 1 : 0 };
      },
      quietLogger,
    );
    assert.equal(exitCode, 1);
    assert.deepEqual(invoked, [
      { spec: 'src/Base_Mainnet.spec.js', name: 'SBB', report: 'mainnet_base_sbb' },
      { spec: 'src/Base_Mainnet.spec.js', name: 'DMaaST', report: 'mainnet_base_dmaast' },
    ]);
    assert.deepEqual(
      CHAIN_SUITE_MANIFEST['base-mainnet'].nodes.map((node) => node.name),
      ['SBB', 'DMaaST'],
    );

    invoked.length = 0;
    assert.equal(runNodeSuites(
      'base-mainnet',
      ({ spec, node }) => {
        invoked.push({ spec, name: node.name, report: node.reportFilename });
        return { status: 0 };
      },
      quietLogger,
      'DMaaST',
    ), 0);
    assert.deepEqual(invoked, [
      { spec: 'src/Base_Mainnet.spec.js', name: 'DMaaST', report: 'mainnet_base_dmaast' },
    ]);
  });

  it('makes missing telemetry artifacts fail their importer steps', () => {
    for (const importer of [SUMMARY_IMPORTER, ERROR_IMPORTER]) {
      const noFiles = spawnSync(process.execPath, [importer], { encoding: 'utf8' });
      assert.equal(noFiles.status, 1, noFiles.stdout + noFiles.stderr);
      const missingFile = spawnSync(process.execPath, [importer, 'artifact-does-not-exist.json'], { encoding: 'utf8' });
      assert.equal(missingFile.status, 1, missingFile.stdout + missingFile.stderr);
    }
  });

  it('rolls back summary and error batches on insert or commit failure', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'dkg-import-atomic-'));
    try {
      const summaryFiles = [join(runDir, 'summary_A.json'), join(runDir, 'summary_B.json')];
      for (const [index, file] of summaryFiles.entries()) {
        await writeFile(file, JSON.stringify({
          blockchain_name: 'v10:base:8453',
          node_name: `Node ${index + 1}`,
          publish_success_rate: '100.00',
          time_stamp: new Date().toISOString(),
        }));
      }
      const errorFile = join(runDir, 'errors_TestNode1.json');
      await writeFile(errorFile, JSON.stringify([
        { blockchain_id: 'base:84532', ka_label: 'KA #1', publish_error: 'first' },
        { blockchain_id: 'base:84532', ka_label: 'KA #2', publish_error: 'second' },
      ]));

      for (const { importer, files } of [
        { importer: importSummaries, files: summaryFiles },
        { importer: importErrors, files: [errorFile] },
      ]) {
        const connectStore = [];
        const connectFailure = new FakePgClient(connectStore, { failConnect: true });
        assert.equal(await importer(files, {
          createClient: () => connectFailure,
          logger: quietLogger,
        }), 1);
        assert.deepEqual(connectStore, []);
        assert.deepEqual(connectFailure.calls, ['CONNECT', 'END']);

        const store = [];
        const insertFailure = new FakePgClient(store, { failInsertAt: 2 });
        assert.equal(await importer(files, {
          createClient: () => insertFailure,
          logger: quietLogger,
        }), 1);
        assert.deepEqual(store, []);
        assert.ok(insertFailure.calls.includes('ROLLBACK'));
        assert.ok(!insertFailure.calls.includes('COMMIT'));

        const retry = new FakePgClient(store);
        assert.equal(await importer(files, { createClient: () => retry, logger: quietLogger }), 0);
        assert.equal(store.length, 2, 'retry should contain one copy of each rolled-back row');

        const commitStore = [];
        const commitFailure = new FakePgClient(commitStore, { failCommit: true });
        assert.equal(await importer(files, {
          createClient: () => commitFailure,
          logger: quietLogger,
        }), 1);
        assert.deepEqual(commitStore, []);
        assert.ok(commitFailure.calls.includes('ROLLBACK'));
      }
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('rejects missing and placeholder bearer tokens without printing the value', () => {
    assert.equal(validateBearerToken('Alpha', '  real-secret  '), 'real-secret');
    assert.throws(() => validateBearerToken('Alpha', ''), /bearer token is missing/);
    assert.throws(() => validateBearerToken('Alpha', 'CHANGE-ME'), /placeholder text/);
  });

  it('checks expected node version and full-or-short commit', () => {
    const status = statusResponse();
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
    assert.throws(() => requireJenkinsBuildExpectation('', true), /EXPECTED_NODE_COMMIT is required in Jenkins/);
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
    assert.throws(() => validateConfirmedPublishIdentity({ kaId: 17 }), /valid DKG UAL/);
    assert.throws(
      () => validateConfirmedPublishIdentity({ kaId: 17, ual: 'https://example.com/stale' }),
      /valid DKG UAL/,
    );
  });

  it('accepts only clean HTTP 200/201 lifecycle responses', () => {
    for (const httpStatus of [200, 201]) {
      const response = { status: 'vm-confirmed', errors: [] };
      assert.equal(requireCompleteLifecyclePublishResponse(httpStatus, response), response);
    }
    assert.throws(
      () => requireCompleteLifecyclePublishResponse(201, {
        status: 'vm-confirmed',
        errors: [{ message: 'storage acknowledgement failed' }],
      }),
      /response reported 1 error\(s\)/,
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
      swmCleanupSuccess: 2, swmCleanupFail: 0,
      querySuccess: 2, queryFail: 0,
      vmGetSuccess: 2, vmGetFail: 0,
      queryRemoteSuccess: 0, queryRemoteFail: 2,
    };
    assert.doesNotThrow(() => assertCompleteNodeRun('Alpha', stats, 2, false));
    assert.throws(() => assertCompleteNodeRun('Alpha', stats, 2, true), /Query Remote \(sync\): expected 2 success \/ 0 fail/);
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

  it('aborts at the in-process run deadline and rejects impossible batch delays', async () => {
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
    await assert.rejects(
      waitForBatchDelay(5000, Date.now() + 100, 'Alpha'),
      (error) => error.code === 'RUN_DEADLINE' && /inter-KA batch delay/.test(error.message),
    );
  });

  it('defaults remote verification off and validates both local reads target the fresh publish', async () => {
    const { handler, state } = createStrictLifecycleRouter();
    const result = await withMockNodeServer(handler, (baseUrl) => runPublishSpec({
      baseUrl,
      unsetEnv: ['V10_ENABLE_REMOTE_QUERY'],
      prefix: 'dkg-publish-default-local-only-',
    }));

    assert.equal(result.exitCode, 0, result.output);
    assert.equal(state.publishBodies.length, 1);
    assert.equal(state.localQueryBodies.length, 2);
    assert.equal(state.swmQueryBodies.length, 1);
    assert.equal(state.remoteQueryBodies.length, 0);
    assert.ok(state.publishedRoot?.startsWith('urn:ka:sbb-'));
    for (const body of state.localQueryBodies) {
      assert.equal(body.contextGraphId, EXPECTED_CONTEXT_GRAPH);
      assert.equal(body.view, 'verifiable-memory');
      assert.match(body.sparql, new RegExp(state.publishedRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.equal(state.swmQueryBodies[0].contextGraphId, EXPECTED_CONTEXT_GRAPH);
    assert.equal(state.swmQueryBodies[0].view, 'shared-working-memory');
    assert.match(
      state.swmQueryBodies[0].sparql,
      new RegExp(state.publishedRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.equal(result.summary.harness_error, null);
    assert.equal(result.summary.remote_query_enabled, false);
    assert.equal(result.summary.publish_success_rate, '100.00');
    assert.equal(result.summary.shared_working_memory_cleanup_success_rate, '100.00');
    assert.equal(result.summary.query_success_rate, '100.00');
    assert.equal(result.summary.publisher_get_success_rate, '100.00');
    assert.equal(result.summary.non_publisher_get_success_rate, null);
    assert.equal(result.summary.average_non_publisher_get_time, null);
    assert.match(result.output, /Query Remote \(sync\) skipped — not part of this release gate/);
  });

  it('counts a clean HTTP 200 vm-confirmed lifecycle as a successful publish', async () => {
    const { handler, state } = createStrictLifecycleRouter({ publishHttpStatus: 200 });
    const result = await withMockNodeServer(handler, (baseUrl) => runPublishSpec({
      baseUrl,
      prefix: 'dkg-publish-clean-200-',
    }));

    assert.equal(result.exitCode, 0, result.output);
    assert.equal(state.publishBodies.length, 1);
    assert.equal(state.localQueryBodies.length, 2);
    assert.equal(state.swmQueryBodies.length, 1);
    assert.equal(result.summary.publish_success_rate, '100.00');
    assert.equal(result.summary.shared_working_memory_cleanup_success_rate, '100.00');
    assert.equal(result.summary.query_success_rate, '100.00');
    assert.equal(result.summary.publisher_get_success_rate, '100.00');
  });

  it('does not count HTTP 207 vm-confirmed responses with errors as successful publishes', async () => {
    const { handler, state } = createStrictLifecycleRouter({
      publishHttpStatus: 207,
      publishResponse: {
        errors: [{ message: 'context graph binding failed after mint' }],
        contextGraphError: 'context graph binding failed after mint',
      },
    });
    const result = await withMockNodeServer(handler, (baseUrl) => runPublishSpec({
      baseUrl,
      prefix: 'dkg-publish-partial-207-',
    }));

    assert.equal(result.exitCode, 1, result.output);
    assert.equal(state.publishBodies.length, 1);
    assert.equal(state.localQueryBodies.length, 0);
    assert.equal(state.swmQueryBodies.length, 0);
    assert.equal(result.summary.publish_success_rate, '0.00');
    assert.equal(result.summary.shared_working_memory_cleanup_success_rate, '0.00');
    assert.equal(result.summary.query_success_rate, '0.00');
    assert.equal(result.summary.publisher_get_success_rate, '0.00');
    assert.match(result.output, /HTTP 207 indicates partial lifecycle completion/);
    assert.match(result.output, /SERVER ERROR LOG - context graph binding failed after mint/);
    assert.doesNotMatch(result.output, /All assets processed successfully/);
  });

  it('fails when VM reads pass but the exact fresh root remains in shared working memory', async () => {
    const { handler, state } = createStrictLifecycleRouter({
      retainPublishedRootInSwm: true,
    });
    const result = await withMockNodeServer(handler, (baseUrl) => runPublishSpec({
      baseUrl,
      prefix: 'dkg-publish-swm-residue-',
    }));

    assert.equal(result.exitCode, 1, result.output);
    assert.equal(state.publishBodies.length, 1);
    assert.equal(state.swmQueryBodies.length, 1);
    assert.equal(state.localQueryBodies.length, 2);
    assert.equal(result.summary.publish_success_rate, '100.00');
    assert.equal(result.summary.query_success_rate, '100.00');
    assert.equal(result.summary.publisher_get_success_rate, '100.00');
    assert.equal(result.summary.shared_working_memory_cleanup_success_rate, '0.00');
    assert.match(result.output, /Shared Working Memory still contains 1 binding\(s\) for fresh root/);
    assert.match(result.summary.harness_error, /SWM cleanup: expected 1 success \/ 0 fail/);
    assert.doesNotMatch(result.output, /All assets processed successfully/);
  });

  it('requires exact fresh UAL, context graph, peer and lookup type for remote verification', async () => {
    const { handler, state } = createStrictLifecycleRouter();
    const result = await withMockNodeServer(handler, (baseUrl) => runPublishSpec({
      baseUrl,
      env: { V10_ENABLE_REMOTE_QUERY: 'true' },
      prefix: 'dkg-publish-success-',
    }));

    assert.equal(result.exitCode, 0, result.output);
    assert.equal(state.localQueryBodies.length, 2);
    assert.deepEqual(state.remoteQueryBodies, [{
      peerId: EXPECTED_PEER_ID,
      contextGraphId: EXPECTED_CONTEXT_GRAPH,
      lookupType: 'ENTITY_BY_UAL',
      ual: FRESH_UAL,
    }]);
    assert.equal(result.summary.non_publisher_get_success_rate, '100.00');
    assert.match(result.output, /All assets processed successfully/);
  });

  it('fails the lifecycle when remote verification uses a stale UAL', async () => {
    const { handler, state } = createStrictLifecycleRouter({
      publishUal: STALE_UAL,
      requiredRemoteUal: FRESH_UAL,
    });
    const result = await withMockNodeServer(handler, (baseUrl) => runPublishSpec({
      baseUrl,
      env: { V10_ENABLE_REMOTE_QUERY: 'true' },
      prefix: 'dkg-publish-stale-ual-',
    }));

    assert.equal(result.exitCode, 1, result.output);
    assert.equal(state.remoteQueryBodies[0].ual, STALE_UAL);
    assert.equal(result.summary.non_publisher_get_success_rate, '0.00');
    assert.match(result.summary.harness_error, /Query Remote \(sync\).*expected 1 success \/ 0 fail/);
  });

  it('aborts a hanging HTTP publish, stops after one KA, checkpoints, and exits nonzero', async () => {
    let publishRequests = 0;
    let abortedPublishes = 0;
    const handler = (req, res) => {
      if (req.method === 'GET' && req.url === '/api/status') return json(res, 200, statusResponse());
      if (req.method === 'GET' && req.url === '/api/wallets') return json(res, 200, { wallets: ['0xfake'], chainId: '8453' });
      if (req.method === 'POST' && req.url === '/api/knowledge-assets') {
        publishRequests++;
        req.resume();
        req.on('aborted', () => { abortedPublishes++; });
        res.on('close', () => {
          if (!res.writableEnded && abortedPublishes === 0) abortedPublishes++;
        });
        return undefined;
      }
      return json(res, 404, { error: 'not found' });
    };
    const result = await withMockNodeServer(handler, (baseUrl) => runPublishSpec({
      baseUrl,
      env: {
        TEST_KA_BATCHES: '3',
        V10_OP_TIMEOUT_MS: '40',
        V10_PUBLISH_TIMEOUT_MS: '40',
      },
    }));

    assert.equal(result.exitCode, 1, result.output);
    assert.equal(publishRequests, 1);
    assert.equal(abortedPublishes, 1);
    assert.equal(result.summary.expected_ka_count, 3);
    assert.equal(result.summary.attempted_publish_count, 1);
    assert.equal(result.summary.publish_success_rate, '0.00');
    assert.match(result.output, /publish HTTP request was aborted; stopping remaining KAs/);
    assert.match(result.output, /Checkpointed summary in finally/);
  });

  it('rejects a confirmed response without a fresh UAL and never reads fallback data', async () => {
    let publishRequests = 0;
    let readRequests = 0;
    const handler = (req, res) => {
      if (req.method === 'GET' && req.url === '/api/status') return json(res, 200, statusResponse());
      if (req.method === 'GET' && req.url === '/api/wallets') return json(res, 200, { wallets: ['0xfake'], chainId: '8453' });
      if (req.method === 'POST' && req.url === '/api/knowledge-assets') {
        publishRequests++;
        return json(res, 201, { status: 'vm-confirmed', kaId: 17 });
      }
      if (req.method === 'POST' && (req.url === '/api/query' || req.url === '/api/query-remote')) readRequests++;
      return json(res, 404, { error: 'not found' });
    };
    const result = await withMockNodeServer(handler, (baseUrl) => runPublishSpec({
      baseUrl,
      env: { DKG_FALLBACK_UAL: 'did:dkg:base:8453/stale-data-must-not-be-read' },
      prefix: 'dkg-publish-missing-ual-',
    }));

    assert.equal(result.exitCode, 1, result.output);
    assert.equal(publishRequests, 1);
    assert.equal(readRequests, 0);
    assert.equal(result.summary.publish_success_rate, '0.00');
    assert.equal(result.summary.query_success_rate, '0.00');
    assert.match(result.output, /Confirmed publish response did not include a valid DKG UAL/);
    assert.match(result.output, /skipping reads.*publish produced no fresh UAL/i);
  });

  it('fails an overlong batch delay and checkpoints artifacts before the run cap', async () => {
    const { handler, state } = createStrictLifecycleRouter();
    const startedAt = Date.now();
    const result = await withMockNodeServer(handler, (baseUrl) => runPublishSpec({
      baseUrl,
      env: {
        TEST_KA_BATCHES: '2',
        TEST_BATCH_DELAY_MS: '5000',
        V10_RUN_TIMEOUT_MS: '1500',
      },
      prefix: 'dkg-publish-batch-deadline-',
    }));

    assert.equal(result.exitCode, 1, result.output);
    assert.ok(Date.now() - startedAt < 1500, 'impossible delay should fail before consuming the run budget');
    assert.equal(state.publishBodies.length, 1);
    assert.equal(result.summary.expected_ka_count, 2);
    assert.equal(result.summary.attempted_publish_count, 1);
    assert.match(result.summary.harness_error, /inter-KA batch delay/);
    assert.match(result.errors.harness_error, /inter-KA batch delay/);
    assert.match(result.output, /Checkpointed summary in finally/);
    assert.match(result.output, /Checkpointed errors in finally/);
  });

  it('checkpoints a wrong-deployment preflight with its cause', async () => {
    let publishRequests = 0;
    const handler = (req, res) => {
      if (req.method === 'GET' && req.url === '/api/status') return json(res, 200, statusResponse());
      if (req.method === 'POST' && req.url === '/api/knowledge-assets') publishRequests++;
      return json(res, 404, { error: 'not found' });
    };
    const result = await withMockNodeServer(handler, (baseUrl) => runPublishSpec({
      baseUrl,
      env: { EXPECTED_NODE_COMMIT: 'deadbee' },
      prefix: 'dkg-publish-wrong-build-',
    }));

    assert.equal(result.exitCode, 1, result.output);
    assert.equal(publishRequests, 0);
    assert.equal(result.summary.node_commit, 'abcdef1234567890');
    assert.match(result.summary.harness_error, /Node commit mismatch/);
    assert.equal(Object.keys(result.errors.detailed).length, 1);
    assert.match(Object.keys(result.errors.detailed)[0], /Harness stopped before workload: Node commit mismatch/);
    assert.match(result.output, /Checkpointed summary in finally/);
  });

  it('fails an incomplete or partially failed lifecycle run', () => {
    const complete = {
      publishSuccess: 2, publishFail: 0,
      swmCleanupSuccess: 2, swmCleanupFail: 0,
      querySuccess: 2, queryFail: 0,
      vmGetSuccess: 2, vmGetFail: 0,
      queryRemoteSuccess: 2, queryRemoteFail: 0,
    };
    assert.doesNotThrow(() => assertCompleteNodeRun('Alpha', complete, 2, true));
    assert.throws(
      () => assertCompleteNodeRun('Alpha', { ...complete, publishSuccess: 1, publishFail: 1 }, 2, true),
      /publish: expected 2 success \/ 0 fail, got 1 success \/ 1 fail/,
    );
  });
});
