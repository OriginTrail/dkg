// Cold-start sync test (M5): spin up a fresh throwaway edge node inside the
// job container, subscribe it to the release-cert CGs, and measure
// time-to-parity (exact triple-count parity vs the curator node). Records a
// `cold_start` row in publish_layer_ops. The throwaway home lives inside the
// Jenkins workspace and is deleted afterwards — it is never a funded home.
//
//   RC_CURATOR_URL / RC_CURATOR_TOKEN_ENV   node that hosts the CGs (default TestNode1)
//   RC_COLDSTART_CG                         CG to sync (default: the aging CG)
//   RC_COLDSTART_TIMEOUT_S                  parity budget (default 1800)
//   DKG_BIN                                 dkg CLI (default: `dkg` on PATH — job installs it)
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connectDb, ensureSchema } from './db.mjs';
import { weeklyCgNames } from './layered_suite.mjs';
import { longFetch } from '../../src/v10-helpers.js';
import 'dotenv/config';

const DKG_BIN = process.env.DKG_BIN || 'dkg';
const TIMEOUT_S = Number(process.env.RC_COLDSTART_TIMEOUT_S || 1800);
const API_PORT = Number(process.env.RC_COLDSTART_PORT || 9377);
const DRY = process.env.RC_DRY === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(base, pathname, { method = 'GET', token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${String(token).trim()}`;
    const res = await longFetch(`${base}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) throw new Error(data.error || `HTTP ${res.status} on ${pathname}`);
    return data;
}

async function countTriples(base, token, cg, view) {
    const q = await api(base, '/api/query', {
        method: 'POST', token,
        body: { sparql: 'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }', contextGraphId: cg, view },
    });
    const row = q?.result?.bindings?.[0] ?? q?.results?.bindings?.[0]
        ?? (Array.isArray(q?.results) ? q.results[0] : null)
        ?? (Array.isArray(q?.data?.results) ? q.data.results[0] : null)
        ?? (Array.isArray(q?.rows) ? q.rows[0] : null)
        ?? (Array.isArray(q?.bindings) ? q.bindings[0] : null);
    if (!row) {
        console.error(`countTriples(${view}): unrecognized response shape: ${JSON.stringify(q).slice(0, 280)}`);
        return null;
    }
    const first = Object.values(row)[0];
    const rawVal = first && typeof first === 'object' ? first.value : first;
    // values arrive as N-Triples typed literals, e.g. "0"^^<http://...#integer>
    const m = typeof rawVal === 'string' ? rawVal.match(/^"(-?\d+)"/) : null;
    const v = Number(m ? m[1] : rawVal);
    if (!Number.isFinite(v)) {
        console.error(`countTriples(${view}): row did not parse to a number: ${JSON.stringify(row).slice(0, 200)}`);
        return null;
    }
    return v;
}

async function main() {
    const curatorUrl = process.env.RC_CURATOR_URL || 'http://100.99.142.87:9200';
    const curatorToken = process.env[process.env.RC_CURATOR_TOKEN_ENV || 'V10_TOKEN_TESTNET1'];
    const cg = process.env.RC_COLDSTART_CG || weeklyCgNames().public;

    const home = fs.mkdtempSync(path.join(process.env.WORKSPACE || os.tmpdir(), 'rc-coldstart-'));
    console.log(`🧊 cold-start: fresh home ${home}, target CG ${cg}`);
    const env = { ...process.env, DKG_HOME: home };

    // Non-interactive bootstrap: write a minimal config directly (dkg init is
    // interactive; the daemon fills defaults for everything omitted).
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
        name: `rc-coldstart-${Date.now()}`,
        nodeRole: 'edge',
        networkConfig: 'testnet',
        apiPort: API_PORT,
        store: { backend: 'oxigraph' },
    }, null, 2));

    let daemon = null;
    let outcome = { success: false, ms: null, error: null, details: null };
    const t0 = Date.now();
    try {
        daemon = spawn(DKG_BIN, ['start', '-f'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        daemon.stdout.on('data', () => {});
        daemon.stderr.on('data', () => {});

        const base = `http://127.0.0.1:${API_PORT}`;
        let status = null;
        for (let i = 0; i < 60; i++) {
            await sleep(5000);
            try { status = await api(base, '/api/status'); break; } catch { /* booting */ }
        }
        if (!status) throw new Error('fresh node never answered /api/status within 5 min');
        const bootMs = Date.now() - t0;
        console.log(`• fresh node up in ${Math.round(bootMs / 1000)}s (version ${status.version})`);

        // auth.token carries a '# DKG node API token — …' comment line above the
        // token; take the last non-empty, non-comment line (same as loadAuthToken).
        const token = fs.readFileSync(path.join(home, 'auth.token'), 'utf8')
            .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).pop();
        if (!token) throw new Error('auth.token contained no token line');
        await api(base, '/api/context-graph/subscribe', { method: 'POST', token, body: { contextGraphId: cg, includeSharedMemory: true } });

        const deadline = Date.now() + TIMEOUT_S * 1000;
        let terminal = null;
        while (Date.now() < deadline) {
            const st = await api(base, `/api/sync/catchup-status?contextGraphId=${encodeURIComponent(cg)}`, { token });
            const s = st?.catchup?.status || st?.status || 'unknown';
            if (s === 'done') { terminal = st; break; }
            if (['failed', 'error', 'denied'].includes(s)) throw new Error(`catchup terminal status: ${s}`);
            await sleep(5000);
        }
        if (!terminal) throw new Error(`catchup did not complete within ${TIMEOUT_S}s`);
        const syncMs = Date.now() - t0;

        // Parity: exact triple-count comparison against the curator, per layer view.
        const [freshVm, curatorVm, freshSwm, curatorSwm] = await Promise.all([
            countTriples(base, token, cg, 'verifiable-memory'),
            countTriples(curatorUrl, curatorToken, cg, 'verifiable-memory'),
            countTriples(base, token, cg, 'shared-working-memory'),
            countTriples(curatorUrl, curatorToken, cg, 'shared-working-memory'),
        ]);
        const vmParity = freshVm !== null && freshVm === curatorVm;
        const swmParity = freshSwm !== null && freshSwm === curatorSwm;
        outcome.details = { cg, bootMs, syncMs, freshVm, curatorVm, freshSwm, curatorSwm, vmParity, swmParity };
        if (!vmParity || !swmParity) throw new Error(`parity mismatch: vm ${freshVm}/${curatorVm}, swm ${freshSwm}/${curatorSwm} (partial progress does not count)`);
        outcome.success = true;
        outcome.ms = syncMs;
        console.log(`✅ cold-start parity in ${Math.round(syncMs / 1000)}s (vm=${freshVm}, swm=${freshSwm})`);
    } catch (e) {
        outcome.error = e.message;
        console.error(`❌ cold-start: ${e.message}`);
    } finally {
        try { if (daemon) { execFileSync(DKG_BIN, ['stop'], { env, timeout: 30000 }); } } catch { try { daemon?.kill('SIGKILL'); } catch {} }
        try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    }

    if (!DRY) {
        const db = await connectDb();
        await ensureSchema(db);
        await db.query(
            `INSERT INTO publish_layer_ops (run_id, node_name, blockchain_name, layer, cg_kind, payload_size_kb, success, client_ms, error, node_version, details)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [`coldstart-${Date.now()}`, 'fresh-edge', process.env.BLOCKCHAIN_NAME || 'v10:base:84532', 'cold_start', 'public', null,
             outcome.success, outcome.success ? Math.round(outcome.ms) : null, outcome.error ? outcome.error.slice(0, 300) : null, null,
             outcome.details ? JSON.stringify(outcome.details) : null]);
        await db.end();
    }
    process.exit(outcome.success ? 0 : 1);
}

main().catch((err) => {
    console.error(`❌ cold-start fatal: ${err.message}`);
    process.exit(1);
});
