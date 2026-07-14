import fs from 'fs';
import { Client } from 'pg';
import { pathToFileURL } from 'url';
import 'dotenv/config';

const MAINNET_PORTS = [':8453', ':100', ':2043'];

function targetForSummary(summary, env) {
    const isMainnet = typeof summary.blockchain_name === 'string'
        && MAINNET_PORTS.some((port) => summary.blockchain_name.endsWith(port));
    return {
        isMainnet,
        tableName: isMainnet ? 'publish_mainnet_summary' : 'publish_testnet_summary',
        dbHost: isMainnet ? env.DB_HOST_PUBLISH_MAINNET : env.DB_HOST_PUBLISH_TESTNET,
    };
}

function parseSummaries(files, fsImpl, env, logger) {
    const artifacts = [];
    let failed = false;

    for (const file of files) {
        logger.log(`Processing ${file}`);
        try {
            const summary = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
            artifacts.push({ file, summary, target: targetForSummary(summary, env) });
        } catch (error) {
            logger.error(`❌ Failed to read or parse ${file}:`, error.message);
            failed = true;
        }
    }

    if (failed) return null;
    const targetKinds = new Set(artifacts.map(({ target }) => target.isMainnet));
    if (targetKinds.size > 1) {
        logger.error('❌ A summary import must contain only mainnet or only testnet artifacts so it can be committed atomically');
        return null;
    }
    return artifacts;
}

/**
 * Import one Jenkins summary batch as a single transaction. Parsing happens
 * before connecting, and any insert/commit failure rolls the whole batch back,
 * so retrying a failed CI step cannot duplicate an earlier file from the batch.
 */
export async function importSummaries(
    files,
    {
        createClient = (config) => new Client(config),
        env = process.env,
        fsImpl = fs,
        logger = console,
    } = {},
) {
    if (files.length === 0) {
        logger.error('❌ No summary files were provided');
        return 1;
    }

    const artifacts = parseSummaries(files, fsImpl, env, logger);
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
                blockchain_name, node_name,
                publish_success_rate, query_success_rate,
                publisher_get_success_rate, non_publisher_get_success_rate,
                average_publish_time, average_query_time,
                average_publisher_get_time, average_non_publisher_get_time,
                time_stamp
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `;

        for (const { file, summary } of artifacts) {
            try {
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
                logger.log(`✅ Staged ${file} for table '${tableName}'`);
            } catch (error) {
                throw new Error(`Failed to insert ${file} into table '${tableName}': ${error.message}`, { cause: error });
            }
        }

        await db.query('COMMIT');
        transactionOpen = false;
        logger.log(`✅ Committed ${artifacts.length} summary artifact(s) atomically`);
        return 0;
    } catch (error) {
        logger.error('❌ Summary import failed:', error.message);
        if (transactionOpen) {
            try {
                await db.query('ROLLBACK');
                transactionOpen = false;
                logger.log('✅ Rolled back summary import transaction');
            } catch (rollbackError) {
                logger.error('❌ Failed to roll back summary import transaction:', rollbackError.message);
            }
        }
        return 1;
    } finally {
        try {
            await db.end();
            logger.log('✅ DB connection closed');
        } catch (error) {
            // COMMIT is already authoritative. Treating a socket-close error as
            // an import failure would invite a retry that duplicates data. This
            // also releases a client whose connect attempt failed partway.
            logger.warn('⚠️  DB connection close failed after import result was known:', error.message);
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await importSummaries(process.argv.slice(2));
}
