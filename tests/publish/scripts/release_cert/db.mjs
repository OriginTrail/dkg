// Shared DB helper for the release-certification scripts.
// Uses the same env contract as the existing insert scripts (testnet DB).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'pg';
import 'dotenv/config';

export function dbConfig() {
    return {
        host: process.env.DB_HOST_PUBLISH_TESTNET,
        user: process.env.DB_USER_PUBLISH,
        password: process.env.DB_PASSWORD_PUBLISH,
        database: process.env.DB_NAME_PUBLISH,
        port: 5432,
        connectionTimeoutMillis: 15000,
        statement_timeout: 60000,
        query_timeout: 60000,
    };
}

export async function connectDb() {
    const cfg = dbConfig();
    if (!cfg.host || !cfg.user || !cfg.database) {
        throw new Error('DB env missing: need DB_HOST_PUBLISH_TESTNET, DB_USER_PUBLISH, DB_PASSWORD_PUBLISH, DB_NAME_PUBLISH');
    }
    const client = new Client(cfg);
    await client.connect();
    return client;
}

// Idempotent schema apply. If the DB user has no DDL rights this logs the exact
// failure and returns false so callers can decide whether existing tables suffice.
export async function ensureSchema(client) {
    const sqlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    try {
        await client.query(sql);
        return true;
    } catch (err) {
        console.error(`⚠️ schema ensure failed (${err.message}) — if this is a permissions error the tables must be created once by the DB owner using schema.sql`);
        return false;
    }
}
