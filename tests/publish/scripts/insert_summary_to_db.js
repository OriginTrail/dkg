import fs from 'fs';
import { Client } from 'pg';
import 'dotenv/config';

const files = process.argv.slice(2);

// Match only if blockchain_name ends with exactly one of these full port tokens
const MAINNET_PORTS = [':8453', ':100', ':2043'];

for (const file of files) {
    console.log(`Processing ${file}`);
    let summary;

    try {
        const raw = fs.readFileSync(file, 'utf8');
        summary = JSON.parse(raw);
    } catch (err) {
        console.error(`❌ Failed to read or parse ${file}:`, err.message);
        continue;
    }

    let isMainnet = false;
    if (
        summary.blockchain_name &&
        typeof summary.blockchain_name === 'string' &&
        MAINNET_PORTS.some(port => summary.blockchain_name.endsWith(port))
    ) {
        isMainnet = true;
    }

    const tableName = isMainnet ? 'publish_mainnet_summary' : 'publish_testnet_summary';
    const dbHost = isMainnet ? process.env.DB_HOST_PUBLISH_MAINNET : process.env.DB_HOST_PUBLISH_TESTNET;

    const db = new Client({
        host: dbHost,
        user: process.env.DB_USER_PUBLISH,
        password: process.env.DB_PASSWORD_PUBLISH,
        database: process.env.DB_NAME_PUBLISH,
        port: 5432,
        connectionTimeoutMillis: 15000,
        statement_timeout: 60000,
        query_timeout: 60000,
    });

    try {
        await db.connect();
        console.log(`✅ Connected to DB (${isMainnet ? 'mainnet' : 'testnet'})`);
    } catch (err) {
        console.error('❌ Failed to connect to DB:', err.message);
        continue;
    }

    try {
        // Auto-create the target table if it doesn't exist yet (idempotent — a
        // no-op for the long-lived mainnet table, creates the testnet table on
        // its first import). Schema mirrors publish_mainnet_summary exactly.
        await db.query(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
                id SERIAL PRIMARY KEY,
                blockchain_name VARCHAR,
                node_name VARCHAR,
                publish_success_rate NUMERIC,
                query_success_rate NUMERIC,
                publisher_get_success_rate NUMERIC,
                non_publisher_get_success_rate NUMERIC,
                average_publish_time NUMERIC,
                average_query_time NUMERIC,
                average_publisher_get_time NUMERIC,
                average_non_publisher_get_time NUMERIC,
                time_stamp TIMESTAMP
            )
        `);

        const query = `
            INSERT INTO ${tableName} (
                blockchain_name, node_name,
                publish_success_rate, query_success_rate,
                publisher_get_success_rate, non_publisher_get_success_rate,
                average_publish_time, average_query_time,
                average_publisher_get_time, average_non_publisher_get_time,
                time_stamp
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `;

        await db.query(query, [
            summary.blockchain_name,
            summary.node_name,
            summary.publish_success_rate,
            summary.query_success_rate,
            summary.publisher_get_success_rate,
            summary.non_publisher_get_success_rate,
            summary.average_publish_time,
            summary.average_query_time,
            summary.average_publisher_get_time,
            summary.average_non_publisher_get_time,
            summary.time_stamp,
        ]);

        console.log(`✅ Inserted ${file} into table '${tableName}'`);
    } catch (err) {
        console.error(`❌ Failed to insert ${file} into DB (table '${tableName}'):`, err.message);
    }

    try {
        await db.end();
        console.log('✅ DB connection closed');
    } catch (err) {
        console.error('❌ Failed to close DB connection:', err.message);
    }
}