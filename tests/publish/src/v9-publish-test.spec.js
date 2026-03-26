import { strict as assert } from 'assert';
import fs from 'fs';
import 'dotenv/config';

import {
  DKG_API_URL,
  DKG_PARANET_ID,
  BLOCKCHAIN_NAME,
  TEST_ENTITY_COUNT,
  TEST_CONTENT_SIZE_KB,
  TEST_KA_BATCHES,
  TEST_PARALLEL_KA_BATCH_SIZE,
  TEST_BATCH_DELAY_MS,
  buildQuads,
  httpPublish,
  httpQuery,
  httpStatus,
  httpCreateParanet,
  safeRate,
  formatDuration,
  sleep,
  logError,
  categorizeErrorService,
} from './helpers.js';

const NODE_NAME = process.env.NODE_NAME || 'Local Node';

const errorStats = {};

describe('DKG v9 Publish/Query Lifecycle', function () {
  this.timeout(120 * 60 * 1000);

  before(async function () {
    console.log(`\n--- Pre-flight: checking node at ${DKG_API_URL}`);
    try {
      const status = await httpStatus();
      console.log(`Node "${status.name}" is running (peerId: ${status.peerId})`);
    } catch (err) {
      console.error(`Node not reachable at ${DKG_API_URL}: ${err.message}`);
      throw err;
    }

    console.log(`--- Ensuring paranet "${DKG_PARANET_ID}" exists`);
    try {
      await httpCreateParanet(DKG_PARANET_ID, 'V9 Publish Test Paranet', 'Automated publish/query test paranet');
      console.log(`Paranet "${DKG_PARANET_ID}" created`);
    } catch (err) {
      console.log(`Paranet setup: ${err.message} (may already exist, continuing)`);
    }
  });

  it('should publish and query KAs sequentially in batches', async function () {
    let publishSuccess = 0;
    let publishFail = 0;
    let querySuccess = 0;
    let queryFail = 0;
    let assetQuerySuccess = 0;
    let assetQueryFail = 0;
    let totalKAsMinted = 0;

    const publishDurations = [];
    const queryDurations = [];
    const assetQueryDurations = [];

    const failedAssets = [];
    let firstSuccessfulRootEntity = null;
    const FALLBACK_UAL = 'did:dkg:base:84532/0x92c6db7e977F782101d794A7e1222acc95630617/17839';

    const totalPublishes = TEST_PARALLEL_KA_BATCH_SIZE * TEST_KA_BATCHES;
    const totalBatches = TEST_KA_BATCHES;

    console.log(`\n--- Test configuration ---`);
    console.log(`Node: ${NODE_NAME}`);
    console.log(`Blockchain: ${BLOCKCHAIN_NAME}`);
    console.log(`API: ${DKG_API_URL}`);
    console.log(`Paranet: ${DKG_PARANET_ID}`);
    console.log(`Batches: ${TEST_KA_BATCHES} x ${TEST_PARALLEL_KA_BATCH_SIZE} = ${totalPublishes} total publishes`);
    console.log(`Expected KAs per publish: ~${TEST_ENTITY_COUNT + 1} (${TEST_ENTITY_COUNT} entities + 1 root)`);
    console.log(`Entity count per KA: ${TEST_ENTITY_COUNT}`);
    console.log(`Target payload size: ~${TEST_CONTENT_SIZE_KB} KB`);
    if (TEST_BATCH_DELAY_MS > 0) {
      console.log(`Batch delay: ${TEST_BATCH_DELAY_MS} ms`);
    }

    const processKnowledgeAsset = async (kaNumber) => {
      console.log(`\nPublishing KA #${kaNumber} on ${NODE_NAME}`);
      let step = 'publishing';
      let rootEntity = null;
      let kcId = null;

      // ---- Step 1: Publish ----
      try {
        const { quads, rootEntity: root } = buildQuads(NODE_NAME, kaNumber);
        rootEntity = root;

        const publishStart = performance.now();
        const result = await Promise.race([
          httpPublish(DKG_PARANET_ID, quads),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after 6 minutes during "publishing"`)), 6 * 60 * 1000),
          ),
        ]);
        const publishEnd = performance.now();
        publishDurations.push(publishEnd - publishStart);

        assert.ok(result);
        if (result.status !== 'confirmed') {
          const phaseInfo = result.phases ? ` | phases: ${JSON.stringify(result.phases)}` : '';
          throw new Error(`Publish returned "${result.status}" instead of "confirmed" (kcId: ${result.kcId}, serverTotal: ${result.serverTotal}ms${phaseInfo}) — check node logs for on-chain error`);
        }
        assert.ok(result.kcId !== undefined && result.kcId !== '0', `Publish response missing valid kcId (got ${result.kcId})`);
        kcId = result.kcId;
        const kasCreated = result.kas?.length || 0;
        totalKAsMinted += kasCreated;
        const ual = result.publisherAddress ? `did:dkg:${BLOCKCHAIN_NAME.replace('v9:', '')}/${result.publisherAddress}/${kcId}` : null;
        const ualInfo = ual ? ` | UAL: ${ual}` : '';
        const txInfo = result.txHash ? ` | txHash: ${result.txHash}` : '';
        console.log(`✅ Published KA #${kaNumber}${ualInfo} | kcId: ${kcId} | status: ${result.status} | KAs: ${kasCreated}${txInfo}`);
        publishSuccess++;
        if (!firstSuccessfulRootEntity) firstSuccessfulRootEntity = rootEntity;
      } catch (error) {
        logError(error, NODE_NAME, step, errorStats, kaNumber);
        failedAssets.push(`KA #${kaNumber} (Publish failed — kcId: ${kcId || 'N/A'})`);
        publishFail++;

        if (firstSuccessfulRootEntity) {
          rootEntity = firstSuccessfulRootEntity;
          console.log(`ℹ️  Using first successful root entity for remaining operations`);
        } else {
          rootEntity = FALLBACK_UAL;
          console.log(`ℹ️  Using fallback UAL for remaining operations: ${FALLBACK_UAL}`);
        }
      }

      // ---- Step 2: Asset Query (SPARQL lookup of published root entity) ----
      try {
        step = 'asset-query';
        const assetSparql = `SELECT ?p ?o WHERE { <${rootEntity}> ?p ?o } LIMIT 5`;

        const aqStart = performance.now();
        const aqResult = await Promise.race([
          httpQuery(assetSparql, DKG_PARANET_ID),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after 6 minutes during "asset-query"`)), 6 * 60 * 1000),
          ),
        ]);
        const aqEnd = performance.now();
        assetQueryDurations.push(aqEnd - aqStart);

        assert.ok(aqResult?.result, 'Asset Query returned no result');
        const bindings = aqResult.result.bindings || aqResult.result;
        const hasData = Array.isArray(bindings) ? bindings.length > 0 : !!bindings;
        assert.ok(hasData, `Asset Query returned empty results for ${rootEntity}`);
        console.log(`✅ Asset Query succeeded`);
        assetQuerySuccess++;
      } catch (error) {
        logError(error, NODE_NAME, step, errorStats, kaNumber);
        failedAssets.push(`KA #${kaNumber} (Asset Query failed — kcId: ${kcId})`);
        assetQueryFail++;
      }

      // ---- Step 3: Global Query ----
      try {
        step = 'global-query';
        const generalSparql = `PREFIX schema: <http://schema.org/>
SELECT ?s ?name ?description WHERE {
  ?s schema:name ?name ;
     schema:description ?description .
} LIMIT 10`;

        const queryStart = performance.now();
        const queryResult = await Promise.race([
          httpQuery(generalSparql, DKG_PARANET_ID),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after 6 minutes during "global-query"`)), 6 * 60 * 1000),
          ),
        ]);
        const queryEnd = performance.now();
        queryDurations.push(queryEnd - queryStart);

        assert.ok(queryResult?.result, 'Global Query returned no result');
        console.log(`✅ Global Query succeeded`);
        querySuccess++;
      } catch (error) {
        logError(error, NODE_NAME, step, errorStats, kaNumber);
        failedAssets.push(`KA #${kaNumber} (Global Query failed — kcId: ${kcId})`);
        queryFail++;
      }
    };

    // ---- Run batches (same pattern as V8) ----
    for (let batch = 0; batch < totalBatches; batch++) {
      const startKa = batch * TEST_PARALLEL_KA_BATCH_SIZE + 1;
      const batchKAs = Array.from(
        { length: TEST_PARALLEL_KA_BATCH_SIZE },
        (_, idx) => startKa + idx,
      );

      console.log(`\n▶ Running batch ${batch + 1}/${totalBatches}`);
      await Promise.all(batchKAs.map((kaNumber) => processKnowledgeAsset(kaNumber)));

      if (TEST_BATCH_DELAY_MS > 0 && batch < totalBatches - 1) {
        await sleep(TEST_BATCH_DELAY_MS);
      }
    }

    // ---- Compute averages ----
    const avgPublishMs = publishDurations.length > 0
      ? publishDurations.reduce((a, b) => a + b, 0) / publishDurations.length : 0;
    const avgQueryMs = queryDurations.length > 0
      ? queryDurations.reduce((a, b) => a + b, 0) / queryDurations.length : 0;
    const avgAssetQueryMs = assetQueryDurations.length > 0
      ? assetQueryDurations.reduce((a, b) => a + b, 0) / assetQueryDurations.length : 0;

    // ---- Print summary ----
    console.log(`\n──────────── Summary for ${NODE_NAME} ────────────`);
    if (failedAssets.length > 0) {
      console.log(`🔍 Failed Assets:`);
      failedAssets.forEach((entry) => console.log(`  - ${entry}`));
    } else {
      console.log(`✅ All assets processed successfully`);
    }
    console.log(`🔢 Total KAs minted: ${totalKAsMinted} (across ${publishSuccess} successful publishes)`);

    console.log(`\n🔗 Blockchain: ${BLOCKCHAIN_NAME}`);
    console.log(`  • ${NODE_NAME}:`);
    console.log(`    Publish:       ✅ ${publishSuccess} / ❌ ${publishFail} -> ${safeRate(publishSuccess, publishFail)}%`);
    console.log(`    Asset Query:   ✅ ${assetQuerySuccess} / ❌ ${assetQueryFail} -> ${safeRate(assetQuerySuccess, assetQueryFail)}%`);
    console.log(`    Global Query:  ✅ ${querySuccess} / ❌ ${queryFail} -> ${safeRate(querySuccess, queryFail)}%`);
    console.log(`    Avg Publish Time:       ${formatDuration(avgPublishMs)}`);
    console.log(`    Avg Asset Query Time:   ${formatDuration(avgAssetQueryMs)}`);
    console.log(`    Avg Global Query Time:  ${formatDuration(avgQueryMs)}`);

    // ---- Write summary JSON (compatible with V8 DB schema) ----
    const summary = {
      blockchain_name: BLOCKCHAIN_NAME,
      node_name: NODE_NAME,
      publish_success_rate: safeRate(publishSuccess, publishFail),
      query_success_rate: safeRate(querySuccess, queryFail),
      publisher_get_success_rate: safeRate(assetQuerySuccess, assetQueryFail),
      non_publisher_get_success_rate: '0.00',
      average_publish_time: (avgPublishMs / 1000).toFixed(2),
      average_query_time: (avgQueryMs / 1000).toFixed(2),
      average_publisher_get_time: (avgAssetQueryMs / 1000).toFixed(2),
      average_non_publisher_get_time: '0.00',
      time_stamp: new Date().toISOString(),
    };

    const summaryFile = `summary_${NODE_NAME.replace(/\s+/g, '_')}.json`;
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
    console.log(`✅ Saved summary to ${summaryFile}`);

    // ---- Write error JSON (compatible with V8 DB schema) ----
    const errorData = {
      blockchain_id: BLOCKCHAIN_NAME,
      aggregated: errorStats[NODE_NAME]?.aggregated || {},
      detailed: errorStats[NODE_NAME]?.detailed || {},
      services: errorStats[NODE_NAME]?.services || {},
    };
    const errorsFile = `errors_${NODE_NAME.replace(/\s+/g, '_')}.json`;
    fs.writeFileSync(errorsFile, JSON.stringify(errorData, null, 2));
    console.log(`✅ Saved errors to ${errorsFile}`);
  });

  after(() => {
    console.log(`\n\nError Breakdown by Node:`);
    Object.entries(errorStats).forEach(([nodeName, errors]) => {
      console.log(`\n${nodeName}`);

      if (errors.aggregated && Object.keys(errors.aggregated).length > 0) {
        Object.entries(errors.aggregated).forEach(([message, count]) => {
          const service = errors.services?.[message] || '';
          const serviceLabel = service ? ` [${service}]` : '';
          console.log(`  • ${count}x ${message}${serviceLabel}`);
        });
      } else {
        console.log(`  ✅ No errors`);
      }
    });
  });
});
