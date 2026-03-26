import fs from 'fs';
import { Client } from 'pg';
import 'dotenv/config';

const files = process.argv.slice(2);

const MAINNET_PORTS = [':8453', ':100', ':2043'];

for (const file of files) {
    console.log(`Processing ${file}`);
    let summary;

    try {
        const raw = fs.readFileSync(file, 'utf8');
        summary = JSON.parse(raw);
    } catch (err) {
        console.error(`Failed to read or parse ${file}: ${err.message}`);
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

    const tableName = isMainnet ? 'publish_v9_mainnet_summary' : 'publish_v9_testnet_summary';
    const dbHost = isMainnet
        ? process.env.DB_HOST_PUBLISH_MAINNET
        : process.env.DB_HOST_PUBLISH_TESTNET;

    console.log(`Network: ${isMainnet ? 'mainnet' : 'testnet'} | Table: ${tableName}`);

    const db = new Client({
        host: dbHost,
        user: process.env.DB_USER_PUBLISH,
        password: process.env.DB_PASSWORD_PUBLISH,
        database: process.env.DB_NAME_PUBLISH,
        port: 5432,
    });

    try {
        await db.connect();
        console.log(`Connected to DB (${isMainnet ? 'mainnet' : 'testnet'})`);
    } catch (err) {
        console.error('Failed to connect to DB:', err.message);
        continue;
    }

    try {
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

        console.log(`Inserted ${file} into table '${tableName}'`);
    } catch (err) {
        console.error(`Failed to insert ${file} into DB (table '${tableName}'): ${err.message}`);
    }

    try {
        await db.end();
        console.log('DB connection closed');
    } catch (err) {
        console.error('Failed to close DB connection:', err.message);
    }
}
