#!/usr/bin/env node
// The large graph catalog fixture of packages/query/test-live on a devnet node:
// load it into the node's own store, read its small context graph through the
// node's /api/query, and remove the graphs that only make the catalog large.
// Run with tsx, from the repository root, after the packages are built:
//
//   node --import tsx scripts/devnet-large-catalog-store.mjs <command> ...
//
//   load <blazegraph|oxigraph-server> <store url>     insert the fixture into the store
//   remove <blazegraph|oxigraph-server> <store url>   delete the graphs of the unrelated context graphs
//   check <api url> <token file>                      every read answers 200 with the fixture's rows
//   node-limit <api url> <token file>                 a read past the node-side ceiling answers 503 STORE_INTERNAL_LIMIT
//
// Exit status: 0 when the command did what it says, 1 otherwise.
import { readFileSync } from 'node:fs';
import { quadsToNQuads } from '../packages/storage/dist/index.js';
import {
  AGENT, FIXTURE_QUERIES, FIXTURE_READS, SMALL_CONTEXT_GRAPH,
  expectedSubjects, fixtureAssets, loadLargeCatalog, unrelatedGraphNames,
} from '../packages/query/test-live/large-catalog-fixture.ts';

const SPARQL_UPDATE = 'application/sparql-update; charset=utf-8';

/** Where to send a bulk load and an update, for each store the devnet configures. */
function storeEndpoints(kind, url) {
  if (kind === 'blazegraph') return { load: url, loadType: 'text/x-nquads', update: url };
  if (kind === 'oxigraph-server') {
    const base = url.replace(/\/+$/, '');
    return { load: `${base}/store`, loadType: 'application/n-quads', update: `${base}/update` };
  }
  throw new Error(`Unknown store kind: ${kind}`);
}

async function post(url, contentType, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': contentType }, body,
    signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

function readToken(file) {
  const token = readFileSync(file, 'utf8').split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#'));
  if (!token) throw new Error(`No token in ${file}`);
  return token;
}

async function apiQuery(api, token, body) {
  const started = Date.now();
  const response = await fetch(`${api.replace(/\/+$/, '')}/api/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, json, text, ms: Date.now() - started };
}

function answer(form, result) {
  if (form === 'ASK') return result?.type === 'boolean' ? result.value : undefined;
  if (form === 'CONSTRUCT') return (result?.quads ?? []).map(quad => quad.subject).sort();
  return (result?.bindings ?? []).map(row => row.s).sort();
}

const readBody = (sparql, read) => ({
  sparql, contextGraphId: SMALL_CONTEXT_GRAPH, view: read.view, subGraphName: read.subGraphName, minTrust: read.minTrust,
  agentAddress: read.view === 'working-memory' ? AGENT : undefined,
});
const readName = read => [read.view ?? 'legacy route', read.subGraphName && `sub-graph ${read.subGraphName}`,
  read.minTrust !== undefined && `minTrust ${read.minTrust}`].filter(Boolean).join(', ');

const commands = {
  async load(kind, url) {
    const { load, loadType } = storeEndpoints(kind, url);
    const fixture = await loadLargeCatalog({ insert: quads => post(load, loadType, `${quadsToNQuads(quads)}\n`) });
    console.log(JSON.stringify({ loaded: fixture.graphCount, catalogBytes: fixture.catalogBytes,
      seconds: Math.round(fixture.loadMs / 100) / 10 }));
    return true;
  },

  async remove(kind, url) {
    // By name, a batch at a time: the update touches only the graphs that load wrote.
    const { update } = storeEndpoints(kind, url);
    let removed = 0;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      await post(update, SPARQL_UPDATE, batch.map(graph => `DROP SILENT GRAPH <${graph}>`).join(' ;\n'));
      removed += batch.length;
      batch = [];
    };
    for (const graph of unrelatedGraphNames()) {
      batch.push(graph);
      if (batch.length === 2_000) await flush();
    }
    await flush();
    console.log(JSON.stringify({ removed }));
    return true;
  },

  async check(api, tokenFile) {
    const token = readToken(tokenFile);
    const assets = fixtureAssets();
    let failed = 0;
    for (const read of FIXTURE_READS) {
      const subjects = expectedSubjects(assets, read);
      for (const [form, sparql] of Object.entries(FIXTURE_QUERIES)) {
        const name = `${form} on ${readName(read)}`;
        const reply = await apiQuery(api, token, readBody(sparql, read));
        const wanted = form === 'ASK' ? true : subjects;
        const got = reply.status === 200 ? answer(form, reply.json?.result) : undefined;
        if (JSON.stringify(got) === JSON.stringify(wanted)) {
          console.log(`PASS ${name} (${reply.ms} ms)`);
        } else {
          failed++;
          const detail = reply.status === 200 ? `answered ${JSON.stringify(got)?.slice(0, 200)}` : `HTTP ${reply.status} ${reply.text.slice(0, 300)}`;
          console.log(`FAIL ${name}: expected ${form === 'ASK' ? 'true' : `${subjects.length} subjects`}, ${detail}`);
        }
      }
    }
    console.log(failed ? `${failed} read(s) failed` : 'every read answered as expected');
    return failed === 0;
  },

  async ['node-limit'](api, tokenFile) {
    const reply = await apiQuery(api, readToken(tokenFile), readBody(FIXTURE_QUERIES.SELECT, { view: 'verifiable-memory' }));
    const ok = reply.status === 503 && reply.json?.code === 'STORE_INTERNAL_LIMIT';
    console.log(`${ok ? 'PASS' : 'FAIL'} a read past the node-side ceiling: HTTP ${reply.status} ${reply.text.slice(0, 300)}`);
    return ok;
  },
};

const [command, ...args] = process.argv.slice(2);
if (!Object.hasOwn(commands, command) || args.length !== 2) {
  console.error('usage: devnet-large-catalog-store.mjs load|remove <store kind> <store url> | check|node-limit <api url> <token file>');
  process.exit(1);
}
try {
  process.exitCode = await commands[command](...args) ? 0 : 1;
} catch (error) {
  console.error(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
