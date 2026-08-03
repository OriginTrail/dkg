// CG rotation (M3): ensures this week's public CG, the permanent "aging" CG,
// and (optionally) this week's private CG exist, are on-chain registered, and
// that publisher + receiver are subscribed. Idempotent — safe on a daily cron.
//
//   RC_ROTATE_PRIVATE  "1" = also create/register the private pair (default off
//                      until the private-CG allowlist flow is verified live)
//   RC_CG_REGISTER     "1" (default) = register on-chain (testnet TRAC via faucet)
import { weeklyCgNames } from './layered_suite.mjs';
import { makeNodeClient, subscribeAndWait } from '../../src/v10-publish-lib.js';
import 'dotenv/config';

const REGISTER = (process.env.RC_CG_REGISTER || '1') === '1';
const ROTATE_PRIVATE = process.env.RC_ROTATE_PRIVATE === '1';

async function ensureCg(node, id, { accessPolicy, publishPolicy, register }) {
    try {
        await node.createContextGraph(id, id, `release-certification CG (${id})`, { accessPolicy, publishPolicy, register: false });
        console.log(`✅ created CG ${id}`);
    } catch (e) {
        if (e.statusCode === 409 || /exist/i.test(e.message)) console.log(`• CG ${id} already exists`);
        else throw e;
    }
    if (register) {
        try {
            await node.registerContextGraph(id, { accessPolicy, publishPolicy });
            console.log(`✅ registered CG ${id} on-chain`);
        } catch (e) {
            if (e.statusCode === 409 || /already|registered/i.test(e.message)) console.log(`• CG ${id} already registered`);
            else console.error(`⚠️ register ${id} failed: ${e.message} (VM publishes into it will fail until registered)`);
        }
    }
}

async function main() {
    const pub = makeNodeClient(process.env.RC_PUBLISHER_URL || 'http://100.99.142.87:9200', process.env[process.env.RC_PUBLISHER_TOKEN_ENV || 'V10_TOKEN_TESTNET1']);
    const recv = makeNodeClient(process.env.RC_RECEIVER_URL || 'http://100.70.65.41:9200', process.env[process.env.RC_RECEIVER_TOKEN_ENV || 'V10_TOKEN_TESTNET2']);
    const names = weeklyCgNames();

    await ensureCg(pub, names.public, { accessPolicy: 0, publishPolicy: 1, register: REGISTER });
    await ensureCg(pub, names.aging, { accessPolicy: 0, publishPolicy: 1, register: REGISTER });
    if (ROTATE_PRIVATE) await ensureCg(pub, names.private, { accessPolicy: 1, publishPolicy: 0, register: REGISTER });

    const subTimeout = Number(process.env.V10_CG_SUBSCRIBE_TIMEOUT_MS || 90000);
    for (const cg of [names.public, names.aging, ...(ROTATE_PRIVATE ? [names.private] : [])]) {
        await subscribeAndWait(recv, cg, 'receiver', subTimeout, 3000, ['deferred']);
    }
    console.log(`✅ rotation ensured: ${names.public}, ${names.aging}${ROTATE_PRIVATE ? `, ${names.private}` : ''}`);
}

main().catch((err) => {
    console.error(`❌ cg rotate fatal: ${err.message}`);
    process.exit(1);
});
