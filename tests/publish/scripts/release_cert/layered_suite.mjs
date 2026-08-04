// Layered suite (M3): explicit WM → SWM → VM stages with receiver-side
// verification and a payload-size matrix, recorded per-layer into
// publish_layer_ops. This is the release-certification counterpart of the
// one-call publish suite — the existing suite and jobs stay untouched.
//
//   RC_PUBLISHER_URL / RC_PUBLISHER_TOKEN_ENV   publishing node (default TestNode1)
//   RC_RECEIVER_URL  / RC_RECEIVER_TOKEN_ENV    paired receiver  (default TestNode2)
//   RC_RECEIVER_PEER_ID                         receiver peer id (else read from its /api/status)
//   RC_CG_PUBLIC / RC_CG_PRIVATE                CG ids (default: weekly rotation names; private optional)
//   RC_SIZES_KB                                 comma list, default 1,100,1024,3584
//   RC_SIZE_KB                                  force one size (else rotates by half-hour slot)
//   RC_ENTITIES                                 child entities per KA (default 50)
//   RC_ITERATIONS                               iterations per run (default 1)
//   PUBLISH_EPOCHS                              must equal the PCA lock epochs (12 on the Jenkins jobs)
//   RC_DRY                                      "1" = print rows, skip DB
//
// Metric honesty: client_ms is recorded ONLY on success; failures carry the
// normalized error text instead. A timeout is a failure of the operation as
// observed by the client — server-side completion later is visible in the logs,
// not silently credited here.
import { randomUUID } from 'crypto';
import { connectDb, ensureSchema } from './db.mjs';
import { longFetch } from '../../src/v10-helpers.js';
import 'dotenv/config';

const DRY = process.env.RC_DRY === '1';
const PUBLISH_EPOCHS = Number(process.env.PUBLISH_EPOCHS || 12);
const SIZES = (process.env.RC_SIZES_KB || '1,100,1024,3584').split(',').map(Number).filter(Boolean);
const ENTITIES = Number(process.env.RC_ENTITIES || 50);
const ITERATIONS = Number(process.env.RC_ITERATIONS || 1);
const BLOCKCHAIN = process.env.BLOCKCHAIN_NAME || 'v10:base:84532';

export function weeklyCgNames(now = new Date()) {
    // ISO week id, e.g. release-cert-2026W31
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const week = Math.ceil((((d - Date.parse(`${d.getUTCFullYear()}-01-01`)) / 86400000) + 1) / 7);
    const wk = `${d.getUTCFullYear()}W${String(week).padStart(2, '0')}`;
    return {
        public: `release-cert-${wk}`,
        private: `release-cert-${wk}-priv`,
        aging: 'release-cert-aging',
    };
}

function client(baseUrl, token) {
    async function req(method, path, body, accept) {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${String(token).trim()}`;
        const res = await longFetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        const ok = accept ? accept.includes(res.status) : res.ok;
        if (!ok) {
            const err = new Error(data.error || data.contextGraphError || `HTTP ${res.status}`);
            err.statusCode = res.status;
            throw err;
        }
        return data;
    }
    return {
        status: () => req('GET', '/api/status'),
        create: (contextGraphId, name, quads) => req('POST', '/api/knowledge-assets', { contextGraphId, name, quads }, [200, 201]),
        finalize: (name, contextGraphId) => req('POST', `/api/knowledge-assets/${encodeURIComponent(name)}/wm/finalize`, { contextGraphId }),
        share: (name, contextGraphId) => req('POST', `/api/knowledge-assets/${encodeURIComponent(name)}/swm/share`, { contextGraphId }, [200, 201, 202, 207]),
        vmPublish: (name, contextGraphId) => req('POST', `/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`, { contextGraphId, publishEpochs: PUBLISH_EPOCHS }, [200, 201, 207]),
        query: (sparql, contextGraphId, view) => req('POST', '/api/query', { sparql, contextGraphId, view }),
        queryRemote: (peerId, contextGraphId, ual) => req('POST', '/api/query-remote', { peerId, contextGraphId, lookupType: 'ENTITY_BY_UAL', ual }),
    };
}

// Parameterized variant of the harness buildQuads (same shape/limits, size as arg).
const FILLER_BODY = 16 * 1024;
export function buildQuadsSized(tag, sizeKb, entities) {
    const rootId = `urn:ka:rc-${tag}-${randomUUID()}`;
    const quads = [];
    const add = (s, p, o) => quads.push({ subject: s, predicate: p, object: o, graph: '' });
    const lit = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    add(rootId, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://schema.org/Dataset');
    add(rootId, 'http://schema.org/name', lit(`release-cert ${tag} ${new Date().toISOString()}`));
    add(rootId, 'urn:dkg:entityCount', lit(entities));
    for (let i = 1; i <= entities; i++) {
        const e = `urn:entity:rc:${tag}:${i}:${randomUUID()}`;
        add(e, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://schema.org/Thing');
        add(e, 'http://schema.org/name', lit(`rc-${i}`));
        add(e, 'http://schema.org/isPartOf', rootId);
    }
    const target = sizeKb * 1024;
    let bytes = Buffer.byteLength(JSON.stringify(quads), 'utf8');
    let chunk = 0;
    const sentence = 'release certification filler payload for size-matrix coverage. ';
    while (bytes < target) {
        const empty = { subject: rootId, predicate: `urn:dkg:filler:${String(chunk).padStart(6, '0')}`, object: lit(''), graph: '' };
        const structural = 1 + Buffer.byteLength(JSON.stringify(empty), 'utf8');
        const avail = target - bytes - structural;
        if (avail <= 0) break;
        const body = sentence.repeat(Math.ceil(Math.min(FILLER_BODY, avail) / sentence.length)).slice(0, Math.min(FILLER_BODY, avail));
        const filler = { ...empty, object: lit(body) };
        quads.push(filler);
        bytes += 1 + Buffer.byteLength(JSON.stringify(filler), 'utf8');
        chunk += 1;
    }
    return { rootId, quads };
}

function pickSizeKb() {
    if (process.env.RC_SIZE_KB) return Number(process.env.RC_SIZE_KB);
    const slot = Math.floor(Date.now() / (30 * 60 * 1000));
    return SIZES[slot % SIZES.length];
}

const rows = [];
function record(runId, nodeName, layer, cgKind, sizeKb, success, clientMs, error, version, details) {
    rows.push({
        run_id: runId, node_name: process.env.RC_NODE_LABEL ? `${process.env.RC_NODE_LABEL}/${nodeName}` : nodeName,
        blockchain_name: BLOCKCHAIN, layer, cg_kind: cgKind,
        payload_size_kb: sizeKb, success, client_ms: success ? Math.round(clientMs) : null,
        server_ms: null, error: error ? String(error).slice(0, 300) : null, node_version: version,
        details: details ?? null,
    });
    const mark = success ? '✅' : '❌';
    console.log(`${mark} [${cgKind}/${sizeKb}KB] ${layer}${success ? ` ${Math.round(clientMs)}ms` : ` — ${String(error).slice(0, 160)}`}`);
}

async function timed(fn) {
    const t0 = Date.now();
    const value = await fn();
    return { value, ms: Date.now() - t0 };
}

// Same response-shape handling as the burst suite's queryHasData().
export function queryHasData(result) {
    if (!result) return false;
    if (Array.isArray(result.results)) return result.results.length > 0;
    if (result.data && Array.isArray(result.data.results)) return result.data.results.length > 0;
    if (result.result && Array.isArray(result.result.bindings)) return result.result.bindings.length > 0;
    if (result.results && Array.isArray(result.results.bindings)) return result.results.bindings.length > 0;
    return false;
}

async function retry(fn, tries, delayMs) {
    let last;
    for (let i = 0; i < tries; i++) {
        try { return await fn(); } catch (e) { last = e; }
        await new Promise((r) => setTimeout(r, delayMs));
    }
    throw last;
}

async function runIteration(pub, recv, receiverPeerId, cgId, cgKind, sizeKb, runId, version) {
    const kaName = `rc-${cgKind}-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const { rootId, quads } = buildQuadsSized(cgKind, sizeKb, ENTITIES);
    let ual = null;

    // WM: create draft + finalize + read back
    try {
        const { ms } = await timed(async () => {
            await pub.create(cgId, kaName, quads);
            await pub.finalize(kaName, cgId);
            const q = await pub.query(`SELECT ?p WHERE { <${rootId}> ?p ?o } LIMIT 1`, cgId, 'working-memory');
            if (!queryHasData(q)) throw new Error('WM read-back found nothing for the root entity');
        });
        record(runId, 'TestNode1', 'wm', cgKind, sizeKb, true, ms, null, version);
    } catch (e) {
        record(runId, 'TestNode1', 'wm', cgKind, sizeKb, false, null, e.message, version);
        return; // later layers depend on the draft
    }

    // SWM share (publisher-side ACK'd share)
    try {
        const { ms } = await timed(() => pub.share(kaName, cgId));
        record(runId, 'TestNode1', 'swm', cgKind, sizeKb, true, ms, null, version);
    } catch (e) {
        record(runId, 'TestNode1', 'swm', cgKind, sizeKb, false, null, e.message, version);
    }

    // SWM receiver verification (gossip is async — poll)
    try {
        const { ms } = await timed(() => retry(async () => {
            const q = await recv.query(`SELECT ?p WHERE { <${rootId}> ?p ?o } LIMIT 1`, cgId, 'shared-working-memory');
            if (!queryHasData(q)) throw new Error('receiver has no SWM copy of the root entity yet');
        }, 20, 3000));
        record(runId, 'TestNode2', 'swm_receiver', cgKind, sizeKb, true, ms, null, version);
    } catch (e) {
        record(runId, 'TestNode2', 'swm_receiver', cgKind, sizeKb, false, null, e.message, version);
    }

    // VM publish (on-chain)
    try {
        const { value, ms } = await timed(() => pub.vmPublish(kaName, cgId));
        ual = value?.ual || null;
        const status = value?.status;
        if (status && !['vm-confirmed', 'confirmed'].includes(status)) throw new Error(`vm publish status=${status}`);
        record(runId, 'TestNode1', 'vm', cgKind, sizeKb, true, ms, null, version, { ual, txHash: value?.txHash ?? null, storageAckPeerIds: value?.storageAckPeerIds ?? null });
    } catch (e) {
        record(runId, 'TestNode1', 'vm', cgKind, sizeKb, false, null, e.message, version);
    }

    // VM local read-back
    try {
        const { ms } = await timed(() => retry(async () => {
            const q = await pub.query(`SELECT ?p WHERE { <${rootId}> ?p ?o } LIMIT 1`, cgId, 'verifiable-memory');
            if (!queryHasData(q)) throw new Error('VM read-back found nothing');
        }, 8, 3000));
        record(runId, 'TestNode1', 'vm_get', cgKind, sizeKb, true, ms, null, version);
    } catch (e) {
        record(runId, 'TestNode1', 'vm_get', cgKind, sizeKb, false, null, e.message, version);
    }

    // Cross-node read of the published UAL from the receiver's peer
    if (ual && receiverPeerId) {
        try {
            const { ms } = await timed(() => retry(async () => {
                const r = await pub.queryRemote(receiverPeerId, cgId, ual);
                if (!(r?.status === 'OK' || r?.ntriples)) throw new Error(`query-remote answered without triples (${JSON.stringify(r).slice(0, 120)})`);
            }, 6, 5000));
            record(runId, 'TestNode1', 'query_remote', cgKind, sizeKb, true, ms, null, version);
        } catch (e) {
            record(runId, 'TestNode1', 'query_remote', cgKind, sizeKb, false, null, e.message, version);
        }
    }
}

async function main() {
    const pubUrl = process.env.RC_PUBLISHER_URL || 'http://100.99.142.87:9200';
    const recvUrl = process.env.RC_RECEIVER_URL || 'http://100.70.65.41:9200';
    const pub = client(pubUrl, process.env[process.env.RC_PUBLISHER_TOKEN_ENV || 'V10_TOKEN_TESTNET1']);
    const recv = client(recvUrl, process.env[process.env.RC_RECEIVER_TOKEN_ENV || 'V10_TOKEN_TESTNET2']);

    const [pubStatus, recvStatus] = await Promise.all([pub.status(), recv.status()]);
    const receiverPeerId = process.env.RC_RECEIVER_PEER_ID || recvStatus?.peerId || null;
    const version = pubStatus?.version ?? null;
    const names = weeklyCgNames();
    const cgs = process.env.RC_ONLY_CG
        ? [{ id: process.env.RC_ONLY_CG, kind: process.env.RC_ONLY_KIND || 'private' }]
        : [{ id: process.env.RC_CG_PUBLIC || names.public, kind: 'public' }];
    if (!process.env.RC_ONLY_CG) {
        if (process.env.RC_CG_PRIVATE) cgs.push({ id: process.env.RC_CG_PRIVATE, kind: 'private' });
        // Keep the permanent aging CG actually growing: one extra publish every 6 hours.
        if (new Date().getUTCHours() % 6 === 0 && new Date().getUTCMinutes() < 30) {
            cgs.push({ id: names.aging, kind: 'aging' });
        }
    }

    const sizeKb = pickSizeKb();
    const runId = `layered-${Date.now()}`;
    console.log(`🧪 layered suite: publisher=${pubUrl} receiver=${recvUrl} size=${sizeKb}KB iterations=${ITERATIONS} cgs=${cgs.map((c) => c.id).join(',')}`);

    for (let i = 0; i < ITERATIONS; i++) {
        for (const cg of cgs) {
            await runIteration(pub, recv, receiverPeerId, cg.id, cg.kind, sizeKb, runId, version);
        }
    }

    if (DRY) {
        console.log(JSON.stringify(rows, null, 1));
        return;
    }
    let db;
    try {
        db = await connectDb();
        await ensureSchema(db);
    } catch (e) {
        console.error(`❌ DB unavailable (${e.message}) — dumping rows so the run is not lost:`);
        console.log('ROWS_JSON ' + JSON.stringify(rows));
        process.exit(1);
    }
    try {
        for (const r of rows) {
            await db.query(
                `INSERT INTO publish_layer_ops (run_id, node_name, blockchain_name, layer, cg_kind, payload_size_kb, success, client_ms, server_ms, error, node_version, details)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [r.run_id, r.node_name, r.blockchain_name, r.layer, r.cg_kind, r.payload_size_kb, r.success, r.client_ms, r.server_ms, r.error, r.node_version, r.details ? JSON.stringify(r.details) : null],
            );
        }
    } catch (e) {
        console.error(`❌ insert failed (${e.message}) — dumping rows so the run is not lost:`);
        console.log('ROWS_JSON ' + JSON.stringify(rows));
        await db.end().catch(() => {});
        process.exit(1);
    }
    await db.end().catch(() => {});
    const ok = rows.filter((r) => r.success).length;
    console.log(`✅ layered run recorded: ${ok}/${rows.length} ops succeeded`);
}

import { pathToFileURL } from 'url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error(`❌ layered suite fatal: ${err.message}`);
        process.exit(1);
    });
}
