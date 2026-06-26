// ===========================================================================
// V10 multi-node publish/query lifecycle — a faithful port of the dkg.js V8
// per-chain specs to the V10 node HTTP API, using V10-native operation names.
//
// V10 operation vocabulary (what the node actually calls these):
//   1. publish            -> POST /api/knowledge-assets/publish  (mint to Verifiable Memory)
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
  buildQuads,
  safeRate,
  formatDuration,
  logError,
} from './v10-helpers.js';

const PUBLISH_EPOCHS = Number(process.env.PUBLISH_EPOCHS || 2);
const KA_COUNT = Number(process.env.TEST_KA_BATCHES || 10);
const OP_TIMEOUT_MS = Number(process.env.V10_OP_TIMEOUT_MS || 6 * 60 * 1000);

// Context-graph provisioning. Publishing to Verifiable Memory needs the CG to be
// registered on-chain. V10_CG_REGISTER=true registers a fresh CG (~100 TRAC on the
// node wallet); false assumes DKG_CONTEXT_GRAPH_ID already exists + is registered.
const CG_REGISTER = String(process.env.V10_CG_REGISTER || 'false').toLowerCase() === 'true';
const CG_ACCESS_POLICY = Number(process.env.V10_CG_ACCESS_POLICY || 0);
const CG_PUBLISH_POLICY = Number(process.env.V10_CG_PUBLISH_POLICY || 1);

// Read-back resilience. (1) A publish confirms on-chain but VM indexing lags a
// few seconds, so reads RETRY before failing. (2) If a publish fails (no fresh
// UAL) the read ops fall back to a known-good, already-indexed UAL so the
// query / VM GET / Query Remote paths are still exercised (V8 parity).
const READ_RETRIES = Number(process.env.V10_READ_RETRIES || 4);
const READ_RETRY_MS = Number(process.env.V10_READ_RETRY_MS || 3000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, label, nodeName) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout after ${Math.round(OP_TIMEOUT_MS / 60000)} minutes during "${label}" on ${nodeName}`)),
      OP_TIMEOUT_MS,
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
    const res = await fetch(`${baseUrl}${path}`, opts);
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
    publish: (contextGraphId, quads) =>
      req(
        'POST',
        '/api/knowledge-assets/publish',
        { contextGraphId, quads, publishEpochs: PUBLISH_EPOCHS },
        { acceptStatuses: [200, 207] },
      ).then((r) => ({ ...r.data, httpStatus: r.status })),
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
  };
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
  const { title, blockchainName, contextGraphId, nodes } = config;
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

        // durations record EVERY attempt (success or fail) so the average is the
        // real operation latency and never spuriously 0.
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
          console.log(`Publishing into existing context graph "${contextGraphId}" on ${name} (no create/register; reuses a registered open-publish CG)`);
        }

        for (let i = 0; i < KA_COUNT; i++) {
          console.log(`\nPublishing KA #${i + 1} on ${name}`);
          const { quads, rootEntity } = buildQuads(name, i + 1);

          let ual = null;
          let step = 'publish';

          // ── 1. publish (mint to Verifiable Memory) ─────────────────────────
          const pubStart = Date.now();
          try {
            const result = await withTimeout(client.publish(contextGraphId, quads), 'publish', name);
            assert.ok(result, 'Publish returned no result');
            if (result.status !== 'confirmed') {
              throw new Error(
                `Publish returned "${result.status}" instead of "confirmed" (kaId: ${result.kaId}, httpStatus: ${result.httpStatus})${result.error ? ` — ${result.error}` : ''}`,
              );
            }
            assert.ok(result.kaId !== undefined && result.kaId !== '0', `Publish response missing valid kaId (got ${result.kaId})`);

            ual = result.ual || null;
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
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            console.log(`❌ Publish failed | No UAL`);
            failedAssets.push(`KA #${i + 1} (Publish failed)`);
            publishFail++;
          } finally {
            publishDurations.push(Date.now() - pubStart);
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
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            failedAssets.push(`KA #${i + 1} (Query failed)`);
            queryFail++;
          } finally {
            queryDurations.push(Date.now() - queryStart);
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
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            failedAssets.push(`KA #${i + 1} (VM GET failed)`);
            vmGetFail++;
          } finally {
            vmGetDurations.push(Date.now() - vmGetStart);
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
            if (!readUal) throw new Error('Query Remote (sync): publish failed and no DKG_FALLBACK_UAL configured');
            const remotePeerId = await getPeerId(remoteNode);
            if (!remotePeerId) throw new Error(`Could not resolve peerId for ${remoteNode.name} (${remoteNode.hostname})`);
            const result = await readWithRetry('Query Remote (sync)', remoteNode.name, () => client.queryRemote(remotePeerId, contextGraphId, { lookupType: 'ENTITY_BY_UAL', ual: readUal }));
            assert.ok(queryHasData(result), `Query Remote (sync) returned no triples for ${readUal} from ${remoteNode.name}`);
            console.log(`✅ Query Remote (sync) succeeded — ${remoteNode.name} has the KA (synced)`);
            queryRemoteSuccess++;
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            failedAssets.push(`KA #${i + 1} (Query Remote (sync) failed)`);
            queryRemoteFail++;
          } finally {
            queryRemoteDurations.push(Date.now() - remoteStart);
          }
        }

        const avgPublishMs = mean(publishDurations);
        const avgQueryMs = mean(queryDurations);
        const avgVmGetMs = mean(vmGetDurations);
        const avgQueryRemoteMs = mean(queryRemoteDurations);

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
          average_publish_time: (avgPublishMs / 1000).toFixed(2),
          average_query_time: (avgQueryMs / 1000).toFixed(2),
          average_publisher_get_time: (avgVmGetMs / 1000).toFixed(2),
          average_non_publisher_get_time: (avgQueryRemoteMs / 1000).toFixed(2),
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
