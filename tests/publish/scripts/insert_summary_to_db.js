import fs from 'fs';
import mysql from 'mysql2/promise';
import 'dotenv/config';

const files = process.argv.slice(2);

const requiredEnvVars = ['RAGAS_DB_HOST', 'RAGAS_DB_PASSWORD', 'RAGAS_DB_NAME'];
const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
    console.error(`Missing required env vars: ${missingEnvVars.join(', ')}`);
    process.exit(1);
}

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
    console.log(`Network: ${isMainnet ? 'mainnet' : 'testnet'} | Table: ${tableName}`);

    let db;
    try {
        db = await mysql.createConnection({
            host: process.env.RAGAS_DB_HOST,
            user: process.env.RAGAS_DB_USER || process.env.RAGAS_DB_NAME || 'root',
            password: process.env.RAGAS_DB_PASSWORD,
            database: process.env.RAGAS_DB_NAME,
            port: 3306,
        });
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const timestamp = summary.time_stamp
            ? new Date(summary.time_stamp).toISOString().replace('T', ' ').replace('Z', '').split('.')[0]
            : new Date().toISOString().replace('T', ' ').replace('Z', '').split('.')[0];

        await db.execute(query, [
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
            timestamp,
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
