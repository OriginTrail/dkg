// One chain RPC fetch in a fresh Node process, so a test can start that
// process with Node's environment proxy (NODE_USE_ENV_PROXY), which Node
// reads only at startup. Node strips the TypeScript types of the module.
const [url, modulePath] = process.argv.slice(2);
const { chainRpcFetchInit } = await import(modulePath);
const response = await fetch(url, chainRpcFetchInit({ method: 'POST', body: '{}' }));
process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));
