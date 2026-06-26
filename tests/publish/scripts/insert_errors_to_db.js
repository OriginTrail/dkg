import fs from 'fs';
import { Client } from 'pg';
import 'dotenv/config';

const files = process.argv.slice(2);

for (const file of files) {
    console.log(`📁 Processing error file: ${file}`);
    let errors;

    try {
        const raw = fs.readFileSync(file, 'utf8');
        errors = JSON.parse(raw);
    } catch (err) {
        console.error(`❌ Failed to read or parse ${file}:`, err.message);
        continue;
    }

    const match = file.match(/errors_(.+)\.json$/);
    if (!match) {
        console.error(`❌ Filename format incorrect for ${file}. Expected: errors_<NodeName>.json`);
        continue;
    }

    const nodeName = match[1].replace(/_/g, ' ');
    
    // Try to get blockchain_id from file content (array or object)
    let blockchainIdFromContent = null;
    if (Array.isArray(errors) && errors.length > 0 && errors[0].blockchain_id) {
        blockchainIdFromContent = errors[0].blockchain_id;
    } else if (!Array.isArray(errors)) {
        // For new structure with blockchain_id and detailed sections
        if (errors.blockchain_id) {
            blockchainIdFromContent = errors.blockchain_id;
            // Update errors to use the detailed section (with KA numbers for database)
            errors = errors.detailed || {};
        }
    }
    
    // Also check for blockchain_id in environment variable
    if (!blockchainIdFromContent && process.env.BLOCKCHAIN_ID) {
        blockchainIdFromContent = process.env.BLOCKCHAIN_ID;
    }

    // Use the same logic as insert_summary_to_db.js
    const MAINNET_PORTS = [':8453', ':100', ':2043'];
    let isMainnet = false;
    
    if (blockchainIdFromContent && typeof blockchainIdFromContent === 'string') {
        isMainnet = MAINNET_PORTS.some(port => blockchainIdFromContent.endsWith(port));
    } else if (file.toLowerCase().includes('mainnet')) {
        isMainnet = true;
    } else if (file.toLowerCase().includes('testnet')) {
        isMainnet = false;
    } else {
        // Try to determine from node numbers and file patterns
        const nodeMatch = file.match(/Node_(\d+)/);
        if (nodeMatch) {
            const nodeNumber = parseInt(nodeMatch[1]);
            // Mainnet uses Node 25-30, testnet uses Node 01, 04, 05, etc.
            if (nodeNumber >= 25 && nodeNumber <= 30) {
                isMainnet = true;
            } else {
                isMainnet = false;
            }
        }
    }

    const tableName = isMainnet ? 'error_messages_mainnet_js' : 'error_messages_testnet_js';
    const dbHost = isMainnet ? process.env.DB_HOST_PUBLISH_MAINNET : process.env.DB_HOST_PUBLISH_TESTNET;

    // Determine blockchain_id to use
    let blockchainId;
    if (blockchainIdFromContent) {
        blockchainId = blockchainIdFromContent;
    } else {
        // Try to determine from the file name and node numbers
        const nodeMatch = file.match(/Node_(\d+)/);
        const nodeNumber = nodeMatch ? parseInt(nodeMatch[1]) : null;
        
        // Determine blockchain based on file patterns and node numbers
        if (file.toLowerCase().includes('base')) {
            blockchainId = isMainnet ? 'base:8453' : 'base:84532';
        } else if (file.toLowerCase().includes('gnosis')) {
            blockchainId = isMainnet ? 'gnosis:100' : 'gnosis:10200';
        } else if (file.toLowerCase().includes('neuroweb')) {
            blockchainId = isMainnet ? 'otp:2043' : 'otp:20430';
        } else {
            // Default based on node numbers and mainnet/testnet detection
            if (isMainnet) {
                blockchainId = 'otp:2043'; // Default to neuroweb mainnet
            } else {
                blockchainId = 'otp:20430'; // Default to neuroweb testnet
            }
        }
    }

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

        // Auto-create the target table if it doesn't exist yet (idempotent — a
        // no-op for the long-lived mainnet table, creates the testnet table on
        // its first import). Schema mirrors error_messages_mainnet_js exactly.
        await db.query(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
                node_name TEXT,
                blockchain_id TEXT,
                ka_label TEXT,
                publish_error TEXT,
                query_error TEXT,
                publisher_get_error TEXT,
                non_publisher_get_error TEXT,
                time_stamp TIMESTAMP
            )
        `);

        // Start transaction
        await db.query('BEGIN');
    } catch (err) {
        console.error('❌ Failed to connect to DB:', err.message);
        continue;
    }

    let insertedCount = 0;

    if (Array.isArray(errors)) {
        for (const attempt of errors) {
            // Determine blockchain_id for this row
            let rowBlockchainId = attempt.blockchain_id || blockchainId;
            if (!rowBlockchainId) {
                // Fallback to filename-based logic
                if (file.toLowerCase().includes('base')) {
                    rowBlockchainId = isMainnet ? 'base:8453' : 'base:84532';
                } else if (file.toLowerCase().includes('gnosis')) {
                    rowBlockchainId = isMainnet ? 'gnosis:100' : 'gnosis:10200';
                } else {
                    rowBlockchainId = isMainnet ? 'otp:2043' : 'otp:20430';
                }
            }

            // Determine ka_label for this row
            let rowKaLabel = attempt.ka_label;
            if (!rowKaLabel) {
                // Try to extract KA number from any error field
                const errorFields = [attempt.publish_error, attempt.query_error, attempt.publisher_get_error, attempt.non_publisher_get_error];
                for (const msg of errorFields) {
                    if (typeof msg === 'string') {
                        const kaMatch = msg.match(/KA\s*#?(\d+)/i);
                        if (kaMatch) {
                            rowKaLabel = `KA #${kaMatch[1]}`;
                            break;
                        }
                    }
                }
                if (!rowKaLabel) rowKaLabel = 'Unknown KA';
            }

            const row = {
                node_name: nodeName,
                blockchain_id: rowBlockchainId,
                ka_label: rowKaLabel,
                publish_error: attempt.publish_error || null,
                query_error: attempt.query_error || null,
                publisher_get_error: attempt.publisher_get_error || null,
                non_publisher_get_error: attempt.non_publisher_get_error || null,
                time_stamp: new Date().toISOString(),
            };

            const insertQuery = `
                INSERT INTO ${tableName} (
                    node_name, blockchain_id, ka_label,
                    publish_error, query_error,
                    publisher_get_error, non_publisher_get_error,
                    time_stamp
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `;

            try {
                const result = await db.query(insertQuery, [
                    row.node_name,
                    row.blockchain_id,
                    row.ka_label,
                    row.publish_error,
                    row.query_error,
                    row.publisher_get_error,
                    row.non_publisher_get_error,
                    row.time_stamp
                ]);
                insertedCount++;
                console.log(`✅ Inserted ${row.ka_label} (attempt ${insertedCount}) for ${row.node_name}`);
            } catch (err) {
                console.error(`❌ Failed to insert KA ${row.ka_label}:`, err.message);
            }
        }
    } else {
        // Process detailed errors and group by KA number
        const kaErrors = {};
        
        for (const [errorMsg, count] of Object.entries(errors)) {
            // Extract KA number from the error message key (which includes KA number)
            let kaNumber = null;
            
            // First try to extract KA number from the error message key itself
            const kaMatch = errorMsg.match(/for KA #(\d+)/);
            if (kaMatch) {
                kaNumber = `KA #${kaMatch[1]}`;
            } else {
                // Fallback: Try multiple regex patterns to find KA number in the message content
                const patterns = [
                    /KA\s*#?(\d+)/i,           // KA #5, KA5
                    /Knowledge\s*Asset\s*#?(\d+)/i,  // Knowledge Asset #5
                    /Asset\s*#?(\d+)/i,        // Asset #5
                    /publishing.*KA\s*#?(\d+)/i,  // publishing KA #5
                    /querying.*KA\s*#?(\d+)/i,   // querying KA #5
                    /get.*KA\s*#?(\d+)/i,       // get KA #5
                    /KA\s*#?(\d+)\s*on/i,       // KA #5 on
                    /KA\s*#?(\d+)\s*during/i,   // KA #5 during
                    /(\d+)\s*KA/i,              // 5 KA
                    /KA\s*(\d+)/i               // KA 5
                ];
                
                for (const pattern of patterns) {
                    const match = errorMsg.match(pattern);
                    if (match) {
                        kaNumber = `KA #${match[1]}`;
                        break;
                    }
                }
            }
            
            // If no KA found in message, try to infer from context
            if (!kaNumber) {
                // Check if we can extract from the error message context
                const contextMatch = errorMsg.match(/(\d+)/);
                if (contextMatch) {
                    const num = parseInt(contextMatch[1]);
                    // Only use if it's a reasonable KA number (1-20)
                    if (num >= 1 && num <= 20) {
                        kaNumber = `KA #${num}`;
                    } else {
                        kaNumber = 'Unknown KA';
                    }
                } else {
                    kaNumber = 'Unknown KA';
                }
            }

            // Initialize KA entry if it doesn't exist
            if (!kaErrors[kaNumber]) {
                kaErrors[kaNumber] = {
                    publish_error: null,
                    query_error: null,
                    publisher_get_error: null,
                    non_publisher_get_error: null
                };
            }

            // Route by the V10 operation prefix (every key is "<step> — <error>"):
            //   publish              -> publish_error
            //   query remote (sync)  -> non_publisher_get_error  (checked BEFORE plain "query")
            //   VM GET (legacy: SWM GET / local get) -> publisher_get_error
            //   query                -> query_error
            const lower = errorMsg.toLowerCase();
            if (lower.startsWith('publish')) {
                kaErrors[kaNumber].publish_error = errorMsg;
            } else if (lower.startsWith('query remote') || lower.includes('query remote')) {
                kaErrors[kaNumber].non_publisher_get_error = errorMsg;
            } else if (lower.startsWith('vm get') || lower.startsWith('swm get') || lower.includes('local get')) {
                kaErrors[kaNumber].publisher_get_error = errorMsg;
            } else if (lower.startsWith('query')) {
                kaErrors[kaNumber].query_error = errorMsg;
            } else if (lower.includes('get')) {
                kaErrors[kaNumber].non_publisher_get_error = errorMsg;
            }
        }

        // Insert one row per KA with all its errors
        for (const [kaLabel, errorFields] of Object.entries(kaErrors)) {
            const row = {
                node_name: nodeName,
                blockchain_id: blockchainId,
                ka_label: kaLabel,
                publish_error: errorFields.publish_error,
                query_error: errorFields.query_error,
                publisher_get_error: errorFields.publisher_get_error,
                non_publisher_get_error: errorFields.non_publisher_get_error,
                time_stamp: new Date().toISOString(),
            };

            const insertQuery = `
                INSERT INTO ${tableName} (
                    node_name, blockchain_id, ka_label,
                    publish_error, query_error,
                    publisher_get_error, non_publisher_get_error,
                    time_stamp
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `;

            try {
                const result = await db.query(insertQuery, [
                    row.node_name,
                    row.blockchain_id,
                    row.ka_label,
                    row.publish_error,
                    row.query_error,
                    row.publisher_get_error,
                    row.non_publisher_get_error,
                    row.time_stamp
                ]);
                insertedCount++;
                console.log(`✅ Inserted ${row.ka_label} (attempt ${insertedCount}) for ${row.node_name}`);
            } catch (err) {
                console.error(`❌ Failed to insert KA ${row.ka_label}:`, err.message);
            }
        }
    }

    // Commit transaction
    try {
        await db.query('COMMIT');
    } catch (err) {
        console.error('❌ Failed to commit transaction:', err.message);
        await db.query('ROLLBACK');
    }

    try {
        await db.end();
        console.log('✅ DB connection closed');
    } catch (err) {
        console.error('❌ Failed to close DB connection:', err.message);
    }
}