// ===========================================================================
// V10 multi-node publish/query lifecycle — a faithful port of the dkg.js V8
// per-chain specs to the V10 node HTTP API, using V10-native operation names.
//
// V10 operation vocabulary (what the node actually calls these):
//   1. publish            -> POST /api/knowledge-assets/publish  (mint to Verifiable Memory)
//   2. query              -> POST /api/query  view=verifiable-memory  (broad SPARQL read)
//   3. SWM GET            -> POST /api/query  view=shared-memory, scoped to the published
//                            entity, on the SAME node (Shared-Memory read-back)
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
//   publisher_get_success_rate      <- SWM GET
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

function withTimeout(promise, label, nodeName) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout after ${Math.round(OP_TIMEOUT_MS / 60000)} minutes during "${label}" on ${nodeName}`)),
        OP_TIMEOUT_MS,
      ),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Per-node HTTP client. Each node has its OWN base URL + bearer token; the node
// signs internally. /api/status is public; writes + query-remote need the token.
// ---------------------------------------------------------------------------
export function makeNodeClient(baseUrl, token) {
  async function req(method, path, body, { acceptStatuses } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
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
    publish: (contextGraphId, quads) =>
      req(
        'POST',
        '/api/knowledge-assets/publish',
        { contextGraphId, quads, publishEpochs: PUBLISH_EPOCHS },
        { acceptStatuses: [200, 207] },
      ).then((r) => ({ ...r.data, httpStatus: r.status })),
    query: (sparql, contextGraphId, view = 'verifiable-memory') =>
      req('POST', '/api/query', { sparql, contextGraphId, view }).then((r) => r.data),
    // cross-node read: ask a PEER (by peerId) for an entity's triples — the V10 sync test
    queryRemote: (peerId, contextGraphId, entityUri) =>
      req('POST', '/api/query-remote', {
        peerId,
        lookupType: 'ENTITY_TRIPLES',
        contextGraphId,
        entityUri,
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

        let publishSuccess = 0, publishFail = 0;
        let querySuccess = 0, queryFail = 0;
        let swmGetSuccess = 0, swmGetFail = 0;
        let queryRemoteSuccess = 0, queryRemoteFail = 0;

        // durations record EVERY attempt (success or fail) so the average is the
        // real operation latency and never spuriously 0.
        const publishDurations = [];
        const queryDurations = [];
        const swmGetDurations = [];
        const queryRemoteDurations = [];
        const failedAssets = [];
        const publisherAddresses = new Set();

        const client = makeNodeClient(hostname, token);

        for (let i = 0; i < KA_COUNT; i++) {
          console.log(`\nPublishing KA #${i + 1} on ${name}`);
          const { quads, rootEntity } = buildQuads(name, i + 1);

          let ual = null;
          const target = rootEntity; // entity read back in the SWM GET / query-remote steps
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
            publishSuccess++;
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            console.log(`❌ Publish failed | No UAL`);
            failedAssets.push(`KA #${i + 1} (Publish failed)`);
            publishFail++;
          } finally {
            publishDurations.push(Date.now() - pubStart);
          }

          // ── 2. query (broad verifiable-memory SPARQL) ──────────────────────
          step = 'query';
          const queryStart = Date.now();
          try {
            const generalSparql = `PREFIX schema: <http://schema.org/>
SELECT ?s ?name ?description WHERE {
  ?s schema:name ?name ; schema:description ?description .
} LIMIT 10`;
            const result = await withTimeout(client.query(generalSparql, contextGraphId, 'verifiable-memory'), 'query', name);
            assert.ok(queryHasData(result), 'Query returned empty results');
            console.log(`✅ Query succeeded`);
            querySuccess++;
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            failedAssets.push(`KA #${i + 1} (Query failed — UAL: ${ual})`);
            queryFail++;
          } finally {
            queryDurations.push(Date.now() - queryStart);
          }

          // ── 3. SWM GET (read the entity back from Shared Memory, SAME node) ─
          step = 'SWM GET';
          const swmStart = Date.now();
          try {
            const entitySparql = `SELECT ?p ?o WHERE { <${target}> ?p ?o } LIMIT 5`;
            const result = await withTimeout(client.query(entitySparql, contextGraphId, 'shared-memory'), 'SWM GET', name);
            assert.ok(queryHasData(result), `SWM GET returned empty results for ${target}`);
            console.log(`✅ SWM GET succeeded`);
            swmGetSuccess++;
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            failedAssets.push(`KA #${i + 1} (SWM GET failed — UAL: ${ual})`);
            swmGetFail++;
          } finally {
            swmGetDurations.push(Date.now() - swmStart);
          }

          // ── 4. Query Remote (sync) — read the entity back from a PEER ───────
          step = 'Query Remote (sync)';
          const otherIndexes = nodes.map((_, idx) => idx).filter((idx) => nodes[idx].name !== name);
          if (otherIndexes.length === 0) {
            // single-node chain — no peer to sync-check against
            continue;
          }
          const remoteNode = nodes[otherIndexes[Math.floor(Math.random() * otherIndexes.length)]];
          const remoteStart = Date.now();
          try {
            const remotePeerId = await getPeerId(remoteNode);
            if (!remotePeerId) throw new Error(`Could not resolve peerId for ${remoteNode.name} (${remoteNode.hostname})`);
            const result = await withTimeout(client.queryRemote(remotePeerId, contextGraphId, target), 'Query Remote (sync)', remoteNode.name);
            assert.ok(queryHasData(result), `Query Remote (sync) returned no triples for ${target} from ${remoteNode.name}`);
            console.log(`✅ Query Remote (sync) succeeded — ${remoteNode.name} has the entity (synced)`);
            queryRemoteSuccess++;
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            failedAssets.push(`KA #${i + 1} (Query Remote (sync) failed — UAL: ${ual})`);
            queryRemoteFail++;
          } finally {
            queryRemoteDurations.push(Date.now() - remoteStart);
          }
        }

        const avgPublishMs = mean(publishDurations);
        const avgQueryMs = mean(queryDurations);
        const avgSwmGetMs = mean(swmGetDurations);
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
          swmGetSuccess, swmGetFail,
          queryRemoteSuccess, queryRemoteFail,
          avgPublishMs, avgQueryMs, avgSwmGetMs, avgQueryRemoteMs,
        };

        const summary = {
          blockchain_name: blockchainName,
          node_name: name,
          publish_success_rate: safeRate(publishSuccess, publishFail),
          query_success_rate: safeRate(querySuccess, queryFail),
          publisher_get_success_rate: safeRate(swmGetSuccess, swmGetFail),                 // SWM GET
          non_publisher_get_success_rate: safeRate(queryRemoteSuccess, queryRemoteFail),   // Query Remote (sync)
          average_publish_time: (avgPublishMs / 1000).toFixed(2),
          average_query_time: (avgQueryMs / 1000).toFixed(2),
          average_publisher_get_time: (avgSwmGetMs / 1000).toFixed(2),
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
          console.log(`    SWM GET:             ✅ ${stats.swmGetSuccess} / ❌ ${stats.swmGetFail} -> ${safeRate(stats.swmGetSuccess, stats.swmGetFail)}%`);
          console.log(`    Query Remote (sync): ✅ ${stats.queryRemoteSuccess} / ❌ ${stats.queryRemoteFail} -> ${safeRate(stats.queryRemoteSuccess, stats.queryRemoteFail)}%`);
          console.log(`    Avg Publish Time:        ${formatDuration(stats.avgPublishMs)}`);
          console.log(`    Avg Query Time:          ${formatDuration(stats.avgQueryMs)}`);
          console.log(`    Avg SWM GET Time:        ${formatDuration(stats.avgSwmGetMs)}`);
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
