// Mainnet observe-only scorecard (P3.3): works TODAY with zero new tables —
// release detection state lives in a workspace JSON file, metrics come from the
// existing publish_mainnet_summary table, verdicts go to Slack + console.
// Adds no mainnet load; it only reads what the existing jobs already produce.
//
//   RC_STATE_DIR   directory for mainnet-scorecard-state.json (default: cwd)
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import 'dotenv/config';

const CHECKPOINTS = [1, 6, 24];
const STATE_FILE = path.join(process.env.RC_STATE_DIR || '.', 'mainnet-scorecard-state.json');

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { return { lastTag: null, releases: [], evaluated: [] }; }
}
function saveState(st) { fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 1)); }

async function mainnetDb() {
    const client = new Client({
        host: process.env.DB_HOST_PUBLISH_MAINNET,
        user: process.env.DB_USER_PUBLISH,
        password: process.env.DB_PASSWORD_PUBLISH,
        database: process.env.DB_NAME_PUBLISH,
        port: 5432, connectionTimeoutMillis: 15000, statement_timeout: 60000, query_timeout: 60000,
    });
    await client.connect();
    return client;
}

// `NULLIF(col, '')` is only safe when the column is text. Against a NUMERIC
// column Postgres coerces the empty-string literal to numeric to make the
// comparison, and fails with `invalid input syntax for type numeric: ""` before
// it reads a single row — which is why this surfaced the first time a release
// actually came due rather than on the many runs that returned early. Casting to
// text first is correct either way, and this table is written by
// insert_summary_to_db.js from JSON, so both shapes are plausible over time.
const NUM = (col) => `NULLIF(${col}::text, '')::float`;

async function windowStats(db, fromTs, toTs) {
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS runs,
                ROUND(AVG(${NUM('publish_success_rate')})::numeric, 1)::float AS publish_pct,
                ROUND(AVG(CASE WHEN ${NUM('publish_success_rate')} > 0 THEN ${NUM('average_publish_time')} END)::numeric, 2)::float AS avg_publish_s,
                ROUND(AVG(${NUM('non_publisher_get_success_rate')})::numeric, 1)::float AS remote_get_pct
         FROM publish_mainnet_summary
         WHERE time_stamp >= $1 AND time_stamp < $2`, [fromTs, toTs]);
    return rows[0];
}

async function postSlack(text) {
    const hook = process.env.SLACK_WEBHOOK_SCORECARD;
    if (!hook) return false;
    try {
        const res = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
        return res.ok;
    } catch { return false; }
}

async function main() {
    const st = loadState();

    const tagsRes = await fetch('https://registry.npmjs.org/-/package/@origintrail-official%2fdkg/dist-tags');
    const tags = await tagsRes.json();
    const current = tags.mainnet;
    if (!current) throw new Error('no mainnet dist-tag in registry response');

    if (st.lastTag && st.lastTag !== current) {
        st.releases.push({ version: current, detectedAt: new Date().toISOString() });
        st.releases = st.releases.slice(-10);
        console.log(`🚦 mainnet release detected: v${current}`);
        await postSlack(`🚦 *Mainnet release detected: v${current}* — observe-only scorecard will report at T+1h/6h/24h.`);
    }
    st.lastTag = current;

    const horizon = Date.now() - 26 * 3600_000;
    const due = st.releases.filter((r) => new Date(r.detectedAt).getTime() > horizon);
    if (due.length === 0) {
        console.log(`no mainnet releases in the horizon (current tag v${current})`);
        saveState(st);
        return;
    }

    const db = await mainnetDb();
    for (const rel of due) {
        const detected = new Date(rel.detectedAt);
        for (const h of CHECKPOINTS) {
            const key = `${rel.version}@${h}h`;
            const dueAt = new Date(detected.getTime() + h * 3600_000);
            if (dueAt > new Date() || st.evaluated.includes(key)) continue;

            const post = await windowStats(db, detected, dueAt);
            const pre = await windowStats(db, new Date(detected.getTime() - 24 * 3600_000), detected);

            let verdict = 'PASS';
            const notes = [];
            if (!post?.runs || !pre?.runs) {
                verdict = 'INCONCLUSIVE';
                notes.push(`not enough mainnet publish-test runs (post=${post?.runs ?? 0}, baseline=${pre?.runs ?? 0})`);
            } else {
                if (post.publish_pct != null && pre.publish_pct != null) {
                    if (post.publish_pct < 90 && pre.publish_pct >= 95) { verdict = h >= 6 ? 'FAIL' : 'DEGRADED'; notes.push(`publish success ${pre.publish_pct}% → ${post.publish_pct}%`); }
                    else if (pre.publish_pct - post.publish_pct > 3) { verdict = 'DEGRADED'; notes.push(`publish success ${pre.publish_pct}% → ${post.publish_pct}%`); }
                }
                if (post.avg_publish_s && pre.avg_publish_s && post.avg_publish_s > pre.avg_publish_s * 1.5) {
                    if (verdict === 'PASS') verdict = 'DEGRADED';
                    notes.push(`publish time ${pre.avg_publish_s}s → ${post.avg_publish_s}s`);
                }
                if (post.remote_get_pct != null && pre.remote_get_pct != null && pre.remote_get_pct - post.remote_get_pct > 5) {
                    if (verdict === 'PASS') verdict = 'DEGRADED';
                    notes.push(`remote get ${pre.remote_get_pct}% → ${post.remote_get_pct}%`);
                }
                if (notes.length === 0) notes.push(`publish ${post.publish_pct}% (baseline ${pre.publish_pct}%) · avg ${post.avg_publish_s}s · ${post.runs} runs`);
            }

            const emoji = { PASS: '✅', DEGRADED: '⚠️', FAIL: '🔴', INCONCLUSIVE: '❔' }[verdict];
            const digest = `🚦 *Mainnet v${rel.version} — observe-only — T+${h}h: ${verdict}* ${emoji}\n` + notes.map((n) => `• ${n}`).join('\n');
            console.log(digest);
            const posted = await postSlack(digest);
            if (!posted) console.log('(Slack not configured — console only)');
            st.evaluated.push(key);
        }
    }
    await db.end();
    st.evaluated = st.evaluated.slice(-60);
    saveState(st);
    console.log('✅ mainnet scorecard pass complete');
}

main().catch((err) => {
    console.error(`❌ mainnet scorecard fatal: ${err.message}`);
    process.exit(1);
});
