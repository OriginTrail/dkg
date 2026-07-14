import fs from 'fs';
import { Client } from 'pg';
import { pathToFileURL } from 'url';
import 'dotenv/config';

const MAINNET_PORTS = [':8453', ':100', ':2043'];

function inferBlockchainId(file, isMainnet) {
    const lower = file.toLowerCase();
    if (lower.includes('base')) return isMainnet ? 'base:8453' : 'base:84532';
    if (lower.includes('gnosis')) return isMainnet ? 'gnosis:100' : 'gnosis:10200';
    return isMainnet ? 'otp:2043' : 'otp:20430';
}

function errorTarget(file, payload, env) {
    let blockchainId = null;
    if (Array.isArray(payload) && payload[0]?.blockchain_id) blockchainId = payload[0].blockchain_id;
    if (!Array.isArray(payload) && payload?.blockchain_id) blockchainId = payload.blockchain_id;
    if (!blockchainId && env.BLOCKCHAIN_ID) blockchainId = env.BLOCKCHAIN_ID;

    let isMainnet = typeof blockchainId === 'string'
        && MAINNET_PORTS.some((port) => blockchainId.endsWith(port));
    if (!blockchainId) {
        const lower = file.toLowerCase();
        if (lower.includes('mainnet')) isMainnet = true;
        else if (lower.includes('testnet')) isMainnet = false;
        else {
            const nodeNumber = Number(file.match(/Node_(\d+)/)?.[1]);
            isMainnet = nodeNumber >= 25 && nodeNumber <= 30;
        }
        blockchainId = inferBlockchainId(file, isMainnet);
    }

    return {
        blockchainId,
        isMainnet,
        tableName: isMainnet ? 'error_messages_mainnet_js' : 'error_messages_testnet_js',
        dbHost: isMainnet ? env.DB_HOST_PUBLISH_MAINNET : env.DB_HOST_PUBLISH_TESTNET,
    };
}

function findKaLabel(message) {
    const patterns = [
        /for KA #(\d+)/i,
        /KA\s*#?(\d+)/i,
        /Knowledge\s*Asset\s*#?(\d+)/i,
        /Asset\s*#?(\d+)/i,
        /publishing.*KA\s*#?(\d+)/i,
        /querying.*KA\s*#?(\d+)/i,
        /get.*KA\s*#?(\d+)/i,
        /(\d+)\s*KA/i,
    ];
    for (const pattern of patterns) {
        const match = String(message || '').match(pattern);
        if (match) return `KA #${match[1]}`;
    }
    return 'Unknown KA';
}

function errorFieldForMessage(message) {
    const lower = message.toLowerCase();
    if (lower.startsWith('publish')) return 'publish_error';
    if (lower.startsWith('query remote') || lower.includes('query remote')) return 'non_publisher_get_error';
    if (lower.startsWith('vm get') || lower.startsWith('swm get') || lower.includes('local get')) return 'publisher_get_error';
    if (lower.startsWith('query')) return 'query_error';
    if (lower.includes('get')) return 'non_publisher_get_error';
    return null;
}

function rowsFromPayload(payload, nodeName, target) {
    const now = () => new Date().toISOString();
    if (Array.isArray(payload)) {
        return payload.map((attempt) => ({
            node_name: nodeName,
            blockchain_id: attempt.blockchain_id || target.blockchainId,
            ka_label: attempt.ka_label || findKaLabel([
                attempt.publish_error,
                attempt.query_error,
                attempt.publisher_get_error,
                attempt.non_publisher_get_error,
            ].filter(Boolean).join(' ')),
            publish_error: attempt.publish_error || null,
            query_error: attempt.query_error || null,
            publisher_get_error: attempt.publisher_get_error || null,
            non_publisher_get_error: attempt.non_publisher_get_error || null,
            time_stamp: now(),
        }));
    }

    const detailed = payload?.detailed || payload || {};
    const grouped = new Map();
    for (const message of Object.keys(detailed)) {
        const kaLabel = findKaLabel(message);
        if (!grouped.has(kaLabel)) {
            grouped.set(kaLabel, {
                publish_error: null,
                query_error: null,
                publisher_get_error: null,
                non_publisher_get_error: null,
            });
        }
        const field = errorFieldForMessage(message);
        if (!field) continue;
        grouped.get(kaLabel)[field] = message
            .replace(/^(publish|query remote(?: \(sync\))?|vm get|swm get|query)\s*—\s*/i, '')
            .replace(/\s*for KA #\d+$/i, '');
    }

    return [...grouped.entries()].map(([kaLabel, fields]) => ({
        node_name: nodeName,
        blockchain_id: target.blockchainId,
        ka_label: kaLabel,
        ...fields,
        time_stamp: now(),
    }));
}

function parseErrorArtifacts(files, fsImpl, env, logger) {
    const artifacts = [];
    let failed = false;
    for (const file of files) {
        logger.log(`📁 Processing error file: ${file}`);
        const match = file.match(/errors_(.+)\.json$/);
        if (!match) {
            logger.error(`❌ Filename format incorrect for ${file}. Expected: errors_<NodeName>.json`);
            failed = true;
            continue;
        }
        try {
            const payload = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
            const target = errorTarget(file, payload, env);
            const nodeName = match[1].replace(/_/g, ' ');
            artifacts.push({ file, target, rows: rowsFromPayload(payload, nodeName, target) });
        } catch (error) {
            logger.error(`❌ Failed to read or parse ${file}:`, error.message);
            failed = true;
        }
    }
    if (failed) return null;
    const targetKinds = new Set(artifacts.map(({ target }) => target.isMainnet));
    if (targetKinds.size > 1) {
        logger.error('❌ An error import must contain only mainnet or only testnet artifacts so it can be committed atomically');
        return null;
    }
    return artifacts;
}

/** Import every row from this Jenkins artifact batch in one transaction. */
export async function importErrors(
    files,
    {
        createClient = (config) => new Client(config),
        env = process.env,
        fsImpl = fs,
        logger = console,
    } = {},
) {
    if (files.length === 0) {
        logger.error('❌ No error files were provided');
        return 1;
    }

    const artifacts = parseErrorArtifacts(files, fsImpl, env, logger);
    if (!artifacts) return 1;
    const { isMainnet, tableName, dbHost } = artifacts[0].target;
    const db = createClient({
        host: dbHost,
        user: env.DB_USER_PUBLISH,
        password: env.DB_PASSWORD_PUBLISH,
        database: env.DB_NAME_PUBLISH,
        port: 5432,
        connectionTimeoutMillis: 15000,
        statement_timeout: 60000,
        query_timeout: 60000,
    });

    let transactionOpen = false;
    try {
        await db.connect();
        logger.log(`✅ Connected to DB (${isMainnet ? 'mainnet' : 'testnet'})`);
        await db.query('BEGIN');
        transactionOpen = true;

        const query = `
            INSERT INTO ${tableName} (
                node_name, blockchain_id, ka_label,
                publish_error, query_error,
                publisher_get_error, non_publisher_get_error,
                time_stamp
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `;
        let insertedCount = 0;
        for (const { file, rows } of artifacts) {
            for (const row of rows) {
                try {
                    await db.query(query, [
                        row.node_name,
                        row.blockchain_id,
                        row.ka_label,
                        row.publish_error,
                        row.query_error,
                        row.publisher_get_error,
                        row.non_publisher_get_error,
                        row.time_stamp,
                    ]);
                    insertedCount++;
                    logger.log(`✅ Staged ${row.ka_label} (attempt ${insertedCount}) for ${row.node_name}`);
                } catch (error) {
                    throw new Error(`Failed to insert ${row.ka_label} from ${file}: ${error.message}`, { cause: error });
                }
            }
        }

        await db.query('COMMIT');
        transactionOpen = false;
        logger.log(`✅ Committed ${insertedCount} error row(s) atomically`);
        return 0;
    } catch (error) {
        logger.error('❌ Error import failed:', error.message);
        if (transactionOpen) {
            try {
                await db.query('ROLLBACK');
                transactionOpen = false;
                logger.log('✅ Rolled back error import transaction');
            } catch (rollbackError) {
                logger.error('❌ Failed to roll back error import transaction:', rollbackError.message);
            }
        }
        return 1;
    } finally {
        try {
            await db.end();
            logger.log('✅ DB connection closed');
        } catch (error) {
            logger.warn('⚠️  DB connection close failed after import result was known:', error.message);
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await importErrors(process.argv.slice(2));
}
