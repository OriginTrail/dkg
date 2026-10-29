/** Opt-in local integration fixture: real routes, RDF engine, SQLite and configured embeddings.
 * No chain, peers, authentication middleware or production daemon/profile is started.
 * Input: JSON {contextGraphId, quads, embedding}; output: a port file supplied by the caller.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../../../query/src/dkg-query-engine.js';
import { createEntitySearch } from '../../src/entity-search/runtime.js';
import { handleEntityRoutes } from '../../src/daemon/routes/entities.js';
import { handleBoundedQueryRoutes } from '../../src/daemon/routes/bounded-query.js';
import { requestAuthentication } from '../_helpers/request-authentication.js';
import type { RequestContext } from '../../src/daemon/routes/context.js';

const [inputFile, directory, portFile] = process.argv.slice(2);
if (!inputFile || !directory || !portFile) throw new Error('Expected fixture.json data-directory port-file');
const fixture = JSON.parse(readFileSync(inputFile, 'utf8'));
const store = new OxigraphStore();
await store.insert(fixture.quads);
const queryEngine = new DKGQueryEngine(store);
const agent = { query: queryEngine.query.bind(queryEngine) };
const entitySearch = createEntitySearch(directory, { embedding: fixture.embedding })!;
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url!, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && path === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ networkId: 'isolated-entity-fixture' })); return;
    }
    const ctx = { req, res, path, agent, entitySearch,
      authentication: requestAuthentication({ kind: 'nodeOperator' }) } as unknown as RequestContext;
    await handleEntityRoutes(ctx);
    if (!res.writableEnded) await handleBoundedQueryRoutes(ctx);
    if (!res.writableEnded) { res.writeHead(404); res.end(); }
  } catch { if (!res.writableEnded) { res.writeHead(500); res.end(); } }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
writeFileSync(portFile, String((server.address() as { port: number }).port));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await new Promise<void>(resolve => server.close(() => resolve()));
  entitySearch.close(); await store.close(); process.exit(0);
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
