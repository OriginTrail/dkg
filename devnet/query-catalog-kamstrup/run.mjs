#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '../..');
const kamstrupRoot = resolve(process.env.KAMSTRUP_ROOT ?? resolve(repoRoot, '../kamstrup-dkg'));
const daemonUrl = (process.env.DKG_API_URL ?? 'http://127.0.0.1:9201').replace(/\/$/, '');
const tokenFile = resolve(process.env.DKG_AUTH_TOKEN_FILE ?? resolve(repoRoot, '.devnet/node1/auth.token'));
const contextGraphId = process.env.DKG_KAMSTRUP_CONTEXT_GRAPH_ID ?? 'kamstrup-manufacturing';
const outputFile = resolve(
  process.env.DKG_KAMSTRUP_RECEIPT
    ?? resolve(repoRoot, '.devnet/query-catalog-kamstrup/receipt.json'),
);

const injector = await import(pathToFileURL(resolve(kamstrupRoot, 'scripts/inject-query-catalog.mjs')).href);
const harness = await import(pathToFileURL(resolve(kamstrupRoot, 'scripts/query-catalog-harness.mjs')).href);
const catalogInput = JSON.parse(
  await readFile(resolve(kamstrupRoot, 'scripts/query-catalog.kamstrup.json'), 'utf8'),
);
const token = (await readFile(tokenFile, 'utf8'))
  .split('\n')
  .map((line) => line.trim())
  .find((line) => line && !line.startsWith('#'));
if (!token) throw new Error(`No bearer token found in ${tokenFile}`);

async function api(method, endpoint, body) {
  const response = await fetch(`${daemonUrl}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${endpoint} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    const error = new Error(
      `${method} ${endpoint} failed: HTTP ${response.status} ${payload.error ?? payload.message ?? ''}`.trim(),
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function ensureContextGraph() {
  try {
    return await api('POST', '/api/context-graph/create', {
      id: contextGraphId,
      name: 'Kamstrup Manufacturing Traceability',
      description: 'Local acceptance Context Graph for the Kamstrup seven-query catalogue.',
      accessPolicy: 0,
    });
  } catch (error) {
    if (error.status === 409) return { existing: contextGraphId };
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function bindingValue(value) {
  if (value && typeof value === 'object' && typeof value.value === 'string') return value.value;
  return String(value ?? '').replace(/^<|>$/g, '');
}

const startedAt = new Date().toISOString();
const status = await api('GET', '/api/status');
const contextGraph = await ensureContextGraph();
const resolvedInput = await injector.resolveCatalogQueries(contextGraphId, catalogInput);
const contract = harness.inspectCatalogContract(contextGraphId, resolvedInput);
const built = injector.buildCatalogQuads(contextGraphId, resolvedInput);

// The Kamstrup injector still emits the legacy `forSubGraph` literal. The
// daemon owns compatibility normalization and persists canonical scopeGraph
// IRIs as immutable Context Graph data. Deliberately omit the old `mode` field.
const writeBody = { contextGraphId, quads: built.quads };
const firstWrite = await api('POST', '/api/profile/query-catalog/write', writeBody);
const retryWrite = await api('POST', '/api/profile/query-catalog/write', writeBody);
const readBackPayload = await api('POST', '/api/profile/query-catalog/read', { contextGraphId });
const readBack = harness.assertCatalogReadBack(contextGraphId, resolvedInput, readBackPayload);
const expectedStoredTriples = built.quads.length + contract.queryCount + 1;
const firstWriteComplete = firstWrite.triplesWritten === expectedStoredTriples
  || (firstWrite.alreadyExists === true && firstWrite.triplesWritten === 0);

assert(firstWrite.ok === true, 'First immutable write was not acknowledged');
assert(firstWrite.queryCount === contract.queryCount, 'First write query count changed');
assert(firstWrite.subGraphName === 'meta', 'Catalog was not written through the meta subgraph');
assert(firstWriteComplete, 'Canonical scopeGraph normalization produced an incomplete assertion');
assert(retryWrite.alreadyExists === true, 'Exact retry was not idempotent');
assert(retryWrite.triplesWritten === 0, 'Exact retry wrote duplicate triples');
assert(retryWrite.assertionUri === firstWrite.assertionUri, 'Exact retry changed assertion identity');
assert(readBackPayload.schemaVersion === 2, 'Expected query-catalog schema version 2');
assert(readBack.rowCount === contract.queryCount, 'Read-back did not return every Kamstrup query');
assert(readBackPayload.items.every((item) => item.scopeGraph === `did:dkg:context-graph:${contextGraphId}`),
  'Read-back did not expose canonical Context Graph scope IRIs');

const firstQuerySubject = built.quads.find((quad) => quad.object.endsWith('/SavedQuery'))?.subject;
assert(firstQuerySubject, 'Kamstrup payload contains no SavedQuery subject');
const placementPayload = await api('POST', '/api/query', {
  contextGraphId,
  view: 'working-memory',
  includeContextGraphPartitions: true,
  sparql: `SELECT DISTINCT ?g WHERE { GRAPH ?g { <${firstQuerySubject}> ?p ?o } }`,
});
const placementRows = placementPayload?.result?.bindings
  ?? placementPayload?.bindings
  ?? placementPayload?.result
  ?? [];
const placementGraphs = Array.isArray(placementRows)
  ? [...new Set(placementRows.map((row) => bindingValue(row.g)).filter(Boolean))]
  : [];
assert(
  placementGraphs.includes(firstWrite.assertionUri),
  `Catalog query was not found in its meta assertion graph; got ${JSON.stringify(placementGraphs)}`,
);
assert(
  firstWrite.assertionUri.startsWith(`did:dkg:context-graph:${contextGraphId}/meta/`),
  `Catalog assertion escaped the Context Graph meta subgraph: ${firstWrite.assertionUri}`,
);

const receipt = {
  schemaVersion: 1,
  status: 'passed',
  startedAt,
  completedAt: new Date().toISOString(),
  dkg: {
    version: status.version,
    commit: status.commit,
    networkConfig: status.networkConfig,
    chainId: status.chain?.chainId,
    nodeRole: status.nodeRole,
    storeBackend: status.storeBackend,
  },
  kamstrup: {
    sourceRoot: kamstrupRoot,
    catalogFile: resolve(kamstrupRoot, 'scripts/query-catalog.kamstrup.json'),
    catalogName: contract.catalog,
    queryCount: contract.queryCount,
    sourceTripleCount: built.quads.length,
    querySlugs: contract.slugs,
  },
  contextGraph: {
    id: contextGraphId,
    created: contextGraph.created === contextGraphId,
    graph: firstWrite.graph,
    subGraphName: firstWrite.subGraphName,
    assertionName: firstWrite.assertionName,
    assertionUri: firstWrite.assertionUri,
    placementGraphs,
  },
  checks: {
    contract: contract.passed,
    immutableFirstWrite: firstWriteComplete,
    canonicalScopeNormalization: true,
    readBack: readBack.passed,
    exactRetryIdempotent: retryWrite.alreadyExists === true && retryWrite.triplesWritten === 0,
    storedInContextGraphMetaSubgraph: placementGraphs.includes(firstWrite.assertionUri),
  },
  writes: {
    first: {
      queryCount: firstWrite.queryCount,
      triplesWritten: firstWrite.triplesWritten,
      alreadyExists: firstWrite.alreadyExists,
    },
    retry: {
      queryCount: retryWrite.queryCount,
      triplesWritten: retryWrite.triplesWritten,
      alreadyExists: retryWrite.alreadyExists,
    },
  },
  readBack: {
    schemaVersion: readBackPayload.schemaVersion,
    queryCount: readBack.rowCount,
    totalCatalogRows: readBack.totalCatalogRows,
  },
};

await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...receipt, receiptFile: outputFile }, null, 2)}\n`);
