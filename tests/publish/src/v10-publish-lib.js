// ===========================================================================
// V10 multi-node publish/query lifecycle — a faithful port of the dkg.js V8
// per-chain specs to the V10 node HTTP API, using V10-native operation names.
//
// V10 operation vocabulary (what the node actually calls these):
//   1. publish        -> POST /api/knowledge-assets/publish  (mint to Verifiable Memory)
//   2. query          -> POST /api/query  view=verifiable-memory  (broad SPARQL read)
//   3. verifiable-memory get
//                     -> POST /api/query  view=verifiable-memory, scoped to the
//                        published entity, on the SAME node (local read-back)
//   4. query-remote   -> POST /api/query-remote  { peerId, lookupType:ENTITY_TRIPLES }
//                        against ANOTHER node's peerId — reads the entity back from
//                        a peer over the /dkg/10.0.1/query-remote protocol. This is
//                        the real cross-node SYNC / replication test.
//
// V8 vs V10 — the only behavioural difference: V8 signed client-side with a
// per-node PRIVATE KEY; V10 nodes sign INTERNALLY from their own op-wallet pool,
// driven by the HTTP API + a per-node BEARER TOKEN. We record the
// `publisherAddress` the node returns per publish instead of choosing the wallet.
//
// The summary_<Node>.json fields keep their V8 column names (publish_success_rate,
// query_success_rate, publisher_get_success_rate, non_publisher_get_success_rate)
// so the Grafana Postgres import stays byte-identical. They map to the V10 ops as:
//   publish_success_rate            <- publish
//   query_success_rate              <- query
//   publisher_get_success_rate      <- verifiable-memory get (local)
//   non_publisher_get_success_rate  <- query-remote (peer sync)
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
    // local query (view=verifiable-memory)
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

        // counters keep the V8 metric names (publisherGet = verifiable-memory get,
        // remoteGet = query-remote) so the Grafana summary columns are unchanged.
        let publishSuccess = 0, publishFail = 0;
        let querySuccess = 0, queryFail = 0;
        let vmGetSuccess = 0, vmGetFail = 0;
        let queryRemoteSuccess = 0, queryRemoteFail = 0;

        const publishDurations = [];
        const queryDurations = [];
        const vmGetDurations = [];
        const queryRemoteDurations = [];
        const failedAssets = [];
        const publisherAddresses = new Set();

        const client = makeNodeClient(hostname, token);

        for (let i = 0; i < KA_COUNT; i++) {
          console.log(`\nPublishing KA #${i + 1} on ${name}`);
          const { quads, rootEntity } = buildQuads(name, i + 1);

          let ual = null;
          const target = rootEntity; // entity we read back in the get/query-remote steps
          let step = 'publish';

          // ── 1. publish (mint to Verifiable Memory) ─────────────────────────
          try {
            const t0 = Date.now();
            const result = await withTimeout(client.publish(contextGraphId, quads), 'publish', name);
            publishDurations.push(Date.now() - t0);

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
          }

          // ── 2. query (broad verifiable-memory SPARQL) ──────────────────────
          try {
            step = 'query';
            const generalSparql = `PREFIX schema: <http://schema.org/>
SELECT ?s ?name ?description WHERE {
  ?s schema:name ?name ; schema:description ?description .
} LIMIT 10`;
            const t0 = Date.now();
            const result = await withTimeout(client.query(generalSparql, contextGraphId, 'verifiable-memory'), 'query', name);
            queryDurations.push(Date.now() - t0);
            assert.ok(queryHasData(result), 'Query returned empty results');
            console.log(`✅ Query succeeded`);
            querySuccess++;
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            failedAssets.push(`KA #${i + 1} (Query failed — UAL: ${ual})`);
            queryFail++;
          }

          // ── 3. verifiable-memory get (read the entity back on the SAME node) ─
          try {
            step = 'verifiable-memory get';
            const entitySparql = `SELECT ?p ?o WHERE { <${target}> ?p ?o } LIMIT 5`;
            const t0 = Date.now();
            const result = await withTimeout(client.query(entitySparql, contextGraphId, 'verifiable-memory'), 'verifiable-memory get', name);
            vmGetDurations.push(Date.now() - t0);
            assert.ok(queryHasData(result), `Verifiable-Memory Get returned empty results for ${target}`);
            console.log(`✅ Verifiable-Memory Get succeeded`);
            vmGetSuccess++;
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            failedAssets.push(`KA #${i + 1} (Verifiable-Memory Get failed — UAL: ${ual})`);
            vmGetFail++;
          }

          // ── 4. query-remote (read the entity back from a PEER — sync test) ──
          step = 'query-remote';
          const otherIndexes = nodes.map((_, idx) => idx).filter((idx) => nodes[idx].name !== name);
          if (otherIndexes.length === 0) {
            // single-node chain — no peer to sync-check against
            continue;
          }
          const remoteNode = nodes[otherIndexes[Math.floor(Math.random() * otherIndexes.length)]];
          try {
            const remotePeerId = await getPeerId(remoteNode);
            if (!remotePeerId) throw new Error(`Could not resolve peerId for ${remoteNode.name} (${remoteNode.hostname})`);
            const t0 = Date.now();
            const result = await withTimeout(client.queryRemote(remotePeerId, contextGraphId, target), 'query-remote', remoteNode.name);
            queryRemoteDurations.push(Date.now() - t0);
            assert.ok(queryHasData(result), `Query-Remote returned no triples for ${target} from ${remoteNode.name}`);
            console.log(`✅ Query-Remote succeeded — ${remoteNode.name} has the entity (synced)`);
            queryRemoteSuccess++;
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            failedAssets.push(`KA #${i + 1} (Query-Remote failed — UAL: ${ual})`);
            queryRemoteFail++;
          }
        }

        const avg = (arr) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
        const avgPublishMs = publishSuccess > 0 ? avg(publishDurations) : 0;
        const avgQueryMs = querySuccess > 0 ? avg(queryDurations) : 0;
        const avgVmGetMs = vmGetSuccess > 0 ? avg(vmGetDurations) : 0;
        const avgQueryRemoteMs = queryRemoteSuccess > 0 ? avg(queryRemoteDurations) : 0;

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
          publish_success_rate: safeRate(publishSuccess, publishFail),
          query_success_rate: safeRate(querySuccess, queryFail),
          publisher_get_success_rate: safeRate(vmGetSuccess, vmGetFail),            // verifiable-memory get (local)
          non_publisher_get_success_rate: safeRate(queryRemoteSuccess, queryRemoteFail), // query-remote (peer sync)
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
          console.log(`    Publish:            ✅ ${stats.publishSuccess} / ❌ ${stats.publishFail} -> ${safeRate(stats.publishSuccess, stats.publishFail)}%`);
          console.log(`    Query:              ✅ ${stats.querySuccess} / ❌ ${stats.queryFail} -> ${safeRate(stats.querySuccess, stats.queryFail)}%`);
          console.log(`    Verifiable-Mem Get: ✅ ${stats.vmGetSuccess} / ❌ ${stats.vmGetFail} -> ${safeRate(stats.vmGetSuccess, stats.vmGetFail)}%`);
          console.log(`    Query-Remote (sync):✅ ${stats.queryRemoteSuccess} / ❌ ${stats.queryRemoteFail} -> ${safeRate(stats.queryRemoteSuccess, stats.queryRemoteFail)}%`);
          console.log(`    Avg Publish Time:        ${formatDuration(stats.avgPublishMs)}`);
          console.log(`    Avg Query Time:          ${formatDuration(stats.avgQueryMs)}`);
          console.log(`    Avg Verifiable-Mem Get:  ${formatDuration(stats.avgVmGetMs)}`);
          console.log(`    Avg Query-Remote Time:   ${formatDuration(stats.avgQueryRemoteMs)}`);
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
