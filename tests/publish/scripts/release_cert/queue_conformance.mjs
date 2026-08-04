// Queue conformance (Q1, first scenario): prove that publish-critical work
// still completes while a background query flood occupies the store.
// Conservative by default — a short, bounded flood on one designated beacon,
// off-peak. Observable surfaces only: /api/status backpressure + op outcomes.
//
//   RC_QC_NODE_URL / RC_QC_TOKEN_ENV   flooded node (default TestNode4)
//   RC_QC_FLOOD                        parallel query loops (default 6)
//   RC_QC_SECONDS                      flood duration (default 120)
//   RC_QC_PUBLISH_BUDGET_MS            publish must finish within (default 180000)
import { weeklyCgNames, buildQuadsSized } from './layered_suite.mjs';
import { longFetch } from '../../src/v10-helpers.js';
import 'dotenv/config';

const nodeUrl = process.env.RC_QC_NODE_URL || 'http://100.65.228.120:9200';
const token = process.env[process.env.RC_QC_TOKEN_ENV || 'V10_TOKEN_TESTNET4'];
const FLOOD = Number(process.env.RC_QC_FLOOD || 6);
const SECONDS = Number(process.env.RC_QC_SECONDS || 120);
const PUBLISH_BUDGET_MS = Number(process.env.RC_QC_PUBLISH_BUDGET_MS || 180000);
const PUBLISH_EPOCHS = Number(process.env.PUBLISH_EPOCHS || 12);

async function api(pathname, body, method) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${String(token).trim()}`;
    const res = await longFetch(`${nodeUrl}${pathname}`, { method: method || (body ? 'POST' : 'GET'), headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) throw new Error(data.error || `HTTP ${res.status} on ${pathname}`);
    return data;
}

const snapshots = [];
async function snapshot(label) {
    try {
        const s = await api('/api/status');
        snapshots.push({ label, at: new Date().toISOString(), state: s?.backpressure?.state ?? null, schedulers: s?.backpressure?.schedulers ?? null, admission: s?.admission ?? null });
    } catch (e) { snapshots.push({ label, error: e.message }); }
}

async function main() {
    const cg = weeklyCgNames().public;
    console.log(`🧯 queue conformance on ${nodeUrl}: flood=${FLOOD}x for ${SECONDS}s, publish budget ${PUBLISH_BUDGET_MS}ms, CG ${cg}`);
    await snapshot('before');

    const stopAt = Date.now() + SECONDS * 1000;
    let queriesDone = 0, queriesFailed = 0;
    const flooders = Array.from({ length: FLOOD }, async () => {
        while (Date.now() < stopAt) {
            try {
                await api('/api/query', { sparql: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 20000', contextGraphId: cg, view: 'verifiable-memory' });
                queriesDone += 1;
            } catch { queriesFailed += 1; }
        }
    });

    const midSnapshots = (async () => {
        while (Date.now() < stopAt) {
            await new Promise((r) => setTimeout(r, 15000));
            await snapshot('during');
        }
    })();

    // The invariant under test: a publish admitted while the store is flooded
    // must still complete inside its budget (ACK/normal lanes never starve).
    await new Promise((r) => setTimeout(r, 10000)); // let the flood establish
    const { rootId, quads } = buildQuadsSized('qc', 1, 10);
    const t0 = Date.now();
    let publishOk = false, publishMs = null, publishErr = null;
    try {
        const res = await api('/api/knowledge-assets', {
            contextGraphId: cg, name: `rc-qc-${Date.now()}`, quads,
            alsoShareSwm: true, alsoPublishVm: { publishEpochs: PUBLISH_EPOCHS },
        });
        publishMs = Date.now() - t0;
        publishOk = ['vm-confirmed', 'confirmed'].includes(res?.status) && publishMs <= PUBLISH_BUDGET_MS;
        if (!publishOk) publishErr = `status=${res?.status} in ${publishMs}ms (budget ${PUBLISH_BUDGET_MS}ms)`;
    } catch (e) {
        publishMs = Date.now() - t0;
        publishErr = e.message;
    }

    await Promise.all([...flooders, midSnapshots]);
    await snapshot('after');

    console.log('\n=== QUEUE CONFORMANCE REPORT ===');
    console.log(`flood: ${queriesDone} queries completed, ${queriesFailed} rejected/failed (rejections under pressure are ALLOWED — they are the scheduler doing its job)`);
    console.log(`publish under flood: ${publishOk ? `✅ completed in ${publishMs}ms` : `❌ ${publishErr}`}`);
    for (const s of snapshots) console.log(`  [${s.label}] ${s.error ? 'error: ' + s.error : `state=${s.state} schedulers=${JSON.stringify(s.schedulers)} admission=${JSON.stringify(s.admission)}`}`);
    console.log('SNAPSHOTS_JSON ' + JSON.stringify(snapshots));
    console.log(publishOk
        ? '✅ INVARIANT HELD: publish-critical work completed within budget under background flood.'
        : '🔴 INVARIANT VIOLATED: publish did not complete within budget while the store was flooded — this is the ACK/normal-lane starvation class.');
    process.exit(publishOk ? 0 : 1);
}

main().catch((err) => {
    console.error(`❌ conformance fatal: ${err.message}`);
    process.exit(1);
});
