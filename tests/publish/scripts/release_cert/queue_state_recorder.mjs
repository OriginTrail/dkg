// Queue-state recorder (M1): polls each node's /api/status (public) and, when a
// token is configured, /api/diagnostics/backpressure (node-admin) — and writes
// rows into queue_snapshots for the Release Certification dashboard.
//
// Runs a bounded loop so it fits a scheduled Jenkins job:
//   RC_DURATION_S  total loop time (default 840 = 14 min, for a 15-min cron)
//   RC_INTERVAL_S  poll interval  (default 30)
//   RC_NODES       JSON array [{name, url, tokenEnv?}] (default: 4 testnet beacons)
//   RC_DRY         "1" = print rows instead of inserting (no DB needed)
//
// Tolerant by design: npm-release nodes report backpressure:null — we still
// record admission counters and overall state; canary/monorepo builds add the
// per-scheduler diagnostics. Raw fragments are kept in JSONB for panels to use
// before the parser learns every shape.
import { connectDb, ensureSchema } from './db.mjs';
import 'dotenv/config';

const DEFAULT_NODES = [
    { name: 'TestNode1', url: 'http://100.99.142.87:9200', tokenEnv: 'V10_TOKEN_TESTNET1', network: 'testnet' },
    { name: 'TestNode2', url: 'http://100.70.65.41:9200', tokenEnv: 'V10_TOKEN_TESTNET2', network: 'testnet' },
    { name: 'TestNode3', url: 'http://100.120.12.74:9200', tokenEnv: 'V10_TOKEN_TESTNET3', network: 'testnet' },
    { name: 'TestNode4', url: 'http://100.65.228.120:9200', tokenEnv: 'V10_TOKEN_TESTNET4', network: 'testnet' },
];

const DURATION_S = Number(process.env.RC_DURATION_S || 840);
const INTERVAL_S = Number(process.env.RC_INTERVAL_S || 30);
const DRY = process.env.RC_DRY === '1';

function nodes() {
    if (!process.env.RC_NODES) return DEFAULT_NODES;
    try {
        const parsed = JSON.parse(process.env.RC_NODES);
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('RC_NODES must be a non-empty array');
        return parsed;
    } catch (err) {
        console.error(`❌ bad RC_NODES: ${err.message}`);
        process.exit(1);
    }
}

async function fetchJson(url, token, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetch(url, { headers, signal: ctrl.signal });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        return { json: await res.json() };
    } catch (err) {
        return { error: err.name === 'AbortError' ? 'timeout' : err.message };
    } finally {
        clearTimeout(t);
    }
}

// Build queue_snapshots rows from one node poll. Always yields a 'status' row;
// adds 'admission' and per-scheduler rows when the data exists.
function rowsFromPoll(node, status, diagnostics) {
    const rows = [];
    const version = status?.version ?? null;
    const network = node.network ?? status?.networkConfig ?? null;
    const base = { node_name: node.name, network, node_version: version };

    rows.push({
        ...base,
        source: 'status',
        lane: null,
        state: status?.backpressure?.state ?? (status ? 'no-backpressure-field' : 'unreachable'),
        queued: null,
        inflight: null,
        oldest_age_ms: null,
        active_ops: null,
        raw: status ? { backpressure: status.backpressure ?? null, uptimeMs: status.uptimeMs ?? null } : null,
    });

    if (status?.admission) {
        rows.push({
            ...base,
            source: 'admission',
            lane: null,
            state: null,
            queued: null,
            inflight: status.admission.inFlight ?? null,
            oldest_age_ms: null,
            active_ops: null,
            raw: status.admission,
        });
    }

    for (const sched of status?.backpressure?.schedulers ?? []) {
        rows.push({
            ...base,
            source: sched.scheduler ?? 'unknown',
            lane: null,
            state: sched.state ?? null,
            queued: null,
            inflight: null,
            oldest_age_ms: null,
            active_ops: null,
            raw: sched,
        });
    }

    // Diagnostics shape is defensive: we walk any {scheduler|source, lanes[]}
    // structure we find and keep the raw payload regardless, so panels can be
    // refined after the first real captures.
    if (diagnostics) {
        const groups = diagnostics.schedulers ?? diagnostics.sources ?? [];
        for (const group of Array.isArray(groups) ? groups : []) {
            const sourceName = group.scheduler ?? group.source ?? group.name ?? 'unknown';
            const lanes = group.lanes ?? group.queues ?? [];
            for (const laneEntry of Array.isArray(lanes) ? lanes : []) {
                rows.push({
                    ...base,
                    source: sourceName,
                    lane: laneEntry.lane ?? laneEntry.name ?? null,
                    state: laneEntry.state ?? group.state ?? null,
                    queued: laneEntry.queued ?? laneEntry.queueDepth ?? null,
                    inflight: laneEntry.inflight ?? laneEntry.active ?? null,
                    oldest_age_ms: laneEntry.oldestQueuedAgeMs ?? laneEntry.oldestAgeMs ?? null,
                    active_ops: laneEntry.activeOperations ?? laneEntry.queuedOperations ?? null,
                    raw: laneEntry,
                });
            }
            if (!Array.isArray(lanes) || lanes.length === 0) {
                rows.push({
                    ...base,
                    source: sourceName,
                    lane: null,
                    state: group.state ?? null,
                    queued: group.queued ?? null,
                    inflight: group.inflight ?? null,
                    oldest_age_ms: group.oldestQueuedAgeMs ?? null,
                    active_ops: group.activeOperations ?? null,
                    raw: group,
                });
            }
        }
        if (!Array.isArray(groups) || groups.length === 0) {
            rows.push({ ...base, source: 'diagnostics', lane: null, state: null, queued: null, inflight: null, oldest_age_ms: null, active_ops: null, raw: diagnostics });
        }
    }

    return rows;
}

async function pollNode(node) {
    const statusRes = await fetchJson(`${node.url}/api/status`);
    if (statusRes.error) {
        console.error(`⚠️ ${node.name} status: ${statusRes.error}`);
        return rowsFromPoll(node, null, null);
    }
    let diagnostics = null;
    const token = node.tokenEnv ? process.env[node.tokenEnv] : null;
    const advertised = statusRes.json?.backpressure?.diagnosticsAvailable;
    if (token && advertised) {
        const diagRes = await fetchJson(`${node.url}${advertised}`, token);
        if (diagRes.error) console.error(`⚠️ ${node.name} diagnostics: ${diagRes.error}`);
        else diagnostics = diagRes.json;
    }
    return rowsFromPoll(node, statusRes.json, diagnostics);
}

async function insertRows(client, rows) {
    for (const r of rows) {
        await client.query(
            `INSERT INTO queue_snapshots
             (node_name, network, node_version, source, lane, state, queued, inflight, oldest_age_ms, active_ops, raw)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [r.node_name, r.network, r.node_version, r.source, r.lane, r.state, r.queued, r.inflight, r.oldest_age_ms,
             r.active_ops ? JSON.stringify(r.active_ops) : null, r.raw ? JSON.stringify(r.raw) : null],
        );
    }
}

async function main() {
    const targets = nodes();
    let client = null;
    if (!DRY) {
        client = await connectDb();
        await ensureSchema(client);
    }
    const deadline = Date.now() + DURATION_S * 1000;
    let ticks = 0;
    let rowCount = 0;

    console.log(`📡 queue recorder: ${targets.length} node(s), every ${INTERVAL_S}s for ${DURATION_S}s${DRY ? ' (dry run)' : ''}`);
    for (;;) {
        const tickStart = Date.now();
        const perNode = await Promise.all(targets.map((n) => pollNode(n)));
        const rows = perNode.flat();
        if (DRY) {
            console.log(JSON.stringify(rows, null, 1));
        } else {
            try {
                await insertRows(client, rows);
            } catch (err) {
                if (err.code === '42P01' || /does not exist/.test(err.message)) {
                    console.error('❌ queue_snapshots table missing — apply schema.sql once (DB owner), exiting early instead of looping');
                    process.exit(1);
                }
                console.error(`❌ insert failed: ${err.message}`);
            }
        }
        ticks += 1;
        rowCount += rows.length;
        if (Date.now() + INTERVAL_S * 1000 > deadline) break;
        const elapsed = Date.now() - tickStart;
        await new Promise((r) => setTimeout(r, Math.max(0, INTERVAL_S * 1000 - elapsed)));
    }

    console.log(`✅ recorder done: ${ticks} tick(s), ${rowCount} row(s)`);
    if (client) await client.end();
}

main().catch((err) => {
    console.error(`❌ recorder fatal: ${err.message}`);
    process.exit(1);
});
