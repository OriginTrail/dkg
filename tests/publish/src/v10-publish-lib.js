// ===========================================================================
// V10 multi-node publish/query/get lifecycle — a faithful port of the dkg.js
// V8 per-chain specs (tests/mainnet/Base_Mainnet.spec.js etc.) to the V10 node
// HTTP API.
//
// V8 vs V10 — the only behavioural difference:
//   * V8 signs client-side with a per-node PRIVATE KEY (the test picks the
//     wallet). V10 nodes sign INTERNALLY from their own op-wallet pool, driven
//     by the HTTP API + a per-node BEARER TOKEN. So each node still publishes
//     "with its wallet(s)", but the node rotates the pool itself — we record
//     the `publisherAddress` it returns per publish instead of choosing it.
//
// Everything else mirrors V8: 10 KAs per node, each doing
//   publish -> query -> local get -> remote get (remote = a random OTHER node),
// 6-minute per-operation timeouts, the same summary_<Node>.json /
// errors_<Node>.json schema, the same global summary, and the same Grafana
// insert scripts.
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
// 10 root KAs per node (V8 published a fixed 10; keep the same default, but
// allow override via the same TEST_KA_BATCHES knob the V10 harness already uses).
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
// Per-node HTTP client (V8's `new DKG({ endpoint, blockchain })` analogue).
// Each node has its OWN base URL + bearer token; the node signs internally.
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
  };
}

function queryHasData(result) {
  if (!result) return false;
  if (Array.isArray(result)) return result.length > 0;
  if (Array.isArray(result.data)) return result.data.length > 0;
  if (Array.isArray(result.results)) return result.results.length > 0;
  if (result.data && Array.isArray(result.data.results)) return result.data.results.length > 0;
  return false;
}

// ---------------------------------------------------------------------------
// Register the V8-shaped describe/it suite for one chain.
//   config = { title, blockchainName, contextGraphId, nodes:[{name,hostname,token}] }
// `NODE_TO_TEST` (env) selects which node this Jenkins stage runs.
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
        let localGetSuccess = 0, localGetFail = 0;
        let remoteGetSuccess = 0, remoteGetFail = 0;

        const publishDurations = [];
        const queryDurations = [];
        const localGetDurations = [];
        const remoteGetDurations = [];
        const failedAssets = [];
        const publisherAddresses = new Set();

        const client = makeNodeClient(hostname, token);

        for (let i = 0; i < KA_COUNT; i++) {
          console.log(`\nPublishing KA #${i + 1} on ${name}`);
          const { quads, rootEntity } = buildQuads(name, i + 1);

          let ual = null;
          let target = rootEntity; // the subject we read back in get/query steps
          let step = 'publishing';

          // ── publish ───────────────────────────────────────────────────────
          try {
            const publishStart = Date.now();
            const result = await withTimeout(client.publish(contextGraphId, quads), 'publishing', name);
            publishDurations.push(Date.now() - publishStart);

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

          // ── query (general SELECT) ──────────────────────────────────────────
          try {
            step = 'querying';
            const generalSparql = `PREFIX schema: <http://schema.org/>
SELECT ?s ?name ?description WHERE {
  ?s schema:name ?name ; schema:description ?description .
} LIMIT 10`;
            const queryStart = Date.now();
            const queryResult = await withTimeout(client.query(generalSparql, contextGraphId, 'verifiable-memory'), 'querying', name);
            queryDurations.push(Date.now() - queryStart);
            assert.ok(queryHasData(queryResult), 'Query returned empty results');
            console.log(`✅ Query succeeded`);
            querySuccess++;
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            failedAssets.push(`KA #${i + 1} (Query failed — UAL: ${ual})`);
            queryFail++;
          }

          // ── local get (read the published asset back on the SAME node) ──────
          try {
            step = 'local get';
            const assetSparql = `SELECT ?p ?o WHERE { <${target}> ?p ?o } LIMIT 5`;
            const localGetStart = Date.now();
            const localGetResult = await withTimeout(client.query(assetSparql, contextGraphId, 'verifiable-memory'), 'local get', name);
            localGetDurations.push(Date.now() - localGetStart);
            assert.ok(queryHasData(localGetResult), `Local Get returned empty results for ${target}`);
            console.log(`✅ Local Get Succeeded`);
            localGetSuccess++;
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            failedAssets.push(`KA #${i + 1} (Local Get failed — UAL: ${ual})`);
            localGetFail++;
          }

          // ── remote get (read it back from a random OTHER node on the chain) ─
          step = 'get';
          const otherIndexes = nodes.map((_, idx) => idx).filter((idx) => nodes[idx].name !== name);
          if (otherIndexes.length === 0) {
            // single-node chain — nothing to do, mirror V8 by skipping cleanly
            continue;
          }
          const remoteNode = nodes[otherIndexes[Math.floor(Math.random() * otherIndexes.length)]];
          try {
            const remoteClient = makeNodeClient(remoteNode.hostname, remoteNode.token);
            const assetSparql = `SELECT ?p ?o WHERE { <${target}> ?p ?o } LIMIT 5`;
            const remoteGetStart = Date.now();
            const remoteGetResult = await withTimeout(remoteClient.query(assetSparql, contextGraphId, 'verifiable-memory'), 'get', remoteNode.name);
            remoteGetDurations.push(Date.now() - remoteGetStart);
            assert.ok(queryHasData(remoteGetResult), `Get returned empty results for ${target} on ${remoteNode.name}`);
            console.log(`✅ Get Succeeded on ${remoteNode.name}`);
            remoteGetSuccess++;
          } catch (error) {
            logError(error, name, step, errorStats, i + 1);
            failedAssets.push(`KA #${i + 1} (Get failed — UAL: ${ual})`);
            remoteGetFail++;
          }
        }

        const avg = (arr) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
        const avgPublishMs = publishSuccess > 0 ? avg(publishDurations) : 0;
        const avgQueryMs = querySuccess > 0 ? avg(queryDurations) : 0;
        const avgLocalGetMs = localGetSuccess > 0 ? avg(localGetDurations) : 0;
        const avgRemoteGetMs = remoteGetSuccess > 0 ? avg(remoteGetDurations) : 0;

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
          localGetSuccess, localGetFail,
          remoteGetSuccess, remoteGetFail,
          avgPublishMs, avgQueryMs, avgLocalGetMs, avgRemoteGetMs,
        };

        const summary = {
          blockchain_name: blockchainName,
          node_name: name,
          publish_success_rate: safeRate(publishSuccess, publishFail),
          query_success_rate: safeRate(querySuccess, queryFail),
          publisher_get_success_rate: safeRate(localGetSuccess, localGetFail),
          non_publisher_get_success_rate: safeRate(remoteGetSuccess, remoteGetFail),
          average_publish_time: (avgPublishMs / 1000).toFixed(2),
          average_query_time: (avgQueryMs / 1000).toFixed(2),
          average_publisher_get_time: (avgLocalGetMs / 1000).toFixed(2),
          average_non_publisher_get_time: (avgRemoteGetMs / 1000).toFixed(2),
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
          console.log(`    Publish:       ✅ ${stats.publishSuccess} / ❌ ${stats.publishFail} -> ${safeRate(stats.publishSuccess, stats.publishFail)}%`);
          console.log(`    Query:         ✅ ${stats.querySuccess} / ❌ ${stats.queryFail} -> ${safeRate(stats.querySuccess, stats.queryFail)}%`);
          console.log(`    Local Get:     ✅ ${stats.localGetSuccess} / ❌ ${stats.localGetFail} -> ${safeRate(stats.localGetSuccess, stats.localGetFail)}%`);
          console.log(`    Get:           ✅ ${stats.remoteGetSuccess} / ❌ ${stats.remoteGetFail} -> ${safeRate(stats.remoteGetSuccess, stats.remoteGetFail)}%`);
          console.log(`    Avg Publish Time:   ${formatDuration(stats.avgPublishMs)}`);
          console.log(`    Avg Query Time:     ${formatDuration(stats.avgQueryMs)}`);
          console.log(`    Avg Local Get Time: ${formatDuration(stats.avgLocalGetMs)}`);
          console.log(`    Avg Get Time:       ${formatDuration(stats.avgRemoteGetMs)}`);
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
