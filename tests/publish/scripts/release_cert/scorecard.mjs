// Release scorecard (M4): runs hourly; for every release detected by the
// watcher it evaluates the T+1h / T+6h / T+24h checkpoints that are due and
// writes a PASS / DEGRADED / FAIL verdict row, printing the digest. When a
// SLACK_WEBHOOK_SCORECARD env is configured it also posts the digest to Slack.
//
// Data sources, in order of preference:
//   publish_layer_ops   (layered suite — per layer / cg_kind / payload size)
//   publish_testnet_summary (existing burst jobs — end-to-end fallback)
//   queue_snapshots     (queue/backpressure trend)
//
// Verdict rules (config below, overridable via RC_SCORECARD_CONFIG json file):
//   FAIL only from the 6h/24h checkpoints (persistence rule — a 1h dip alone
//   cannot page anyone), and only when the post window keeps failing while the
//   pre-release baseline was healthy. DEGRADED = meaningful regression vs
//   baseline. Everything else PASS. Missing data => INCONCLUSIVE, never PASS.
import fs from 'fs';
import { connectDb, ensureSchema } from './db.mjs';
import 'dotenv/config';

const CHECKPOINTS = [1, 6, 24]; // hours after release detection
const DEFAULT_CONFIG = {
    successDropPts: 3,          // DEGRADED when success rate drops more than this vs baseline
    failBelowPct: 90,           // FAIL when post success below this while baseline >= failBaselinePct
    failBaselinePct: 95,
    latencyRegressionRatio: 1.5, // DEGRADED when avg client_ms grows beyond this ratio
    queueAgeRegressionRatio: 2.0,
    minOps: 5,                  // below this many ops in the window => INCONCLUSIVE
};

function loadConfig() {
    const p = process.env.RC_SCORECARD_CONFIG;
    if (!p) return DEFAULT_CONFIG;
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; }
    catch (e) { console.error(`⚠️ scorecard config unreadable (${e.message}) — using defaults`); return DEFAULT_CONFIG; }
}

async function layerStats(db, fromTs, toTs) {
    const { rows } = await db.query(
        `SELECT layer, cg_kind, COUNT(*)::int AS ops,
                ROUND(100.0 * AVG(CASE WHEN success THEN 1 ELSE 0 END), 1)::float AS success_pct,
                ROUND(AVG(client_ms) FILTER (WHERE success))::bigint AS avg_ms
         FROM publish_layer_ops
         WHERE time_stamp >= $1 AND time_stamp < $2
         GROUP BY layer, cg_kind`, [fromTs, toTs]);
    return rows;
}

// Same trap as mainnet_scorecard.mjs: `NULLIF(col, '')` is only safe on a text
// column — against NUMERIC, Postgres coerces the empty-string literal and fails
// with `invalid input syntax for type numeric: ""` before reading a row.
// Casting to text first is correct for either shape.
const NUM = (col) => `NULLIF(${col}::text, '')::float`;

async function summaryStats(db, fromTs, toTs) {
    const { rows } = await db.query(
        // The `::numeric` before ROUND is required, not cosmetic: two-argument
        // ROUND exists only for numeric, so `ROUND(<double precision>, 1)` is
        // `function round(double precision, integer) does not exist`.
        `SELECT COUNT(*)::int AS runs,
                ROUND(AVG(${NUM('publish_success_rate')})::numeric, 1)::float AS publish_pct,
                ROUND(AVG(CASE WHEN ${NUM('publish_success_rate')} > 0 THEN ${NUM('average_publish_time')} END)::numeric, 2)::float AS avg_publish_s
         FROM publish_testnet_summary
         WHERE time_stamp >= $1 AND time_stamp < $2`, [fromTs, toTs]);
    return rows[0];
}

async function queueStats(db, fromTs, toTs) {
    const { rows } = await db.query(
        `SELECT COALESCE(AVG(oldest_age_ms), 0)::float AS avg_oldest_age_ms,
                COUNT(*) FILTER (WHERE state NOT IN ('healthy') AND state IS NOT NULL AND source IN ('store','sync-global'))::int AS unhealthy_samples,
                COUNT(*)::int AS samples
         FROM queue_snapshots
         WHERE time_stamp >= $1 AND time_stamp < $2`, [fromTs, toTs]);
    return rows[0];
}

function evaluate(cfg, checkpointH, post, pre, postQ, preQ, postSummary, preSummary) {
    const notes = [];
    let verdict = 'PASS';
    const bump = (v) => {
        const rank = { PASS: 0, DEGRADED: 1, FAIL: 2 };
        if (rank[v] > rank[verdict]) verdict = v;
    };

    const havePost = post.length > 0 && post.reduce((a, r) => a + r.ops, 0) >= cfg.minOps;
    if (havePost) {
        for (const p of post) {
            const b = pre.find((r) => r.layer === p.layer && r.cg_kind === p.cg_kind);
            if (!b || b.ops < cfg.minOps) continue;
            if (p.success_pct < cfg.failBelowPct && b.success_pct >= cfg.failBaselinePct) {
                notes.push(`${p.layer}(${p.cg_kind}) success ${b.success_pct}% → ${p.success_pct}%`);
                bump(checkpointH >= 6 ? 'FAIL' : 'DEGRADED');
            } else if (b.success_pct - p.success_pct > cfg.successDropPts) {
                notes.push(`${p.layer}(${p.cg_kind}) success ${b.success_pct}% → ${p.success_pct}%`);
                bump('DEGRADED');
            }
            if (p.avg_ms && b.avg_ms && p.avg_ms > b.avg_ms * cfg.latencyRegressionRatio) {
                notes.push(`${p.layer}(${p.cg_kind}) latency ${b.avg_ms}ms → ${p.avg_ms}ms`);
                bump('DEGRADED');
            }
        }
    } else if (postSummary?.runs > 0 && preSummary?.runs > 0) {
        // fallback: existing burst-suite aggregates
        if (postSummary.publish_pct != null && preSummary.publish_pct != null) {
            if (postSummary.publish_pct < cfg.failBelowPct && preSummary.publish_pct >= cfg.failBaselinePct) {
                notes.push(`publish success ${preSummary.publish_pct}% → ${postSummary.publish_pct}% (burst suite)`);
                bump(checkpointH >= 6 ? 'FAIL' : 'DEGRADED');
            } else if (preSummary.publish_pct - postSummary.publish_pct > cfg.successDropPts) {
                notes.push(`publish success ${preSummary.publish_pct}% → ${postSummary.publish_pct}% (burst suite)`);
                bump('DEGRADED');
            }
        }
        if (postSummary.avg_publish_s && preSummary.avg_publish_s && postSummary.avg_publish_s > preSummary.avg_publish_s * cfg.latencyRegressionRatio) {
            notes.push(`publish time ${preSummary.avg_publish_s}s → ${postSummary.avg_publish_s}s (burst suite)`);
            bump('DEGRADED');
        }
    } else {
        return { verdict: 'INCONCLUSIVE', notes: ['not enough test data in the window'] };
    }

    if (postQ?.samples > 0 && preQ?.samples > 0) {
        if (preQ.avg_oldest_age_ms > 0 && postQ.avg_oldest_age_ms > preQ.avg_oldest_age_ms * cfg.queueAgeRegressionRatio) {
            notes.push(`queue oldest-age avg ${Math.round(preQ.avg_oldest_age_ms)}ms → ${Math.round(postQ.avg_oldest_age_ms)}ms`);
            bump('DEGRADED');
        }
        if (postQ.unhealthy_samples > 0 && preQ.unhealthy_samples === 0) {
            notes.push(`${postQ.unhealthy_samples} unhealthy backpressure samples post-release (baseline had none)`);
            bump(checkpointH >= 6 ? 'FAIL' : 'DEGRADED');
        }
    }

    if (notes.length === 0) notes.push('all tracked dimensions within baseline');
    return { verdict, notes };
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
    const cfg = loadConfig();
    const db = await connectDb();
    await ensureSchema(db);

    const { rows: releases } = await db.query(
        `SELECT id, dist_tag, version, detected_at FROM releases
         WHERE dist_tag IN ('testnet', 'latest') AND detected_at > now() - interval '26 hours'
         ORDER BY detected_at`);
    if (releases.length === 0) {
        console.log('no releases in the evaluation horizon');
        await db.end();
        return;
    }

    for (const rel of releases) {
        for (const h of CHECKPOINTS) {
            const due = new Date(new Date(rel.detected_at).getTime() + h * 3600_000);
            if (due > new Date()) continue;
            const { rows: existing } = await db.query(
                'SELECT 1 FROM scorecards WHERE release_id = $1 AND checkpoint = $2', [rel.id, `${h}h`]);
            if (existing.length > 0) continue;

            const post = await layerStats(db, rel.detected_at, due);
            const pre = await layerStats(db, new Date(new Date(rel.detected_at).getTime() - 24 * 3600_000), rel.detected_at);
            const postQ = await queueStats(db, rel.detected_at, due);
            const preQ = await queueStats(db, new Date(new Date(rel.detected_at).getTime() - 24 * 3600_000), rel.detected_at);
            const postS = await summaryStats(db, rel.detected_at, due);
            const preS = await summaryStats(db, new Date(new Date(rel.detected_at).getTime() - 24 * 3600_000), rel.detected_at);

            const { verdict, notes } = evaluate(cfg, h, post, pre, postQ, preQ, postS, preS);
            const emoji = { PASS: '✅', DEGRADED: '⚠️', FAIL: '🔴', INCONCLUSIVE: '❔' }[verdict];
            const digest = `🚦 Release ${rel.dist_tag} v${rel.version} — testnet — T+${h}h: ${verdict} ${emoji}\n` + notes.map((n) => `• ${n}`).join('\n');

            await db.query(
                `INSERT INTO scorecards (release_id, checkpoint, verdict, details)
                 VALUES ($1, $2, $3, $4) ON CONFLICT (release_id, checkpoint) DO NOTHING`,
                [rel.id, `${h}h`, verdict, JSON.stringify({ notes, post, pre, postQ, preQ, postS, preS })]);
            console.log(digest);
            const posted = await postSlack(digest);
            if (!posted) console.log('(Slack webhook not configured — digest recorded in DB only)');
        }
    }
    await db.end();
}

main().catch((err) => {
    console.error(`❌ scorecard fatal: ${err.message}`);
    process.exit(1);
});
