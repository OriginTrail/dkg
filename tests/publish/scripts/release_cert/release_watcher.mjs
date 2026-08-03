// Release watcher (M1): polls the npm dist-tags for @origintrail-official/dkg
// and records every (tag, version) change into the releases table. The
// Release Certification dashboard draws these rows as release annotation lines,
// and later milestones (scorecard, canary gate) trigger off new rows.
//
//   RC_TRACK_TAGS  comma list (default: testnet,latest,mainnet,next,rc,canary)
//   RC_DRY         "1" = print instead of inserting
//
// Optional direct Grafana annotation (not required — the dashboard reads the
// table): set GRAFANA_URL + GRAFANA_SA_TOKEN to also POST an annotation.
import { connectDb, ensureSchema } from './db.mjs';
import 'dotenv/config';

const PACKAGE = process.env.RC_PACKAGE || '@origintrail-official/dkg';
const TAGS = (process.env.RC_TRACK_TAGS || 'testnet,latest,mainnet,next,rc,canary')
    .split(',').map((t) => t.trim()).filter(Boolean);
const DRY = process.env.RC_DRY === '1';

async function fetchDistTags() {
    const res = await fetch(`https://registry.npmjs.org/-/package/${encodeURIComponent(PACKAGE).replace('%2F', '/')}/dist-tags`, {
        headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`npm registry HTTP ${res.status}`);
    return res.json();
}

async function annotateGrafana(tag, version) {
    const url = process.env.GRAFANA_URL;
    const token = process.env.GRAFANA_SA_TOKEN;
    if (!url || !token) return;
    try {
        const res = await fetch(`${url.replace(/\/$/, '')}/api/annotations`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ tags: ['release', tag], text: `release ${tag} → v${version}` }),
        });
        if (!res.ok) console.error(`⚠️ grafana annotation HTTP ${res.status}`);
    } catch (err) {
        console.error(`⚠️ grafana annotation: ${err.message}`);
    }
}

async function main() {
    const distTags = await fetchDistTags();
    const seen = TAGS.filter((t) => distTags[t]).map((t) => ({ tag: t, version: distTags[t] }));
    if (seen.length === 0) {
        console.log('no tracked tags present in registry response');
        return;
    }

    if (DRY) {
        console.log(JSON.stringify(seen, null, 1));
        return;
    }

    const client = await connectDb();
    await ensureSchema(client);
    for (const { tag, version } of seen) {
        const res = await client.query(
            `INSERT INTO releases (package, dist_tag, version)
             VALUES ($1, $2, $3)
             ON CONFLICT (package, dist_tag, version) DO NOTHING
             RETURNING id`,
            [PACKAGE, tag, version],
        );
        if (res.rowCount > 0) {
            console.log(`🚦 new release detected: ${tag} → v${version}`);
            await annotateGrafana(tag, version);
        }
    }
    await client.end();
    console.log(`✅ watcher done (${seen.map((s) => `${s.tag}=${s.version}`).join(', ')})`);
}

main().catch((err) => {
    console.error(`❌ watcher fatal: ${err.message}`);
    process.exit(1);
});
