// Queue-incident auto-capture (Q3): checks the recent queue_snapshots for
// non-healthy backpressure states; when found (and not already captured in the
// last 30 min) it pulls a full evidence bundle straight from the node APIs —
// backpressure diagnostics, publisher stats, status — and stores it in the
// incidents table. Prints a ready-to-paste ListenerBoi investigation prompt.
// (Loki log excerpts are a later addition — they need a Grafana service token.)
//
//   RC_NODES        same JSON contract as the queue recorder
//   RC_FORCE_NODE   capture a bundle for this node name right now, alert or not
import { connectDb, ensureSchema } from './db.mjs';
import 'dotenv/config';

const DEFAULT_NODES = [
    { name: 'TestNode1', url: 'http://100.99.142.87:9200', tokenEnv: 'V10_TOKEN_TESTNET1' },
    { name: 'TestNode2', url: 'http://100.70.65.41:9200', tokenEnv: 'V10_TOKEN_TESTNET2' },
    { name: 'TestNode3', url: 'http://100.120.12.74:9200', tokenEnv: 'V10_TOKEN_TESTNET3' },
    { name: 'TestNode4', url: 'http://100.65.228.120:9200', tokenEnv: 'V10_TOKEN_TESTNET4' },
];

async function fetchJson(url, token) {
    try {
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        return await res.json();
    } catch (e) { return { error: e.message }; }
}

function listenerBoiPrompt(node, windowStart, bundle) {
    return [
        `@ListenerBoi investigate store-queue pressure on ${node} (read-only investigation).`,
        `Window: ${windowStart} → now (UTC). Evidence bundle captured by the release-cert harness is in the incidents table.`,
        `Observed: non-healthy backpressure state on ${node}; snapshot summary: ${JSON.stringify(bundle.status?.backpressure ?? {}).slice(0, 300)}`,
        'Standing question: which admitted store operation occupied the backend and exceeded its budget? The scheduler timeout labels identify queued victims, not the active blocking operation.',
        'Guardrails: read-only; do not restart services or run expensive production queries.',
    ].join('\n');
}

async function main() {
    const nodes = process.env.RC_NODES ? JSON.parse(process.env.RC_NODES) : DEFAULT_NODES;
    const db = await connectDb();
    await ensureSchema(db);

    let targets = [];
    if (process.env.RC_FORCE_NODE) {
        targets = nodes.filter((n) => n.name === process.env.RC_FORCE_NODE);
    } else {
        const { rows } = await db.query(
            `SELECT DISTINCT node_name FROM queue_snapshots
             WHERE time_stamp > now() - interval '10 minutes'
               AND source IN ('store','sync-global','status')
               AND state IS NOT NULL AND state NOT IN ('healthy','no-backpressure-field','unreachable')`);
        targets = nodes.filter((n) => rows.some((r) => r.node_name === n.name));
    }
    if (targets.length === 0) {
        console.log('no unhealthy backpressure states in the last 10 minutes');
        await db.end();
        return;
    }

    for (const node of targets) {
        const { rows: recent } = await db.query(
            `SELECT 1 FROM incidents WHERE node_name = $1 AND created_at > now() - interval '30 minutes'`, [node.name]);
        if (recent.length > 0 && !process.env.RC_FORCE_NODE) {
            console.log(`• ${node.name}: incident already captured in the last 30 min`);
            continue;
        }
        const token = node.tokenEnv ? process.env[node.tokenEnv] : null;
        const bundle = {
            status: await fetchJson(`${node.url}/api/status`),
            backpressure: await fetchJson(`${node.url}/api/diagnostics/backpressure`, token),
            publisherStats: await fetchJson(`${node.url}/api/publisher/stats`, token),
            capturedAt: new Date().toISOString(),
        };
        const windowStart = new Date(Date.now() - 10 * 60000).toISOString();
        await db.query(
            `INSERT INTO incidents (node_name, trigger, bundle) VALUES ($1, $2, $3)`,
            [node.name, process.env.RC_FORCE_NODE ? 'manual' : 'backpressure-unhealthy', JSON.stringify(bundle)]);
        console.log(`📦 incident bundle captured for ${node.name}`);
        console.log('--- ListenerBoi prompt (paste into #listenerboi-v0) ---');
        console.log(listenerBoiPrompt(node.name, windowStart, bundle));
        console.log('---');
    }
    await db.end();
}

main().catch((err) => {
    console.error(`❌ capture fatal: ${err.message}`);
    process.exit(1);
});
