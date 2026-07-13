// ===========================================================================
// V10 multi-node publish/query lifecycle — a faithful port of the dkg.js V8
// per-chain specs to the V10 node HTTP API, using V10-native operation names.
//
// V10 operation vocabulary (what the node actually calls these):
//   1. publish            -> POST /api/knowledge-assets (one-call named-KA lifecycle:
//                            create + wm/write + wm/finalize + swm/share + vm/publish;
//                            the direct /publish route was removed in v10.0.3, PR #1275)
//   2. query              -> POST /api/query  view=verifiable-memory  (broad SPARQL read)
//   3. VM GET            -> POST /api/query  view=verifiable-memory, scoped to the published
//                            entity, on the SAME node (Verifiable-Memory read-back)
//   4. Query Remote (sync)-> POST /api/query-remote { peerId, lookupType:ENTITY_TRIPLES }
//                            against ANOTHER node's peerId — reads the entity back from a
//                            peer over /dkg/10.0.1/query-remote. The cross-node SYNC test.
//
// V8 vs V10 — the only behavioural difference: V8 signed client-side with a
// per-node PRIVATE KEY; V10 nodes sign INTERNALLY from their own op-wallet pool,
// driven by the HTTP API + a per-node BEARER TOKEN. We record the
// `publisherAddress` the node returns per publish instead of choosing the wallet.
//
// The summary_<Node>.json fields keep their V8 column names so the Grafana
// Postgres import stays byte-identical. They map to the V10 ops as:
//   publish_success_rate            <- publish
//   query_success_rate              <- query
//   publisher_get_success_rate      <- VM GET
//   non_publisher_get_success_rate  <- Query Remote (sync)
// ===========================================================================

import { strict as assert } from 'assert';
import 'dotenv/config';
import fs from 'fs';
import {
  longFetch,
  buildQuads,
  formatDuration,
  logError,
  summarizeCause,
  HTTP_TIMEOUT_MS,
  TEST_ENTITY_COUNT,
  TEST_CONTENT_SIZE_KB,
  TEST_KA_BATCHES,
  TEST_BATCH_DELAY_MS,
} from './v10-helpers.js';

const PUBLISH_EPOCHS = Number(process.env.PUBLISH_EPOCHS || 2);
const KA_COUNT = TEST_KA_BATCHES;
const OP_TIMEOUT_MS = Number(process.env.V10_OP_TIMEOUT_MS || 6 * 60 * 1000);
// publish must outlast the node's ACK collection (~8 min worst case) so the
// 207 with the node's real error (storage_ack_insufficient, ...) arrives
// instead of a client-side timeout that hides it.
const PUBLISH_TIMEOUT_MS = Math.max(OP_TIMEOUT_MS, Number(process.env.V10_PUBLISH_TIMEOUT_MS || 11 * 60 * 1000));

// Context-graph provisioning. Publishing to Verifiable Memory needs the CG to be
// registered on-chain. V10_CG_REGISTER=true registers a fresh CG (~100 TRAC on the
// node wallet); false assumes DKG_CONTEXT_GRAPH_ID already exists + is registered.
const CG_REGISTER = String(process.env.V10_CG_REGISTER || 'false').toLowerCase() === 'true';
const CG_ACCESS_POLICY = Number(process.env.V10_CG_ACCESS_POLICY || 0);
const CG_PUBLISH_POLICY = Number(process.env.V10_CG_PUBLISH_POLICY || 1);
// PRIVATE-CG support. A private (non-public) CG is not globally resolvable: a node
// that doesn't host it can't validate the contextGraphId and rejects the write with
// "ontology/agents definition scan exceeded listContextGraphs budget". Setting
// V10_CG_SUBSCRIBE=true makes each publishing node subscribe to the CG first — it
// syncs the CG (definition + allowlist) from the curator, then "knows" it and can
// publish. Requires the curator node to be reachable on the DKG network. Leave
// false for public open-publish CGs (sports/foodie-network), which need no sync.
const CG_SUBSCRIBE = String(process.env.V10_CG_SUBSCRIBE || 'false').toLowerCase() === 'true';
const CG_SUBSCRIBE_TIMEOUT_MS = Number(process.env.V10_CG_SUBSCRIBE_TIMEOUT_MS || 90000);

// Read-back resilience: a publish can confirm on-chain before VM indexing is
// visible, so reads retry before failing. Every read still targets this run's
// fresh UAL/root; historical fallback data is never accepted as evidence.
const READ_RETRIES = Number(process.env.V10_READ_RETRIES || 4);
const READ_RETRY_MS = Number(process.env.V10_READ_RETRY_MS || 3000);
const READ_TOTAL_TIMEOUT_MS = Number(process.env.V10_READ_TOTAL_TIMEOUT_MS || 90 * 1000);
const PREFLIGHT_TIMEOUT_MS = Number(process.env.V10_PREFLIGHT_TIMEOUT_MS || 30 * 1000);
// Jenkins caps the entire job (checkout + install + tests + DB import) at 15m.
// Stop the in-process workload at 11m so finally/report/import still have room.
const RUN_TIMEOUT_MS = Number(process.env.V10_RUN_TIMEOUT_MS || 11 * 60 * 1000);
const EXPECTED_NODE_VERSION = String(process.env.EXPECTED_NODE_VERSION || '').trim();
const EXPECTED_NODE_COMMIT = String(process.env.EXPECTED_NODE_COMMIT || '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Publish timeouts must cancel the HTTP request itself. A Promise.race-only
// timeout leaves the server request and socket alive, so the harness can start
// KA N+1 while KA N is still mutating the same node. This helper waits for
// undici to acknowledge the abort before returning the timeout to the caller.
export async function withAbortTimeout(operation, label, nodeName, timeoutMs) {
  const controller = new AbortController();
  const timeoutError = new Error(
    `Timeout after ${Math.round(timeoutMs / 60000)} minutes during "${label}" on ${nodeName}; HTTP request aborted`,
  );
  timeoutError.code = label === 'publish' ? 'PUBLISH_HTTP_TIMEOUT' : 'HTTP_TIMEOUT';
  timeoutError.publishTimeout = label === 'publish';

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
  }, timeoutMs);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function withRunDeadline(
  operation,
  label,
  nodeName,
  operationTimeoutMs,
  runDeadline,
) {
  const remainingMs = runDeadline - Date.now();
  if (remainingMs <= 0) {
    const error = new Error(`Jenkins run deadline reached before "${label}" on ${nodeName}`);
    error.code = 'RUN_DEADLINE';
    error.runDeadline = true;
    throw error;
  }
  const runDeadlineIsLimit = remainingMs <= operationTimeoutMs;
  try {
    return await withAbortTimeout(
      operation,
      label,
      nodeName,
      Math.min(operationTimeoutMs, remainingMs),
    );
  } catch (error) {
    if (
      runDeadlineIsLimit &&
      (error?.code === 'HTTP_TIMEOUT' || error?.code === 'PUBLISH_HTTP_TIMEOUT')
    ) {
      error.code = 'RUN_DEADLINE';
      error.runDeadline = true;
    }
    throw error;
  }
}

export function requireJenkinsBuildExpectation(
  expectedCommit,
  isJenkins = Boolean(process.env.JENKINS_URL || process.env.JENKINS_HOME || process.env.BUILD_TAG),
) {
  if (!isJenkins) return;
  assert.ok(
    String(expectedCommit || '').trim(),
    'EXPECTED_NODE_COMMIT is required in Jenkins so the test cannot run against an unverified deployment',
  );
}

const PLACEHOLDER_TOKEN = /REPLACE|CHANGE-?ME|placeholder|TODO|XXXX|FROM_OT/i;

export function selectSingleNode(nodes, requestedNode) {
  const nodeName = String(requestedNode || '').trim();
  assert.ok(
    nodeName,
    `NODE_TO_TEST is required; choose exactly one of: ${nodes.map((node) => node.name).join(', ')}`,
  );
  const matches = nodes.filter((node) => node.name === nodeName);
  assert.equal(
    matches.length,
    1,
    `NODE_TO_TEST="${nodeName}" matched ${matches.length} nodes; choose exactly one of: ${nodes.map((node) => node.name).join(', ')}`,
  );
  return matches[0];
}

export function validateBearerToken(nodeName, token) {
  const trimmedToken = token ? String(token).trim() : '';
  assert.ok(
    trimmedToken,
    `${nodeName} bearer token is missing; the Jenkins credential is empty or not bound to this stage`,
  );
  assert.ok(
    !PLACEHOLDER_TOKEN.test(trimmedToken),
    `${nodeName} bearer token is placeholder text; replace the Jenkins credential with the real token`,
  );
  return trimmedToken;
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v(?=\d)/i, '');
}

function normalizeCommit(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateNodeBuild(status, expectedVersion = '', expectedCommit = '') {
  const actualVersion = normalizeVersion(status?.version);
  const actualCommit = normalizeCommit(status?.commit || status?.commitShort);
  const wantedVersion = normalizeVersion(expectedVersion);
  const wantedCommit = normalizeCommit(expectedCommit);

  assert.ok(actualVersion, 'Node /api/status did not report a version');
  if (wantedVersion) {
    assert.equal(
      actualVersion,
      wantedVersion,
      `Node version mismatch: expected ${expectedVersion}, got ${status?.version || '(missing)'}`,
    );
  }
  if (wantedCommit) {
    assert.match(
      wantedCommit,
      /^[0-9a-f]{7,40}$/,
      `EXPECTED_NODE_COMMIT must be a 7-40 character hexadecimal Git commit, got ${expectedCommit}`,
    );
    assert.match(
      actualCommit,
      /^[0-9a-f]{7,40}$/,
      `Node /api/status did not report a valid Git commit (got ${status?.commit || status?.commitShort || '(missing)'})`,
    );
    assert.ok(
      actualCommit && (actualCommit.startsWith(wantedCommit) || wantedCommit.startsWith(actualCommit)),
      `Node commit mismatch: expected ${expectedCommit}, got ${status?.commit || status?.commitShort || '(missing)'}`,
    );
  }

  return {
    version: status.version,
    commit: status.commit || status.commitShort || null,
    storeBackend: status.storeBackend || 'unknown',
  };
}

export function validateConfirmedPublishIdentity(result) {
  const kaId = String(result?.kaId ?? '').trim();
  const ual = String(result?.ual ?? '').trim();
  assert.match(kaId, /^[1-9]\d*$/, `Publish response missing valid positive-decimal kaId (got ${result?.kaId})`);
  assert.match(ual, /^did:dkg:[^\s]+$/, 'Confirmed publish response did not include a valid DKG UAL for this run');
  return { kaId, ual };
}

export function assertCompleteNodeRun(nodeName, stats, expectedKas, expectsRemote = true) {
  const expected = [
    ['publish', stats.publishSuccess, stats.publishFail, expectedKas],
    ['query', stats.querySuccess, stats.queryFail, expectedKas],
    ['VM GET', stats.vmGetSuccess, stats.vmGetFail, expectedKas],
  ];
  if (expectsRemote) {
    expected.push(['Query Remote (sync)', stats.queryRemoteSuccess, stats.queryRemoteFail, expectedKas]);
  }

  const violations = expected
    .filter(([, success, fail, count]) => success !== count || fail !== 0)
    .map(([operation, success, fail, count]) => `${operation}: expected ${count} success / 0 fail, got ${success} success / ${fail} fail`);
  assert.equal(
    violations.length,
    0,
    `${nodeName} lifecycle run was incomplete:\n${violations.map((line) => ` - ${line}`).join('\n')}`,
  );
}

export function completionRate(success, expected) {
  if (!Number.isFinite(expected) || expected <= 0) return '0.00';
  return ((success / expected) * 100).toFixed(2);
}

// Run a read until it returns data (publish→VM indexing lags a few seconds) or
// the retry budget is exhausted. Returns the last result either way; the caller
// asserts on queryHasData.
async function readWithRetry(label, nodeName, fn, runDeadline) {
  let lastErr, lastResult;
  const deadline = Math.min(Date.now() + READ_TOTAL_TIMEOUT_MS, runDeadline);
  for (let attempt = 0; attempt <= READ_RETRIES; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      lastResult = await withRunDeadline(
        fn,
        label,
        nodeName,
        Math.min(OP_TIMEOUT_MS, remainingMs),
        runDeadline,
      );
      if (queryHasData(lastResult)) return lastResult;
    } catch (err) {
      if (err?.runDeadline) throw err;
      lastErr = err;
    }
    if (attempt < READ_RETRIES) {
      const retryDelayMs = Math.min(READ_RETRY_MS, Math.max(0, deadline - Date.now()));
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  if (lastErr) throw lastErr;
  return lastResult;
}

// ---------------------------------------------------------------------------
// Per-node HTTP client. Each node has its OWN base URL + bearer token; the node
// signs internally. /api/status is public; writes + query-remote need the token.
// ---------------------------------------------------------------------------
export function makeNodeClient(baseUrl, token) {
  async function req(method, path, body, { acceptStatuses, signal } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    // trim: a pasted token can carry a trailing newline/space which makes the node reject it
    if (token) headers['Authorization'] = `Bearer ${String(token).trim()}`;
    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
    if (signal) opts.signal = signal;
    let res;
    try {
      res = await longFetch(`${baseUrl}${path}`, opts);
    } catch (e) {
      // "TypeError: fetch failed" hides the real transport error in e.cause —
      // surface it in the message so every log/summary shows the actual reason.
      const err = new Error(`${method} ${path} on ${baseUrl} got no HTTP response: ${summarizeCause(e) || e.message}`);
      err.cause = e.cause ?? e;
      err.network = true;
      throw err;
    }
    const data = await res.json().catch(() => ({ error: res.statusText }));
    const ok = acceptStatuses ? acceptStatuses.includes(res.status) : res.ok;
    if (!ok) {
      const err = new Error(data.error || data.contextGraphError || `HTTP ${res.status}`);
      err.statusCode = res.status;
      err.body = data;
      throw err;
    }
    return { status: res.status, data };
  }
  return {
    baseUrl,
    status: (signal) => req('GET', '/api/status', undefined, { signal }).then((r) => r.data),
    // the node's own operational wallet addresses (it signs publishes with these)
    wallets: (signal) => req('GET', '/api/wallets', undefined, { signal }).then((r) => r.data),
    // v10.0.3 removed POST /api/knowledge-assets/publish (PR #1275) — publishing
    // now goes through the named-KA lifecycle. The create route runs the whole
    // chain in ONE call (create + wm/write + wm/finalize + swm/share + vm/publish)
    // via alsoShareSwm/alsoPublishVm, and returns kaId/ual/txHash/authorAddress
    // with status "vm-confirmed". We map that back to the old response shape so
    // the summary/report code stays unchanged.
    publish: (contextGraphId, quads, signal) =>
      req(
        'POST',
        '/api/knowledge-assets',
        {
          contextGraphId,
          name: `jenkins-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          quads,
          alsoShareSwm: true,
          alsoPublishVm: { publishEpochs: PUBLISH_EPOCHS },
        },
        { acceptStatuses: [200, 201, 207], signal },
      ).then((r) => ({
        ...r.data,
        status: r.data.status === 'vm-confirmed' ? 'confirmed' : r.data.status,
        publisherAddress: r.data.publisherAddress || r.data.authorAddress,
        httpStatus: r.status,
      })),
    query: (sparql, contextGraphId, view = 'verifiable-memory', signal) =>
      req('POST', '/api/query', { sparql, contextGraphId, view }, { signal }).then((r) => r.data),
    // cross-node read: ask a PEER (by peerId) for a KA's triples. lookup is
    // { lookupType, ual } for ENTITY_BY_UAL (resolves a UAL → triples; works for
    // any node's KA) or { lookupType:'ENTITY_TRIPLES', entityUri } for an entity.
    queryRemote: (peerId, contextGraphId, lookup, signal) =>
      req('POST', '/api/query-remote', {
        peerId,
        contextGraphId,
        lookupType: lookup.lookupType || 'ENTITY_TRIPLES',
        ...(lookup.ual ? { ual: lookup.ual } : {}),
        ...(lookup.entityUri ? { entityUri: lookup.entityUri } : {}),
      }, { signal }).then((r) => r.data),
    // create (and optionally on-chain register) the context graph to publish into
    createContextGraph: (id, name, description, opts = {}, signal) =>
      req('POST', '/api/context-graph/create', {
        id, name, description,
        accessPolicy: opts.accessPolicy ?? 0,
        publishPolicy: opts.publishPolicy ?? 1,
        register: opts.register ?? false,
      }, { signal }).then((r) => r.data),
    // on-chain register an EXISTING (already locally-created) context graph.
    // create(register:true) only registers when it also creates; an existing CG
    // 409s there, so this standalone call is the path to register it on-chain.
    registerContextGraph: (id, opts = {}, signal) =>
      req('POST', '/api/context-graph/register', {
        id,
        accessPolicy: opts.accessPolicy ?? 0,
        publishPolicy: opts.publishPolicy ?? 1,
      }, { signal }).then((r) => r.data),
    // subscribe to (and sync) a context graph this node does not host. Returns
    // { subscribed, catchup: { status: queued|running|done, jobId } }. Re-calling
    // returns the current catchup status, so it doubles as a poll.
    subscribe: (contextGraphId, includeSharedMemory = true, signal) =>
      req('POST', '/api/context-graph/subscribe', { contextGraphId, includeSharedMemory }, { acceptStatuses: [200, 202], signal }).then((r) => r.data),
  };
}

// Subscribe a node to a private CG and wait until its catch-up sync reports done
// (or timeout). Idempotent: a node already synced returns done immediately.
async function subscribeAndWait(client, contextGraphId, nodeName, timeoutMs, runDeadline) {
  const deadline = Math.min(Date.now() + timeoutMs, runDeadline);
  let last = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res;
    try {
      res = await withRunDeadline(
        (signal) => client.subscribe(contextGraphId, true, signal),
        'context-graph subscribe',
        nodeName,
        Math.min(PREFLIGHT_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        runDeadline,
      );
    } catch (error) {
      if (error?.runDeadline) throw error;
      const wrapped = new Error(
        `subscribe to "${contextGraphId}" on ${nodeName} failed: ${error.message}`,
        { cause: error },
      );
      wrapped.code = error?.code;
      throw wrapped;
    }
    const status = res?.catchup?.status || 'unknown';
    if (status !== last) {
      console.log(`   ↪ ${nodeName} subscribe/catchup: ${status}`);
      last = status;
    }
    if (status === 'done') return res;
    if (status === 'failed' || status === 'error') {
      throw new Error(`catch-up sync for "${contextGraphId}" on ${nodeName} reported ${status}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`catch-up sync for "${contextGraphId}" on ${nodeName} did not finish within ${timeoutMs}ms (last status: ${status}) — is the curator node reachable on the DKG network?`);
    }
    await sleep(3000);
  }
}

function queryHasData(result) {
  if (!result) return false;
  if (typeof result.resultCount === 'number') return result.resultCount > 0;
  if (Array.isArray(result)) return result.length > 0;
  if (Array.isArray(result.data)) return result.data.length > 0;
  if (Array.isArray(result.results)) return result.results.length > 0;
  if (result.data && Array.isArray(result.data.results)) return result.data.results.length > 0;
  if (Array.isArray(result.triples)) return result.triples.length > 0;
  // SPARQL SELECT response: { result: { bindings: [...] } }
  if (result.result && Array.isArray(result.result.bindings)) return result.result.bindings.length > 0;
  // query-remote ENTITY_BY_UAL response: { status:'OK', ntriples:'<s> <p> <o> .' }
  if (typeof result.ntriples === 'string') return result.ntriples.trim().length > 0;
  return false;
}

// Resolve (and cache) a node's libp2p peerId via its public /api/status.
const peerIdCache = new Map();
async function getPeerId(node, signal) {
  if (peerIdCache.has(node.hostname)) return peerIdCache.get(node.hostname);
  const status = await makeNodeClient(node.hostname, node.token).status(signal);
  const pid = status && status.peerId;
  if (pid) peerIdCache.set(node.hostname, pid);
  return pid;
}

const mean = (arr) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

// ---------------------------------------------------------------------------
// Register the per-chain describe/it suite.
//   config = { title, blockchainName, contextGraphId, nodes:[{name,hostname,token}] }
// NODE_TO_TEST (env) must select exactly one node for this Jenkins stage.
// ---------------------------------------------------------------------------
export function defineChainPublishSuite(config) {
  const { title, blockchainName, contextGraphId, nodes } = config;

  const globalStats = { [blockchainName]: {} };
  const errorStats = {};

  describe(title, function () {
    this.timeout(130 * 60 * 1000);

    it('should complete every lifecycle operation for the selected node', async () => {
      const selectedNode = selectSingleNode(nodes, process.env.NODE_TO_TEST);
      const nodesToRun = [selectedNode];

      console.log(`\nRunning test for node: ${nodesToRun.map((n) => n.name).join(', ')}`);
      console.log(`Blockchain: ${blockchainName} | Context graph: ${contextGraphId} | KAs per node: ${KA_COUNT}`);

      for (let currentIndex = 0; currentIndex < nodesToRun.length; currentIndex++) {
        const { name, hostname, token } = nodesToRun[currentIndex];

        let publishSuccess = 0, publishFail = 0;
        let querySuccess = 0, queryFail = 0;
        let vmGetSuccess = 0, vmGetFail = 0;
        let queryRemoteSuccess = 0, queryRemoteFail = 0;

        // durations record ONLY SUCCESSFUL operations — a failed attempt's
        // latency is time-to-error (timeouts, refused sockets), not operation
        // speed, and averaging it in fabricates an "avg publish time" even on
        // 0%-success runs. With zero successes the average is null and the DB
        // row stores SQL NULL, so Grafana shows "No data" instead of a number.
        const publishDurations = [];
        const queryDurations = [];
        const vmGetDurations = [];
        const queryRemoteDurations = [];
        const failedAssets = [];
        const publisherAddresses = new Set();

        let nodeWalletAddrs = [];
        let nodeBuild = { version: null, commit: null, storeBackend: 'unknown' };
        let firstPayload = null;
        let client = null;
        let harnessError = null;
        const runDeadline = Date.now() + RUN_TIMEOUT_MS;

        try {
          const trimmedToken = validateBearerToken(name, token);
          client = makeNodeClient(hostname, trimmedToken);
          assert.ok(Number.isInteger(KA_COUNT) && KA_COUNT > 0, `TEST_KA_BATCHES must be a positive integer, got ${KA_COUNT}`);
          assert.ok(Number.isInteger(TEST_ENTITY_COUNT) && TEST_ENTITY_COUNT >= 0, `TEST_ENTITY_COUNT must be a non-negative integer, got ${TEST_ENTITY_COUNT}`);
          assert.ok(Number.isFinite(TEST_CONTENT_SIZE_KB) && TEST_CONTENT_SIZE_KB >= 0, `TEST_CONTENT_SIZE_KB must be non-negative, got ${TEST_CONTENT_SIZE_KB}`);
          assert.ok(Number.isFinite(TEST_BATCH_DELAY_MS) && TEST_BATCH_DELAY_MS >= 0, `TEST_BATCH_DELAY_MS must be non-negative, got ${TEST_BATCH_DELAY_MS}`);
          assert.ok(Number.isFinite(OP_TIMEOUT_MS) && OP_TIMEOUT_MS > 0, `V10_OP_TIMEOUT_MS must be positive, got ${OP_TIMEOUT_MS}`);
          assert.ok(Number.isFinite(READ_TOTAL_TIMEOUT_MS) && READ_TOTAL_TIMEOUT_MS > 0, `V10_READ_TOTAL_TIMEOUT_MS must be positive, got ${READ_TOTAL_TIMEOUT_MS}`);
          assert.ok(Number.isFinite(PREFLIGHT_TIMEOUT_MS) && PREFLIGHT_TIMEOUT_MS > 0, `V10_PREFLIGHT_TIMEOUT_MS must be positive, got ${PREFLIGHT_TIMEOUT_MS}`);
          assert.ok(Number.isFinite(RUN_TIMEOUT_MS) && RUN_TIMEOUT_MS > 0, `V10_RUN_TIMEOUT_MS must be positive, got ${RUN_TIMEOUT_MS}`);
          assert.ok(Number.isFinite(HTTP_TIMEOUT_MS) && HTTP_TIMEOUT_MS > 0, `V10_HTTP_TIMEOUT_MS must be positive, got ${HTTP_TIMEOUT_MS}`);
          assert.ok(Number.isFinite(PUBLISH_TIMEOUT_MS) && PUBLISH_TIMEOUT_MS > 0, `V10_PUBLISH_TIMEOUT_MS must be positive, got ${PUBLISH_TIMEOUT_MS}`);
          assert.ok(
            PUBLISH_TIMEOUT_MS <= HTTP_TIMEOUT_MS,
            `Effective publish timeout (${PUBLISH_TIMEOUT_MS}ms) exceeds undici HTTP timeout (${HTTP_TIMEOUT_MS}ms); increase V10_HTTP_TIMEOUT_MS so the harness owns cancellation`,
          );

          requireJenkinsBuildExpectation(EXPECTED_NODE_COMMIT);
          console.log(`🔑 ${name} bearer token: ✅ present (length ${trimmedToken.length})`);
          const status = await withRunDeadline(
            (signal) => client.status(signal),
            'status preflight',
            name,
            PREFLIGHT_TIMEOUT_MS,
            runDeadline,
          );
          nodeBuild = {
            version: status?.version || null,
            commit: status?.commit || status?.commitShort || null,
            storeBackend: status?.storeBackend || 'unknown',
          };
          validateNodeBuild(status, EXPECTED_NODE_VERSION, EXPECTED_NODE_COMMIT);
          firstPayload = buildQuads(name, 1);
          const firstPayloadBytes = Buffer.byteLength(JSON.stringify(firstPayload.quads), 'utf8');

          console.log(`\n──────── Effective Jenkins publish configuration ────────`);
          console.log(`Node: ${name} | URL: ${hostname}`);
          console.log(`Node build: version=${nodeBuild.version} | commit=${nodeBuild.commit || 'unknown'} | store=${nodeBuild.storeBackend}`);
          console.log(`Expected build: version=${EXPECTED_NODE_VERSION || '(not enforced)'} | commit=${EXPECTED_NODE_COMMIT || '(not enforced)'}`);
          console.log(`Workload: KAs=${KA_COUNT} | entities/KA=${TEST_ENTITY_COUNT} | quads/first KA=${firstPayload.quads.length} | first payload=${firstPayloadBytes} bytes | target=${TEST_CONTENT_SIZE_KB} KB`);
          console.log(`Publish: epochs=${PUBLISH_EPOCHS} | batch delay=${TEST_BATCH_DELAY_MS}ms | CG register=${CG_REGISTER} | CG subscribe=${CG_SUBSCRIBE}`);
          console.log(`Timeouts: whole run=${RUN_TIMEOUT_MS}ms | publish=${PUBLISH_TIMEOUT_MS}ms | HTTP headers/body=${HTTP_TIMEOUT_MS}ms | read attempt=${OP_TIMEOUT_MS}ms | read total=${READ_TOTAL_TIMEOUT_MS}ms | CG subscribe=${CG_SUBSCRIBE_TIMEOUT_MS}ms`);
          console.log(`Read retry: retries=${READ_RETRIES} | delay=${READ_RETRY_MS}ms`);

        // Per-node wallet check. In V10 the NODE signs publishes internally with
        // its OWN operational wallets (loaded from that node's DKG_HOME), so each
        // node naturally publishes from a different wallet. Surface the address(es)
        // here — named by node — so each run proves which wallet the node uses and
        // that the nodes are not all signing from one shared wallet.
        try {
          const w = await withRunDeadline(
            (signal) => client.wallets(signal),
            'wallet preflight',
            name,
            PREFLIGHT_TIMEOUT_MS,
            runDeadline,
          );
          nodeWalletAddrs = Array.isArray(w?.wallets) ? w.wallets : [];
          console.log(`💳 ${name} operational wallet(s): ${nodeWalletAddrs.length ? nodeWalletAddrs.join(', ') : '(none reported)'}${w?.chainId ? ` | chainId ${w.chainId}` : ''}`);
        } catch (error) {
          if (error?.runDeadline) throw error;
          console.log(`💳 ${name} operational wallet(s): could not read /api/wallets (${error.message})`);
        }

        // Context-graph setup. Two modes:
        //   V10_CG_REGISTER=false (default) — publish into an EXISTING registered,
        //     open-publish CG (e.g. 'sports' on Base, 'foodie-network' on Gnosis).
        //     We do NOT create or register anything: calling create on an existing
        //     public CG would 409 (or worse, shadow it with a local unregistered
        //     copy), so we just publish straight into it.
        //   V10_CG_REGISTER=true — create + on-chain-register OUR OWN CG (~100 TRAC
        //     per chain). Needed only if you don't want to reuse a public CG.
        if (CG_REGISTER) {
          try {
            await withRunDeadline(
              (signal) => client.createContextGraph(
                contextGraphId, 'V10 Publish Test CG', 'Automated publish/query test context graph',
                { accessPolicy: CG_ACCESS_POLICY, publishPolicy: CG_PUBLISH_POLICY, register: true },
                signal,
              ),
              'context-graph create',
              name,
              CG_SUBSCRIBE_TIMEOUT_MS,
              runDeadline,
            );
          } catch (error) {
            if (error?.runDeadline || error?.code === 'HTTP_TIMEOUT') throw error;
            console.log(`Context graph create on ${name}: ${error.message} (may already exist, continuing)`);
          }
          try {
            const reg = await withRunDeadline(
              (signal) => client.registerContextGraph(
                contextGraphId,
                { accessPolicy: CG_ACCESS_POLICY, publishPolicy: CG_PUBLISH_POLICY },
                signal,
              ),
              'context-graph register',
              name,
              CG_SUBSCRIBE_TIMEOUT_MS,
              runDeadline,
            );
            console.log(`✅ Context graph "${contextGraphId}" registered on-chain on ${name}${reg.onChainId ? ` (on-chain ${reg.onChainId})` : ''}`);
          } catch (error) {
            if (error?.runDeadline || error?.code === 'HTTP_TIMEOUT') throw error;
            const already = /already registered/i.test(error.message);
            console.log(`${already ? '' : '⚠️  '}Context graph "${contextGraphId}" on-chain register on ${name}: ${error.message}${already ? ' (ok — already on-chain)' : ''}`);
          }
        } else {
          console.log(`Publishing into existing context graph "${contextGraphId}" on ${name} (no create/register; reuses a registered CG)`);
        }

        // Private/curated CGs must be synced to this node before it can validate/
        // publish into them (a public open-publish CG needs none of this). Auto-on
        // when the id is canonical ("<curator>/<slug>", contains '/') — bare public
        // names ('sports'/'foodie-network') skip it. V10_CG_SUBSCRIBE=true forces it.
        const needsSubscribe = CG_SUBSCRIBE
          || (typeof contextGraphId === 'string' && contextGraphId.includes('/'));
        if (needsSubscribe) {
          console.log(`🔗 ${name} subscribing to private CG "${contextGraphId}" (syncing from curator)…`);
          await subscribeAndWait(client, contextGraphId, name, CG_SUBSCRIBE_TIMEOUT_MS, runDeadline);
          console.log(`✅ ${name} synced CG "${contextGraphId}" — proceeding to publish`);
        }

        for (let i = 0; i < KA_COUNT; i++) {
          if (i > 0 && TEST_BATCH_DELAY_MS > 0) {
            console.log(`Waiting ${TEST_BATCH_DELAY_MS}ms before KA #${i + 1}`);
            await sleep(TEST_BATCH_DELAY_MS);
          }
          console.log(`\nPublishing KA #${i + 1} on ${name}`);
          const { quads, rootEntity } = i === 0 ? firstPayload : buildQuads(name, i + 1);
          console.log(`Payload: entities=${TEST_ENTITY_COUNT} | quads=${quads.length} | bytes=${Buffer.byteLength(JSON.stringify(quads), 'utf8')}`);

          let ual = null;
          let step = 'publish';
          let publishTimedOut = false;

          // ── 1. publish (mint to Verifiable Memory) ─────────────────────────
          const pubStart = Date.now();
          try {
            const result = await withRunDeadline(
              (signal) => client.publish(contextGraphId, quads, signal),
              'publish',
              name,
              PUBLISH_TIMEOUT_MS,
              runDeadline,
            );
            assert.ok(result, 'Publish returned no result');
            if (result.status !== 'confirmed') {
              // Test-side message stays SHORT; the node's own lifecycle error
              // (e.g. "storage_ack_insufficient: ...") rides on err.serverError
              // so logError prints it as the separate SERVER ERROR LOG line.
              const err = new Error(
                `Publish returned "${result.status}" instead of "confirmed" (kaId: ${result.kaId}, httpStatus: ${result.httpStatus})${result.error ? ` — ${result.error}` : ''}`,
              );
              if (Array.isArray(result.errors) && result.errors.length) {
                err.serverError = result.errors
                  .map((e) => (e && (e.message || e.error || JSON.stringify(e))))
                  .join(' | ');
              }
              throw err;
            }
            const publishIdentity = validateConfirmedPublishIdentity(result);
            ual = publishIdentity.ual;
            if (result.publisherAddress) publisherAddresses.add(result.publisherAddress);
            const kasCreated = Array.isArray(result.kas) ? result.kas.length : 'N/A';
            const txInfo = result.txHash ? ` | tx: ${result.txHash}` : '';
            const walletInfo = result.publisherAddress ? ` | wallet: ${result.publisherAddress}` : '';
            console.log(`✅ Published KA #${i + 1}${ual ? ` | UAL: ${ual}` : ''} | kaId: ${result.kaId} | KAs: ${kasCreated}${walletInfo}${txInfo}`);
            // The publish mints a Knowledge Collection of N KAs; each KA's UAL is
            // `${collectionUal}/${tokenId}`. Print the first 5 child KA UALs.
            const childKas = Array.isArray(result.kas) ? result.kas
              : (Array.isArray(result.kaManifest) ? result.kaManifest : []);
            if (ual && childKas.length) {
              const sample = childKas.slice(0, 5).map((ka) => `${ual}/${ka.tokenId}`);
              console.log(`   ↳ first ${sample.length} child KA UAL(s):`);
              sample.forEach((u) => console.log(`      ${u}`));
            }
            publishSuccess++;
            publishDurations.push(Date.now() - pubStart);
          } catch (error) {
            await logError(error, name, step, errorStats, i + 1, { baseUrl: client.baseUrl });
            console.log(`❌ Publish failed | No UAL`);
            failedAssets.push(`KA #${i + 1} (Publish failed)`);
            publishFail++;
            publishTimedOut = error?.publishTimeout === true;
            if (error?.runDeadline) throw error;
          }

          if (publishTimedOut) {
            console.log(`🛑 ${name}: publish HTTP request was aborted; stopping remaining KAs to prevent overlapping mutations`);
            break;
          }

          // Every read must prove this exact publish. Never substitute a known
          // historical UAL: stale data can make a broken lifecycle look green.
          if (!ual) {
            console.log(`⏭️  ${name}: skipping reads for KA #${i + 1}; publish produced no fresh UAL`);
            continue;
          }

          // ── 2. query — SELECT this KA's child entities (via isPartOf) from VM ─
          step = 'query';
          const queryStart = Date.now();
          try {
            const sparql = `SELECT ?s ?name WHERE { ?s <http://schema.org/isPartOf> <${rootEntity}> ; <http://schema.org/name> ?name } LIMIT 5`;
            const result = await readWithRetry(
              'query',
              name,
              (signal) => client.query(sparql, contextGraphId, 'verifiable-memory', signal),
              runDeadline,
            );
            assert.ok(queryHasData(result), 'Query returned empty results');
            console.log(`✅ Query succeeded`);
            querySuccess++;
            queryDurations.push(Date.now() - queryStart);
          } catch (error) {
            await logError(error, name, step, errorStats, i + 1, { baseUrl: client.baseUrl });
            failedAssets.push(`KA #${i + 1} (Query failed)`);
            queryFail++;
            if (error?.runDeadline) throw error;
          }

          // ── 3. VM GET — get THIS KA's root entity triples from local VM ──────
          step = 'VM GET';
          const vmGetStart = Date.now();
          try {
            const entitySparql = `SELECT ?p ?o WHERE { <${rootEntity}> ?p ?o } LIMIT 5`;
            const result = await readWithRetry(
              'VM GET',
              name,
              (signal) => client.query(entitySparql, contextGraphId, 'verifiable-memory', signal),
              runDeadline,
            );
            assert.ok(queryHasData(result), 'VM GET returned empty results');
            console.log(`✅ VM GET succeeded`);
            vmGetSuccess++;
            vmGetDurations.push(Date.now() - vmGetStart);
          } catch (error) {
            await logError(error, name, step, errorStats, i + 1, { baseUrl: client.baseUrl });
            failedAssets.push(`KA #${i + 1} (VM GET failed)`);
            vmGetFail++;
            if (error?.runDeadline) throw error;
          }

          // ── 4. Query Remote (sync) — read the KA back from a PEER by UAL ────
          step = 'Query Remote (sync)';
          const otherIndexes = nodes.map((_, idx) => idx).filter((idx) => nodes[idx].name !== name);
          if (otherIndexes.length === 0) {
            // single-node chain — no peer to sync-check against
            continue;
          }
          const remoteNode = nodes[otherIndexes[Math.floor(Math.random() * otherIndexes.length)]];
          const remoteStart = Date.now();
          try {
            const result = await readWithRetry(
              'Query Remote (sync)',
              remoteNode.name,
              async (signal) => {
                const remotePeerId = await getPeerId(remoteNode, signal);
                if (!remotePeerId) throw new Error(`Could not resolve peerId for ${remoteNode.name} (${remoteNode.hostname})`);
                return client.queryRemote(
                  remotePeerId,
                  contextGraphId,
                  { lookupType: 'ENTITY_BY_UAL', ual },
                  signal,
                );
              },
              runDeadline,
            );
            assert.ok(queryHasData(result), `Query Remote (sync) returned no triples for ${ual} from ${remoteNode.name}`);
            console.log(`✅ Query Remote (sync) succeeded — ${remoteNode.name} has the KA (synced)`);
            queryRemoteSuccess++;
            queryRemoteDurations.push(Date.now() - remoteStart);
          } catch (error) {
            await logError(error, name, step, errorStats, i + 1, { baseUrl: client.baseUrl });
            failedAssets.push(`KA #${i + 1} (Query Remote (sync) failed)`);
            queryRemoteFail++;
            if (error?.runDeadline) throw error;
          }
        }

        assertCompleteNodeRun(
          name,
          {
            publishSuccess, publishFail,
            querySuccess, queryFail,
            vmGetSuccess, vmGetFail,
            queryRemoteSuccess, queryRemoteFail,
          },
          KA_COUNT,
          nodes.length > 1,
        );
        } catch (error) {
          harnessError = error;
          throw error;
        } finally {

        // null (not 0) when nothing succeeded — "0s avg" would read as instant
        // success and the DB/Grafana layer needs NULL to show "No data".
        const avgPublishMs = publishDurations.length ? mean(publishDurations) : null;
        const avgQueryMs = queryDurations.length ? mean(queryDurations) : null;
        const avgVmGetMs = vmGetDurations.length ? mean(vmGetDurations) : null;
        const avgQueryRemoteMs = queryRemoteDurations.length ? mean(queryRemoteDurations) : null;

        console.log(`\n──────────── Summary for ${name} ────────────`);
        if (failedAssets.length > 0) {
          console.log(`🔍 Failed Assets:`);
          failedAssets.forEach((entry) => console.log(`  - ${entry}`));
        } else if (harnessError) {
          console.log(`❌ Harness stopped before completing the workload: ${harnessError.message}`);
        } else if (publishSuccess === KA_COUNT && publishFail === 0) {
          console.log(`✅ All assets processed successfully`);
        } else {
          console.log(`❌ Harness stopped after ${publishSuccess + publishFail}/${KA_COUNT} publish attempts`);
        }
        if (publisherAddresses.size > 0) {
          console.log(`💳 Node published with wallet(s): ${[...publisherAddresses].join(', ')}`);
        }

        globalStats[blockchainName][name] = {
          publishSuccess, publishFail,
          querySuccess, queryFail,
          vmGetSuccess, vmGetFail,
          queryRemoteSuccess, queryRemoteFail,
          avgPublishMs, avgQueryMs, avgVmGetMs, avgQueryRemoteMs,
        };

        const summary = {
          blockchain_name: blockchainName,
          node_name: name,
          node_version: nodeBuild.version,
          node_commit: nodeBuild.commit,
          store_backend: nodeBuild.storeBackend,
          node_wallet: nodeWalletAddrs.join(', '),
          node_publisher_wallets: [...publisherAddresses].join(', '),
          expected_ka_count: KA_COUNT,
          attempted_publish_count: publishSuccess + publishFail,
          harness_error: harnessError?.message || null,
          // Denominator is the configured workload, not merely attempted ops:
          // skipped reads after a failed publish must lower Grafana's rate.
          publish_success_rate: completionRate(publishSuccess, KA_COUNT),
          query_success_rate: completionRate(querySuccess, KA_COUNT),
          publisher_get_success_rate: completionRate(vmGetSuccess, KA_COUNT),                 // VM GET
          non_publisher_get_success_rate: completionRate(queryRemoteSuccess, nodes.length > 1 ? KA_COUNT : 0),   // Query Remote (sync)
          average_publish_time: avgPublishMs === null ? null : (avgPublishMs / 1000).toFixed(2),
          average_query_time: avgQueryMs === null ? null : (avgQueryMs / 1000).toFixed(2),
          average_publisher_get_time: avgVmGetMs === null ? null : (avgVmGetMs / 1000).toFixed(2),
          average_non_publisher_get_time: avgQueryRemoteMs === null ? null : (avgQueryRemoteMs / 1000).toFixed(2),
          time_stamp: new Date().toISOString(),
        };
        const summaryFileName = `summary_${name.replace(/\s+/g, '_')}.json`;
        fs.writeFileSync(summaryFileName, JSON.stringify(summary, null, 2));
        console.log(`✅ Checkpointed summary in finally to ${summaryFileName}`);

        const nodeErrors = errorStats[name] || { aggregated: {}, detailed: {}, services: {} };
        const aggregatedErrors = { ...(nodeErrors.aggregated || {}) };
        const detailedErrors = { ...(nodeErrors.detailed || {}) };
        const errorServices = { ...(nodeErrors.services || {}) };
        if (harnessError && Object.keys(detailedErrors).length === 0) {
          // The telemetry schema has operation-specific columns but no generic
          // harness column. Preserve preflight/config failures in the existing
          // publish-error stream instead of silently dropping their cause.
          const detailKey = `publish — Harness stopped before workload: ${harnessError.message} for KA #1`;
          const aggregateKey = `Harness stopped before workload: ${harnessError.message}`;
          detailedErrors[detailKey] = 1;
          aggregatedErrors[aggregateKey] = 1;
          errorServices[aggregateKey] = 'jenkins-harness';
        }
        const errorData = {
          blockchain_id: blockchainName,
          aggregated: aggregatedErrors,
          detailed: detailedErrors,
          services: errorServices,
          harness_error: harnessError?.message || null,
        };
        const errorsFileName = `errors_${name.replace(/\s+/g, '_')}.json`;
        fs.writeFileSync(errorsFileName, JSON.stringify(errorData, null, 2));
        console.log(`✅ Checkpointed errors in finally to ${errorsFileName}`);
        }
      }
    });

    after(() => {
      console.log(`\n\nGlobal Publish Summary:`);
      Object.entries(globalStats).forEach(([blockchain, nodeStats]) => {
        console.log(`\n🔗 Blockchain: ${blockchain}`);
        Object.entries(nodeStats).forEach(([nodeName, stats]) => {
          console.log(`  • ${nodeName}:`);
          console.log(`    Publish:             ✅ ${stats.publishSuccess} / ❌ ${stats.publishFail} -> ${completionRate(stats.publishSuccess, KA_COUNT)}% of workload`);
          console.log(`    Query:               ✅ ${stats.querySuccess} / ❌ ${stats.queryFail} -> ${completionRate(stats.querySuccess, KA_COUNT)}% of workload`);
          console.log(`    VM GET:             ✅ ${stats.vmGetSuccess} / ❌ ${stats.vmGetFail} -> ${completionRate(stats.vmGetSuccess, KA_COUNT)}% of workload`);
          console.log(`    Query Remote (sync): ✅ ${stats.queryRemoteSuccess} / ❌ ${stats.queryRemoteFail} -> ${completionRate(stats.queryRemoteSuccess, nodes.length > 1 ? KA_COUNT : 0)}% of workload`);
          console.log(`    Avg Publish Time:        ${formatDuration(stats.avgPublishMs)}`);
          console.log(`    Avg Query Time:          ${formatDuration(stats.avgQueryMs)}`);
          console.log(`    Avg VM GET Time:        ${formatDuration(stats.avgVmGetMs)}`);
          console.log(`    Avg Query Remote Time:   ${formatDuration(stats.avgQueryRemoteMs)}`);
        });
      });

      console.log(`\n\nError Breakdown by Node:`);
      Object.entries(errorStats).forEach(([nodeName, errors]) => {
        console.log(`\n${nodeName}`);
        if (errors.aggregated && Object.keys(errors.aggregated).length > 0) {
          Object.entries(errors.aggregated).forEach(([message, count]) => {
            const service = errors.services && errors.services[message] ? errors.services[message] : '';
            const serviceLabel = service ? ` [${service}]` : '';
            console.log(`  • ${count}x ${message}${serviceLabel}`);
          });
        } else {
          console.log(`  ✅ No errors`);
        }
      });
    });
  });
}
