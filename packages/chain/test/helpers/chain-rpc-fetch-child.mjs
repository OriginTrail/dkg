// One chain RPC fetch in a fresh Node process, so a test can start that
// process with Node's environment proxy (NODE_USE_ENV_PROXY), which Node
// reads only at startup. Node strips the module's TypeScript types.
import { chainRpcFetchInit } from '../../src/rpc-http1-dispatcher.ts';

const [url] = process.argv.slice(2);
const response = await fetch(url, chainRpcFetchInit({ method: 'POST', body: '{}' }));
process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));
