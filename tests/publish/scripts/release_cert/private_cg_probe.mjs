// Private-CG lane probe (manager ask: SWM/VM success on private CGs too).
// Creates a curated CG with the curator + receiver agents allowlisted,
// subscribes the receiver, then runs one layered iteration against it.
// Green output here is the go-signal to enable the private lane in rotation.
//
//   RC_PUBLISHER_URL / RC_RECEIVER_URL + token envs — same contract as layered
//   RC_PROBE_REGISTER  "1" (default) = on-chain register (testnet TRAC)
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { longFetch } from '../../src/v10-helpers.js';
import 'dotenv/config';

const pubUrl = process.env.RC_PUBLISHER_URL || 'http://100.99.142.87:9200';
const recvUrl = process.env.RC_RECEIVER_URL || 'http://100.70.65.41:9200';
const pubToken = process.env[process.env.RC_PUBLISHER_TOKEN_ENV || 'V10_TOKEN_TESTNET1'];
const recvToken = process.env[process.env.RC_RECEIVER_TOKEN_ENV || 'V10_TOKEN_TESTNET2'];

async function api(base, pathname, token, body, method) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${String(token).trim()}`;
    const res = await longFetch(`${base}${pathname}`, { method: method || (body ? 'POST' : 'GET'), headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) {
        const err = new Error(data.error || `HTTP ${res.status} on ${pathname}`);
        err.body = data;
        throw err;
    }
    return data;
}

async function main() {
    const cgId = `release-cert-priv-probe-${Date.now()}`;
    console.log(`🔐 private-CG probe: ${cgId}`);

    const [pubIdent, recvIdent] = await Promise.all([
        api(pubUrl, '/api/agent/identity', pubToken),
        api(recvUrl, '/api/agent/identity', recvToken),
    ]);
    console.log(`• curator agent ${pubIdent.agentAddress} | receiver agent ${recvIdent.agentAddress}`);

    const createBody = {
        id: cgId, name: cgId, description: 'private-lane probe',
        accessPolicy: 1, publishPolicy: 0,
        allowedAgents: [pubIdent.agentAddress, recvIdent.agentAddress],
        participantAgents: [pubIdent.agentAddress, recvIdent.agentAddress],
        register: (process.env.RC_PROBE_REGISTER || '1') === '1',
    };
    const created = await api(pubUrl, '/api/context-graph/create', pubToken, createBody);
    console.log(`✅ created private CG: ${JSON.stringify(created).slice(0, 200)}`);

    // CURATED-CG JOIN FLOW — subscribing alone is not enough. The receiver
    // must request to join (signed delegation) and the curator must approve,
    // otherwise its catch-up reports `unreachable` and it never learns the
    // agent gate ("not-agent-gated" on the sender-key handshake).
    try {
        // sign-join produces the signed delegation that request-join forwards.
        const signed = await api(recvUrl, `/api/context-graph/${encodeURIComponent(cgId)}/sign-join`, recvToken, {});
        console.log(`• receiver sign-join: agent ${signed?.agentAddress ?? '?'}`);
        const jr = await api(recvUrl, `/api/context-graph/${encodeURIComponent(cgId)}/request-join`, recvToken, {
            curatorPeerId: pubIdent.peerId,
            delegation: signed?.delegation,
        });
        console.log(`• receiver request-join: ${JSON.stringify(jr).slice(0, 220)}`);
    } catch (e) {
        console.warn(`⚠️ join request failed: ${e.message}${e.body ? ' ' + JSON.stringify(e.body).slice(0, 220) : ''}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
    try {
        const pending = await api(pubUrl, `/api/context-graph/${encodeURIComponent(cgId)}/join-requests`, pubToken);
        console.log(`• curator sees join requests: ${JSON.stringify(pending).slice(0, 220)}`);
    } catch (e) { console.warn(`⚠️ join-requests read failed: ${e.message}`); }
    try {
        const ap = await api(pubUrl, `/api/context-graph/${encodeURIComponent(cgId)}/approve-join`, pubToken, { agentAddress: recvIdent.agentAddress });
        console.log(`• curator approve-join: ${JSON.stringify(ap).slice(0, 220)}`);
    } catch (e) {
        console.warn(`⚠️ approve-join failed: ${e.message}${e.body ? ' ' + JSON.stringify(e.body).slice(0, 200) : ''}`);
    }

    const sub = await api(recvUrl, '/api/context-graph/subscribe', recvToken, { contextGraphId: cgId, includeSharedMemory: true });
    console.log(`• receiver subscribe: ${JSON.stringify(sub).slice(0, 160)}`);

    // The receiver rejects the sender-key handshake with "not-agent-gated"
    // until it has actually SYNCED the CG's agent-gate definition (the
    // DKG_ALLOWED_AGENT / DKG_PARTICIPANT_AGENT rows live in the CG's meta
    // graph). Wait for its catch-up to reach a terminal state first.
    const catchupDeadline = Date.now() + Number(process.env.RC_PROBE_CATCHUP_MS || 240000);
    let lastStatus = null;
    while (Date.now() < catchupDeadline) {
        const st = await api(recvUrl, `/api/sync/catchup-status?contextGraphId=${encodeURIComponent(cgId)}`, recvToken);
        const status = st?.catchup?.status || st?.status || 'unknown';
        if (status !== lastStatus) { console.log(`   ↪ receiver catchup: ${status}`); lastStatus = status; }
        if (status === 'done') break;
        if (['failed', 'error', 'denied'].includes(status)) { console.warn(`⚠️ receiver catchup terminal: ${status}`); break; }
        await new Promise((r) => setTimeout(r, 3000));
    }

    // Verify the receiver can actually see the gate before we try to share.
    try {
        const gates = await api(recvUrl, `/api/context-graph/agents?contextGraphId=${encodeURIComponent(cgId)}`, recvToken);
        console.log(`• receiver sees allowed agents: ${JSON.stringify(gates).slice(0, 220)}`);
    } catch (e) {
        console.warn(`⚠️ receiver could not read the agent gate: ${e.message}`);
    }

    // Encrypted SWM needs each allowlisted agent's ENCRYPTION profile to be
    // discoverable — otherwise the sender-key handshake is rejected
    // ("SWM Sender Key setup rejected by N agent(s)"). Publish both profiles
    // and give discovery a moment before the first curated share.
    for (const [label, url, tok] of [['curator', pubUrl, pubToken], ['receiver', recvUrl, recvToken]]) {
        try {
            const r = await api(url, '/api/agent/publish-profile', tok, {});
            console.log(`• ${label} profile published: ${JSON.stringify(r).slice(0, 140)}`);
        } catch (e) {
            console.warn(`⚠️ ${label} profile publish failed: ${e.message} (sender-key handshake may be rejected)`);
        }
    }
    const settleMs = Number(process.env.RC_PROBE_PROFILE_SETTLE_MS || 20000);
    console.log(`• waiting ${settleMs}ms for agent-profile discovery`);
    await new Promise((r) => setTimeout(r, settleMs));

    // One layered iteration against ONLY this CG (kind=private).
    const layered = path.join(path.dirname(fileURLToPath(import.meta.url)), 'layered_suite.mjs');
    const child = spawn(process.execPath, [layered], {
        env: { ...process.env, RC_ONLY_CG: cgId, RC_ONLY_KIND: 'private', RC_SIZE_KB: '1', RC_DRY: process.env.RC_DRY || '' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
    child.stderr.on('data', (c) => { out += c; process.stderr.write(c); });
    const code = await new Promise((r) => child.on('close', r));

    const swmReceiverOk = out.includes('✅ [private/1KB] swm_receiver');
    const vmOk = out.includes('✅ [private/1KB] vm ');
    console.log('\n=== PRIVATE-CG PROBE VERDICT ===');
    console.log(`SWM gossip reached the allowlisted receiver: ${swmReceiverOk ? 'YES ✅' : 'NO ❌'}`);
    console.log(`VM publish on the private CG:                ${vmOk ? 'YES ✅' : 'NO ❌'}`);
    console.log(swmReceiverOk && vmOk
        ? '➡️  GREEN: enable the private lane (RC_ROTATE_PRIVATE=1 on CG_Rotate, RC_CG_PRIVATE on Layered).'
        : `➡️  NOT READY: inspect the layered output above (layered exit ${code} — DB-insert failures are expected until the schema lands and do not affect this verdict).`);
    process.exit(swmReceiverOk && vmOk ? 0 : 1);
}

main().catch((err) => {
    console.error(`❌ probe fatal: ${err.message}${err.body ? ' ' + JSON.stringify(err.body).slice(0, 200) : ''}`);
    process.exit(1);
});
