import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const [directory, api] = process.argv.slice(2);
try {
  const apiUrl = new URL(api);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(apiUrl.hostname)) throw Error();
  const root = realpathSync(directory);
  // Only the local devnet's node config, never a global node home.
  if (dirname(root) !== resolve(import.meta.dirname, '../../..')) throw Error();
  let config;
  for (let n = 1; n <= 6; n++) {
    try {
      const candidate = JSON.parse(readFileSync(resolve(root, `node${n}/config.json`), 'utf8'));
      if (String(candidate.apiPort) === apiUrl.port) config = candidate;
    } catch { /* absent nodes are not candidates */ }
  }
  if (!config || config.chain?.chainId !== 'evm:31337'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.chain.rpcUrl).hostname)) throw Error();
  const store = config.store, options = store?.options ?? {};
  const endpoint = store?.backend === 'blazegraph' ? options.url
    : store?.backend === 'sparql-http' ? options.queryEndpoint
      : store?.backend === 'oxigraph-server' && Number.isInteger(options.port)
        ? `http://127.0.0.1:${options.port}/query` : null;
  if (!endpoint || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname)) throw Error();
  console.log(endpoint);
} catch {
  console.error('INCONCLUSIVE: physical observation requires this checkout’s local devnet HTTP store');
  process.exitCode = 2;
}
