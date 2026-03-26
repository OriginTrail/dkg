import fs from 'fs';
import { Client } from 'pg';
import 'dotenv/config';

const files = process.argv.slice(2);

const MAINNET_PORTS = [':8453', ':100', ':2043'];

for (const file of files) {
    console.log(`Processing error file: ${file}`);
    let errors;

    try {
        const raw = fs.readFileSync(file, 'utf8');
        errors = JSON.parse(raw);
    } catch (err) {
        console.error(`Failed to read or parse ${file}: ${err.message}`);
        continue;
    }

    const match = file.match(/errors_([\w_]+)\.json/);
    if (!match) {
        console.error(`Filename format incorrect for ${file}. Expected: errors_<NodeName>.json`);
        continue;
    }

    const nodeName = match[1].replace(/_/g, ' ');

    let blockchainId = 'v9:local';
    if (errors.blockchain_id) {
        blockchainId = errors.blockchain_id;
    }

    let isMainnet = false;
    if (blockchainId && typeof blockchainId === 'string') {
        isMainnet = MAINNET_PORTS.some(port => blockchainId.endsWith(port));
    }

    const tableName = isMainnet ? 'error_messages_v9_mainnet' : 'error_messages_v9_testnet';
    const dbHost = isMainnet
        ? process.env.DB_HOST_PUBLISH_MAINNET
        : process.env.DB_HOST_PUBLISH_TESTNET;

    console.log(`Network: ${isMainnet ? 'mainnet' : 'testnet'} | Table: ${tableName}`);

    const detailedErrors = errors.detailed || errors;

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
        await db.query('BEGIN');
    } catch (err) {
        console.error('Failed to connect to DB:', err.message);
        continue;
    }

    let insertedCount = 0;

    const kaErrors = {};

    for (const [errorMsg] of Object.entries(detailedErrors)) {
        let kaNumber = null;

        const kaMatch = errorMsg.match(/for KA #(\d+)/);
        if (kaMatch) {
            kaNumber = `KA #${kaMatch[1]}`;
        } else {
            const patterns = [
                /KA\s*#?(\d+)/i,
                /Knowledge\s*Asset\s*#?(\d+)/i,
            ];
            for (const pattern of patterns) {
                const m = errorMsg.match(pattern);
                if (m) {
                    kaNumber = `KA #${m[1]}`;
                    break;
                }
            }
            if (!kaNumber) kaNumber = 'Unknown KA';
        }

        if (!kaErrors[kaNumber]) {
            kaErrors[kaNumber] = {
                publish_error: null,
                query_error: null,
                publisher_get_error: null,
                non_publisher_get_error: null,
            };
        }

        if (errorMsg.toLowerCase().includes('publish')) {
            kaErrors[kaNumber].publish_error = errorMsg;
        } else if (errorMsg.toLowerCase().includes('asset') || errorMsg.toLowerCase().includes('asset-query')) {
            kaErrors[kaNumber].publisher_get_error = errorMsg;
        } else if (errorMsg.toLowerCase().includes('global') || errorMsg.toLowerCase().includes('global-query')) {
            kaErrors[kaNumber].query_error = errorMsg;
        } else if (errorMsg.toLowerCase().includes('query')) {
            kaErrors[kaNumber].query_error = errorMsg;
        }
    }

    for (const [kaLabel, errorFields] of Object.entries(kaErrors)) {
        const insertQuery = `
            INSERT INTO ${tableName} (
                node_name, blockchain_id, ka_label,
                publish_error, query_error,
                publisher_get_error, non_publisher_get_error,
                time_stamp
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `;

        try {
            await db.query(insertQuery, [
                nodeName,
                blockchainId,
                kaLabel,
                errorFields.publish_error,
                errorFields.query_error,
                errorFields.publisher_get_error,
                errorFields.non_publisher_get_error,
                new Date().toISOString(),
            ]);
            insertedCount++;
            console.log(`Inserted ${kaLabel} (attempt ${insertedCount}) for ${nodeName}`);
        } catch (err) {
            console.error(`Failed to insert KA ${kaLabel}: ${err.message}`);
        }
    }

    try {
        await db.query('COMMIT');
    } catch (err) {
        console.error('Failed to commit transaction:', err.message);
        await db.query('ROLLBACK');
    }

    try {
        await db.end();
        console.log('DB connection closed');
    } catch (err) {
        console.error('Failed to close DB connection:', err.message);
    }
}
