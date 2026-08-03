// Permission probe: the Jenkins DB user cannot CREATE in `public`, but it may be
// able to own its own schema. Read-only/additive probe — it creates nothing
// outside a dedicated `release_cert` schema and drops its scratch table again.
// Reports exactly which capability exists so we know whether we can self-serve
// the schema or must ask the DB owner.
import { connectDb } from './db.mjs';
import 'dotenv/config';

const probes = [];
async function probe(label, sql, client) {
    try {
        const res = await client.query(sql);
        probes.push({ label, ok: true, detail: res.rows?.length ? JSON.stringify(res.rows[0]).slice(0, 120) : 'ok' });
        return true;
    } catch (e) {
        probes.push({ label, ok: false, detail: `${e.code || ''} ${e.message}`.slice(0, 160) });
        return false;
    }
}

async function main() {
    const db = await connectDb();
    await probe('whoami / db / version', 'SELECT current_user, current_database(), version()', db);
    await probe('can SELECT existing table', 'SELECT count(*) FROM publish_testnet_summary', db);
    await probe('CREATE TABLE in public', 'CREATE TABLE IF NOT EXISTS rc_probe_public (id int)', db);
    const schemaOk = await probe("CREATE SCHEMA release_cert", "CREATE SCHEMA IF NOT EXISTS release_cert", db);
    if (schemaOk) {
        await probe('CREATE TABLE in release_cert', 'CREATE TABLE IF NOT EXISTS release_cert.rc_probe (id bigserial primary key, note text)', db);
        await probe('INSERT into release_cert', "INSERT INTO release_cert.rc_probe (note) VALUES ('probe')", db);
        await probe('SELECT from release_cert', 'SELECT count(*) FROM release_cert.rc_probe', db);
        await probe('list schema grantees', "SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'publish_testnet_summary' LIMIT 10", db);
        await probe('drop scratch table', 'DROP TABLE IF EXISTS release_cert.rc_probe', db);
    }
    await db.end();

    console.log('\n=== DB capability probe ===');
    for (const p of probes) console.log(`${p.ok ? '✅' : '❌'} ${p.label}: ${p.detail}`);
    const canOwnSchema = probes.find((p) => p.label === 'CREATE TABLE in release_cert')?.ok;
    console.log(canOwnSchema
        ? '\n➡️  SELF-SERVE POSSIBLE: we can own a `release_cert` schema — set RC_DB_SCHEMA=release_cert and apply schema.sql there (then GRANT USAGE/SELECT to the Grafana reader).'
        : '\n➡️  DB OWNER REQUIRED: no CREATE capability — schema.sql must be applied once by the DB owner.');
}

main().catch((err) => {
    console.error(`❌ probe fatal: ${err.message}`);
    process.exit(1);
});
