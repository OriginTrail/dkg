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
  safeRate,
  formatDuration,
  logError,
  summarizeCause,
} from './v10-helpers.js';

const PUBLISH_EPOCHS = Number(process.env.PUBLISH_EPOCHS || 2);
const KA_COUNT = Number(process.env.TEST_KA_BATCHES || 10);
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

// Read-back resilience. (1) A publish confirms on-chain but VM indexing lags a
// few seconds, so reads RETRY before failing. (2) If a publish fails (no fresh
// UAL) the read ops fall back to a known-good, already-indexed UAL so the
// query / VM GET / Query Remote paths are still exercised (V8 parity).
const READ_RETRIES = Number(process.env.V10_READ_RETRIES || 4);
const READ_RETRY_MS = Number(process.env.V10_READ_RETRY_MS || 3000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, label, nodeName, timeoutMs = OP_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout after ${Math.round(timeoutMs / 60000)} minutes during "${label}" on ${nodeName}`)),
      timeoutMs,
    );
  });
  // clearTimeout once the race settles: otherwise a resolved op leaves a live
  // 6-minute timer that keeps the mocha process alive, hanging the Jenkins
  // stage for ~6 min after the test already finished.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Run a read until it returns data (publish→VM indexing lags a few seconds) or
// the retry budget is exhausted. Returns the last result either way; the caller
// asserts on queryHasData.
async function readWithRetry(label, nodeName, fn) {
  let lastErr, lastResult;
  for (let attempt = 0; attempt <= READ_RETRIES; attempt++) {
    try {
      lastResult = await withTimeout(fn(), label, nodeName);
      if (queryHasData(lastResult)) return lastResult;
    } catch (err) { lastErr = err; }
    if (attempt < READ_RETRIES) await sleep(READ_RETRY_MS);
  }
  if (lastErr) throw lastErr;
  return lastResult;
}

// ---------------------------------------------------------------------------
// Per-node HTTP client. Each node has its OWN base URL + bearer token; the node
// signs internally. /api/status is public; writes + query-remote need the token.
// ---------------------------------------------------------------------------
export function makeNodeClient(baseUrl, token) {
  async function req(method, path, body, { acceptStatuses } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    // trim: a pasted token can carry a trailing newline/space which makes the node reject it
    if (token) headers['Authorization'] = `Bearer ${String(token).trim()}`;
    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
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
    status: () => req('GET', '/api/status').then((r) => r.data),
    // the node's own operational wallet addresses (it signs publishes with these)
    wallets: () => req('GET', '/api/wallets').then((r) => r.data),
    // v10.0.3 removed POST /api/knowledge-assets/publish (PR #1275) — publishing
    // now goes through the named-KA lifecycle. The create route runs the whole
    // chain in ONE call (create + wm/write + wm/finalize + swm/share + vm/publish)
    // via alsoShareSwm/alsoPublishVm, and returns kaId/ual/txHash/authorAddress
    // with status "vm-confirmed". We map that back to the old response shape so
    // the summary/report code stays unchanged.
    publish: (contextGraphId, quads) =>
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
        { acceptStatuses: [200, 201, 207] },
      ).then((r) => ({
        ...r.data,
        status: r.data.status === 'vm-confirmed' ? 'confirmed' : r.data.status,
        publisherAddress: r.data.publisherAddress || r.data.authorAddress,
        httpStatus: r.status,
      })),
    query: (sparql, contextGraphId, view = 'verifiable-memory') =>
      req('POST', '/api/query', { sparql, contextGraphId, view }).then((r) => r.data),
    // cross-node read: ask a PEER (by peerId) for a KA's triples. lookup is
    // { lookupType, ual } for ENTITY_BY_UAL (resolves a UAL → triples; works for
    // any node's KA) or { lookupType:'ENTITY_TRIPLES', entityUri } for an entity.
    queryRemote: (peerId, contextGraphId, lookup) =>
      req('POST', '/api/query-remote', {
        peerId,
        contextGraphId,
        lookupType: lookup.lookupType || 'ENTITY_TRIPLES',
        ...(lookup.ual ? { ual: lookup.ual } : {}),
        ...(lookup.entityUri ? { entityUri: lookup.entityUri } : {}),
      }).then((r) => r.data),
    // create (and optionally on-chain register) the context graph to publish into
    createContextGraph: (id, name, description, opts = {}) =>
      req('POST', '/api/context-graph/create', {
        id, name, description,
        accessPolicy: opts.accessPolicy ?? 0,
        publishPolicy: opts.publishPolicy ?? 1,
        register: opts.register ?? false,
      }).then((r) => r.data),
    // on-chain register an EXISTING (already locally-created) context graph.
    // create(register:true) only registers when it also creates; an existing CG
    // 409s there, so this standalone call is the path to register it on-chain.
    registerContextGraph: (id, opts = {}) =>
      req('POST', '/api/context-graph/register', {
        id,
        accessPolicy: opts.accessPolicy ?? 0,
        publishPolicy: opts.publishPolicy ?? 1,
      }).then((r) => r.data),
    // Subscribe to (and sync) a context graph this node does not host. The POST
    // enqueues catch-up; status must be polled through the read-only endpoint so
    // parallel Jenkins stages cannot keep re-queuing the same work.
    subscribe: (contextGraphId, includeSharedMemory = true) =>
      req('POST', '/api/context-graph/subscribe', { contextGraphId, includeSharedMemory }, { acceptStatuses: [200, 202] }).then((r) => r.data),
    catchupStatus: (contextGraphId) =>
      req('GET', `/api/sync/catchup-status?contextGraphId=${encodeURIComponent(contextGraphId)}`).then((r) => r.data),
  };
}

// Subscribe a node to a private CG and wait until its catch-up sync reports done
// (or timeout). Idempotent: a node already synced returns done immediately.
export async function subscribeAndWait(
  client,
  contextGraphId,
  nodeName,
  timeoutMs,
  pollIntervalMs = 3000,
  allowedTerminalStatuses = [],
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let res;
  try {
    res = await client.subscribe(contextGraphId);
  } catch (error) {
    throw new Error(`subscribe to "${contextGraphId}" on ${nodeName} failed: ${error.message}`);
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = res?.catchup?.status || res?.status || 'unknown';
    if (status !== last) {
      console.log(`   ↪ ${nodeName} subscribe/catchup: ${status}`);
      last = status;
    }
    if (status === 'done') return res;
    if (['failed', 'error', 'denied', 'deferred', 'unreachable'].includes(status)) {
      const detail = res?.error ? `: ${res.error}` : '';
      if (allowedTerminalStatuses.includes(status)) {
        console.warn(
          `⚠️ ${nodeName} historical catch-up reported ${status}${detail}; ` +
          'the subscription is active, so continuing with fresh-publish Query Remote validation',
        );
        return res;
      }
      throw new Error(`catch-up sync for "${contextGraphId}" on ${nodeName} reported ${status}${detail}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`catch-up sync for "${contextGraphId}" on ${nodeName} did not finish within ${timeoutMs}ms (last status: ${status}) — is the curator node reachable on the DKG network?`);
    }
    await sleep(pollIntervalMs);
    try {
      res = await client.catchupStatus(contextGraphId);
    } catch (error) {
      throw new Error(`read catch-up status for "${contextGraphId}" on ${nodeName} failed: ${error.message}`);
    }
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

// Query all protocol-backed candidate storage peers in parallel per retry
// round and accept the first readable copy. A publish's availability contract
// is backed by its StorageACK cores; requiring one unrelated random beacon to
// hold the KA measured gossip luck instead of that contract.
export async function queryAnyRemoteWithRetry(
  client,
  contextGraphId,
  ual,
  targets,
  retries = READ_RETRIES,
  retryDelayMs = READ_RETRY_MS,
) {
  let lastFailures = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    const outcomes = await Promise.all(targets.map(async (target) => {
      try {
        const result = await withTimeout(
          client.queryRemote(target.peerId, contextGraphId, {
            lookupType: 'ENTITY_BY_UAL',
            ual,
          }),
          'Query Remote (sync)',
          target.name,
        );
        return { target, result };
      } catch (error) {
        return { target, error };
      }
    }));
    const readable = outcomes.find((outcome) => queryHasData(outcome.result));
    if (readable) return readable;

    lastFailures = outcomes.map(({ target, error }) => (
      `${target.name}: ${error instanceof Error ? error.message : 'no triples'}`
    ));
    if (attempt < retries) await sleep(retryDelayMs);
  }

  throw new Error(
    `Query Remote (sync) found no readable copy of ${ual} across ` +
    `${targets.length} storage candidate(s) — ${lastFailures.join('; ')}`,
  );
}

// Resolve (and cache) a node's libp2p peerId via its public /api/status.
const peerIdCache = new Map();
async function getPeerId(node) {
  if (peerIdCache.has(node.hostname)) return peerIdCache.get(node.hostname);
  const status = await makeNodeClient(node.hostname, node.token).status();
  const pid = status && status.peerId;
  if (pid) peerIdCache.set(node.hostname, pid);
  return pid;
}

const mean = (arr) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

// ---------------------------------------------------------------------------
// Register the per-chain describe/it suite.
//   config = { title, blockchainName, contextGraphId, nodes:[{name,hostname,token}] }
// NODE_TO_TEST (env) selects which node this Jenkins stage runs.
// ---------------------------------------------------------------------------
export function defineChainPublishSuite(config) {
  const {
    title,
    blockchainName,
    contextGraphId,
    nodes,
    remoteQuerySubscribeAll = false,
  } = config;
  // Known-good, already-indexed UAL used to exercise the read paths when a
  // publish fails (no fresh UAL). Per-chain, overridable via DKG_FALLBACK_UAL.
  const FALLBACK_UAL = process.env.DKG_FALLBACK_UAL || config.fallbackUal || '';

  const globalStats = { [blockchainName]: {} };
  const errorStats = {};

  describe(title, function () {
    this.timeout(130 * 60 * 1000);

    it('should sequentially test selected node(s)', async () => {
      const NODE_TO_TEST = process.env.NODE_TO_TEST;
      const nodesToRun = NODE_TO_TEST ? nodes.filter((n) => n.name === NODE_TO_TEST) : nodes;

      console.log(`\nRunning test for node: ${nodesToRun.map((n) => n.name).join(', ')}`);
      console.log(`Blockchain: ${blockchainName} | Context graph: ${contextGraphId} | KAs per node: ${KA_COUNT}`);

      // A remote query reads the selected peer's LOCAL VM; it does not initiate
      // sync. Because this suite chooses an arbitrary receiver, every possible
      // receiver must subscribe and finish catch-up first. Jenkins runs one
      // process per node in parallel, so every process performs this idempotent
      // barrier and none can publish before all four receivers are ready.
      if (remoteQuerySubscribeAll) {
        console.log(`🔗 Preparing all ${nodes.length} Query Remote receiver(s) for "${contextGraphId}"…`);
        await Promise.all(nodes.map(async (node) => {
          const client = makeNodeClient(node.hostname, node.token);
          const catchup = await subscribeAndWait(
            client,
            contextGraphId,
            node.name,
            CG_SUBSCRIBE_TIMEOUT_MS,
            3000,
            // This suite measures reads of KAs published AFTER this barrier.
            // A public node's subscription is already active when historical
            // catch-up reports a transport/data-plane failure, so keep that as
            // an explicit warning without suppressing the fresh-read canary.
            ['failed', 'unreachable'],
          );
          const catchupStatus = catchup?.catchup?.status || catchup?.status;
          console.log(
            catchupStatus === 'done'
              ? `✅ ${node.name} subscribed and synced for Query Remote`
              : `✅ ${node.name} subscribed for fresh Query Remote (historical catch-up: ${catchupStatus})`,
          );
        }));
      }

      for (let currentIndex = 0; currentIndex < nodesToRun.length; currentIndex++) {
        const { name, hostname, token } = nodesToRun[currentIndex];

        // Token preflight — prints WHETHER a real token reached the harness, never
        // the value itself (Jenkins masks the secret; we only echo its state/length).
        const trimmedToken = token ? String(token).trim() : '';
        const looksPlaceholder = /REPLACE|CHANGE-?ME|placeholder|TODO|XXXX|FROM_OT/i.test(trimmedToken);
        const tokenState = !trimmedToken
          ? '❌ MISSING — the Jenkins credential env var is empty / not bound to this stage'
          : looksPlaceholder
            ? '❌ PLACEHOLDER — the credential still holds the placeholder text, not the real token (click "Change Password" in the credential, paste the token, Save)'
            : `✅ present (length ${trimmedToken.length})`;
        console.log(`🔑 ${name} bearer token: ${tokenState}`);

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

        const client = makeNodeClient(hostname, token);

        // Per-node wallet check. In V10 the NODE signs publishes internally with
        // its OWN operational wallets (loaded from that node's DKG_HOME), so each
        // node naturally publishes from a different wallet. Surface the address(es)
        // here — named by node — so each run proves which wallet the node uses and
        // that the nodes are not all signing from one shared wallet.
        let nodeWalletAddrs = [];
        try {
          const w = await client.wallets();
          nodeWalletAddrs = Array.isArray(w?.wallets) ? w.wallets : [];
          console.log(`💳 ${name} operational wallet(s): ${nodeWalletAddrs.length ? nodeWalletAddrs.join(', ') : '(none reported)'}${w?.chainId ? ` | chainId ${w.chainId}` : ''}`);
        } catch (error) {
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
            await client.createContextGraph(
              contextGraphId, 'V10 Publish Test CG', 'Automated publish/query test context graph',
              { accessPolicy: CG_ACCESS_POLICY, publishPolicy: CG_PUBLISH_POLICY, register: true },
            );
          } catch (error) {
            console.log(`Context graph create on ${name}: ${error.message} (may already exist, continuing)`);
          }
          try {
            const reg = await client.registerContextGraph(contextGraphId, { accessPolicy: CG_ACCESS_POLICY, publishPolicy: CG_PUBLISH_POLICY });
            console.log(`✅ Context graph "${contextGraphId}" registered on-chain on ${name}${reg.onChainId ? ` (on-chain ${reg.onChainId})` : ''}`);
          } catch (error) {
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
        const needsSubscribe = !remoteQuerySubscribeAll && (
          CG_SUBSCRIBE
          || (typeof contextGraphId === 'string' && contextGraphId.includes('/'))
        );
        if (needsSubscribe) {
          console.log(`🔗 ${name} subscribing to private CG "${contextGraphId}" (syncing from curator)…`);
          await subscribeAndWait(client, contextGraphId, name, CG_SUBSCRIBE_TIMEOUT_MS);
          console.log(`✅ ${name} synced CG "${contextGraphId}" — proceeding to publish`);
        }

        for (let i = 0; i < KA_COUNT; i++) {
          console.log(`\nPublishing KA #${i + 1} on ${name}`);
          const { quads, rootEntity } = buildQuads(name, i + 1);

          let ual = null;
          let storageAckPeerIds = [];
          let step = 'publish';

          // ── 1. publish (mint to Verifiable Memory) ─────────────────────────
          const pubStart = Date.now();
          try {
            const result = await withTimeout(client.publish(contextGraphId, quads), 'publish', name, PUBLISH_TIMEOUT_MS);
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
            assert.ok(result.kaId !== undefined && result.kaId !== '0', `Publish response missing valid kaId (got ${result.kaId})`);

            ual = result.ual || null;
            storageAckPeerIds = Array.isArray(result.storageAckPeerIds)
              ? [...new Set(result.storageAckPeerIds.filter((peerId) => typeof peerId === 'string' && peerId.trim()).map((peerId) => peerId.trim()))]
              : [];
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
          }

          // Reads are RUN-SPECIFIC when the publish succeeded — they target THIS
          // KA's unique root (urn:ka:<node>-<uuid>) / UAL, so a pass proves this
          // run's data is really readable (no stale-data false positives). Only if
          // the publish FAILED (no fresh UAL) do they fall back to the per-chain
          // FALLBACK_UAL via ENTITY_BY_UAL, so the read paths are still exercised.
          const readUal = ual || FALLBACK_UAL;
          const fallbackPeerId = () => getPeerId(nodes.find((n) => n.name !== name) || nodes[0]);

          // ── 2. query — SELECT this KA's child entities (via isPartOf) from VM ─
          step = 'query';
          const queryStart = Date.now();
          try {
            let result;
            if (ual) {
              const sparql = `SELECT ?s ?name WHERE { ?s <http://schema.org/isPartOf> <${rootEntity}> ; <http://schema.org/name> ?name } LIMIT 5`;
              result = await readWithRetry('query', name, () => client.query(sparql, contextGraphId, 'verifiable-memory'));
            } else if (FALLBACK_UAL) {
              result = await readWithRetry('query', name, async () => client.queryRemote(await fallbackPeerId(), contextGraphId, { lookupType: 'ENTITY_BY_UAL', ual: FALLBACK_UAL }));
            } else {
              throw new Error('query: publish failed and no DKG_FALLBACK_UAL configured');
            }
            assert.ok(queryHasData(result), 'Query returned empty results');
            console.log(`✅ Query succeeded`);
            querySuccess++;
            queryDurations.push(Date.now() - queryStart);
          } catch (error) {
            await logError(error, name, step, errorStats, i + 1, { baseUrl: client.baseUrl });
            failedAssets.push(`KA #${i + 1} (Query failed)`);
            queryFail++;
          }

          // ── 3. VM GET — get THIS KA's root entity triples from local VM ──────
          step = 'VM GET';
          const vmGetStart = Date.now();
          try {
            let result;
            if (ual) {
              const entitySparql = `SELECT ?p ?o WHERE { <${rootEntity}> ?p ?o } LIMIT 5`;
              result = await readWithRetry('VM GET', name, () => client.query(entitySparql, contextGraphId, 'verifiable-memory'));
            } else if (FALLBACK_UAL) {
              result = await readWithRetry('VM GET', name, async () => client.queryRemote(await fallbackPeerId(), contextGraphId, { lookupType: 'ENTITY_BY_UAL', ual: FALLBACK_UAL }));
            } else {
              throw new Error('VM GET: publish failed and no DKG_FALLBACK_UAL configured');
            }
            assert.ok(queryHasData(result), 'VM GET returned empty results');
            console.log(`✅ VM GET succeeded`);
            vmGetSuccess++;
            vmGetDurations.push(Date.now() - vmGetStart);
          } catch (error) {
            await logError(error, name, step, errorStats, i + 1, { baseUrl: client.baseUrl });
            failedAssets.push(`KA #${i + 1} (VM GET failed)`);
            vmGetFail++;
          }

          // ── 4. Query Remote (sync) — read the KA back from a PEER by UAL ────
          step = 'Query Remote (sync)';
          const otherIndexes = nodes.map((_, idx) => idx).filter((idx) => nodes[idx].name !== name);
          if (otherIndexes.length === 0) {
            // single-node chain — no peer to sync-check against
            continue;
          }
          const remoteStart = Date.now();
          try {
            if (!readUal) throw new Error('Query Remote (sync): publish failed and no DKG_FALLBACK_UAL configured');
            const targets = storageAckPeerIds.length > 0
              ? storageAckPeerIds.map((peerId) => ({
                  peerId,
                  name: `StorageACK core …${peerId.slice(-8)}`,
                }))
              : (await Promise.all(otherIndexes.map(async (idx) => ({
                  peerId: await getPeerId(nodes[idx]),
                  name: nodes[idx].name,
                })))).filter((target) => target.peerId);
            if (targets.length === 0) {
              throw new Error('Query Remote (sync) has no resolvable storage candidates');
            }
            const readable = await queryAnyRemoteWithRetry(
              client,
              contextGraphId,
              readUal,
              targets,
            );
            const targetKind = storageAckPeerIds.length > 0
              ? 'acknowledged storage core'
              : 'legacy beacon fallback';
            console.log(
              `✅ Query Remote (sync) succeeded — ${readable.target.name} has the KA ` +
              `(${targetKind}; ${targets.length} candidate${targets.length === 1 ? '' : 's'})`,
            );
            queryRemoteSuccess++;
            queryRemoteDurations.push(Date.now() - remoteStart);
          } catch (error) {
            await logError(error, name, step, errorStats, i + 1, { baseUrl: client.baseUrl });
            failedAssets.push(`KA #${i + 1} (Query Remote (sync) failed)`);
            queryRemoteFail++;
          }
        }

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
        } else {
          console.log(`✅ All assets processed successfully`);
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
          node_wallet: nodeWalletAddrs.join(', '),
          node_publisher_wallets: [...publisherAddresses].join(', '),
          publish_success_rate: safeRate(publishSuccess, publishFail),
          query_success_rate: safeRate(querySuccess, queryFail),
          publisher_get_success_rate: safeRate(vmGetSuccess, vmGetFail),                 // VM GET
          non_publisher_get_success_rate: safeRate(queryRemoteSuccess, queryRemoteFail),   // Query Remote (sync)
          average_publish_time: avgPublishMs === null ? null : (avgPublishMs / 1000).toFixed(2),
          average_query_time: avgQueryMs === null ? null : (avgQueryMs / 1000).toFixed(2),
          average_publisher_get_time: avgVmGetMs === null ? null : (avgVmGetMs / 1000).toFixed(2),
          average_non_publisher_get_time: avgQueryRemoteMs === null ? null : (avgQueryRemoteMs / 1000).toFixed(2),
          time_stamp: new Date().toISOString(),
        };
        const summaryFileName = `summary_${name.replace(/\s+/g, '_')}.json`;
        fs.writeFileSync(summaryFileName, JSON.stringify(summary, null, 2));
        console.log(`✅ Saved summary to ${summaryFileName}`);

        const errorData = {
          blockchain_id: blockchainName,
          aggregated: errorStats[name]?.aggregated || {},
          detailed: errorStats[name]?.detailed || {},
          services: errorStats[name]?.services || {},
        };
        const errorsFileName = `errors_${name.replace(/\s+/g, '_')}.json`;
        fs.writeFileSync(errorsFileName, JSON.stringify(errorData, null, 2));
        console.log(`✅ Saved errors to ${errorsFileName}`);
      }
    });

    after(() => {
      console.log(`\n\nGlobal Publish Summary:`);
      Object.entries(globalStats).forEach(([blockchain, nodeStats]) => {
        console.log(`\n🔗 Blockchain: ${blockchain}`);
        Object.entries(nodeStats).forEach(([nodeName, stats]) => {
          console.log(`  • ${nodeName}:`);
          console.log(`    Publish:             ✅ ${stats.publishSuccess} / ❌ ${stats.publishFail} -> ${safeRate(stats.publishSuccess, stats.publishFail)}%`);
          console.log(`    Query:               ✅ ${stats.querySuccess} / ❌ ${stats.queryFail} -> ${safeRate(stats.querySuccess, stats.queryFail)}%`);
          console.log(`    VM GET:             ✅ ${stats.vmGetSuccess} / ❌ ${stats.vmGetFail} -> ${safeRate(stats.vmGetSuccess, stats.vmGetFail)}%`);
          console.log(`    Query Remote (sync): ✅ ${stats.queryRemoteSuccess} / ❌ ${stats.queryRemoteFail} -> ${safeRate(stats.queryRemoteSuccess, stats.queryRemoteFail)}%`);
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
