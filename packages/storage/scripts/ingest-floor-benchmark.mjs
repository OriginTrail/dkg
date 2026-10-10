#!/usr/bin/env node
// Storage-only comparison. Input preparation, validation and durable ingestion
// are reported separately; this is not a network-recovery benchmark.
import { createHash } from 'node:crypto';
import { readFile, writeFile, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import oxigraph from 'oxigraph';
import { formatCanonicalRdfTerm } from '@origintrail-official/dkg-rdf-utils';
import { SparqlHttpStore } from '../dist/index.js';
import { countValue } from '../../../scripts/lib/qa/query-observation.mjs';

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error('Expected --key value');
    result[argv[i].slice(2)] = argv[i + 1];
  }
  return result;
}
const options = args(process.argv.slice(2));
if (!options.manifest || !options.endpoint || !options.out || !options['storage-path']) throw new Error('Required: --manifest FILE --endpoint URL --mode atomic|rdf --out FILE --storage-path DIRECTORY');
const manifestPath = resolve(options.manifest);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const mode = options.mode;
if (!['atomic', 'rdf'].includes(mode)) throw new Error('mode must be atomic or rdf');
const endpoint = new URL(options.endpoint);
if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('Only loopback test stores are allowed');
// This standalone benchmark owns its process: constrain both the adapter and
// direct RDF POSTs before dispatch, including redirects on initially local URLs.
const fetchEndpoint = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const destination = new URL(input instanceof Request ? input.url : input);
  if (destination.href !== endpoint.href) throw new Error('Benchmark endpoint changed');
  return fetchEndpoint(input, { ...init, redirect: 'error' });
};
const output = resolve(options.out);
const storagePath = resolve(options['storage-path']);
const groupSize = Number(options.group ?? '1');
if (!Number.isSafeInteger(groupSize) || groupSize < 1 || groupSize > 100) throw new Error('Invalid group');
const limit = Number(options.limit ?? manifest.assets.length);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > manifest.assets.length) throw new Error('Invalid limit');
const selected = manifest.assets.slice(0, limit);
const store = new SparqlHttpStore({ queryEndpoint: endpoint.href, consistencyProfile: 'atomic-readback', timeout: 120000 });
const numeric = term => {
  const value = countValue(term);
  if (value === null || !Number.isSafeInteger(Number(value))) throw new Error('Invalid or oversized SPARQL count');
  return Number(value);
};
const existing = await store.query('SELECT ?g WHERE { GRAPH ?g { FILTER EXISTS { ?s ?p ?o } } } LIMIT 1');
const defaultExisting = await store.query('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1');
if (existing.bindings.length !== 0 || defaultExisting.bindings.length !== 0) throw new Error('Refusing a nonempty store; supply a fresh owned namespace');
const elapsed = start => performance.now() - start;
const sha = value => createHash('sha256').update(value).digest('hex');
const result = {
  schemaVersion: 1, mode, groupSize, assets: selected.length,
  manifestSha256: sha(await readFile(manifestPath)),
  startedAt: new Date().toISOString(), complete: false,
  inputReadMs: 0, parseMs: 0, writeMs: 0, quads: 0, bytes: 0, batches: [],
};
const start = performance.now();
try {
  for (let offset = 0; offset < selected.length; offset += groupSize) {
    const disk = await statfs(storagePath);
    if (disk.bavail * disk.bsize < 5 * 1024 ** 3) throw new Error('Disk below 5 GiB guard');
    const batch = selected.slice(offset, offset + groupSize);
    const parsed = [];
    let bytes = 0, quads = 0;
    for (const asset of batch) {
      let mark = performance.now();
      const nq = await readFile(resolve(dirname(manifestPath), asset.file), 'utf8');
      result.inputReadMs += elapsed(mark);
      if (sha(nq) !== asset.sha256) throw new Error('Input digest mismatch');
      bytes += Buffer.byteLength(nq);
      mark = performance.now();
      const parser = new oxigraph.Store();
      parser.load(nq, { format: 'application/n-quads' });
      const terms = parser.match();
      if (terms.some(q => [q.subject,q.object,q.graph].some(t => t.termType === 'BlankNode'))) throw new Error('Use stable named-node identities; blank nodes are unsupported');
      const data = terms.map(q => ({
        subject: q.subject.value, predicate: q.predicate.value,
        object: formatCanonicalRdfTerm(q.object),
        graph: q.graph.value,
      }));
      if (data.length !== asset.quads || data.some(q => q.graph !== asset.graph)) throw new Error('Input graph/count mismatch');
      quads += data.length;
      result.parseMs += elapsed(mark);
      parsed.push({ asset, nq, data });
    }
    const mark = performance.now();
    if (mode === 'atomic') {
      for (const { asset, data } of parsed) {
        await store.replaceGraphAndSubject(asset.graph, data, 'urn:benchmark:meta', asset.graph, [{
          subject: asset.graph, predicate: 'urn:benchmark:status', object: '"confirmed"', graph: 'urn:benchmark:meta',
        }]);
      }
    } else {
      const payload = parsed.map(({ asset, nq }) => `${nq}\n<${asset.graph}> <urn:benchmark:status> "confirmed" <urn:benchmark:meta> .\n`).join('');
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/n-quads' }, body: payload,
        signal: AbortSignal.timeout(120000),
      });
      const reply = await response.text();
      if (!response.ok) throw new Error(`RDF ingestion HTTP ${response.status}: ${reply.slice(0, 200)}`);
    }
    const writeMs = elapsed(mark);
    result.writeMs += writeMs; result.quads += quads; result.bytes += bytes;
    result.batches.push({ offset, assets: batch.length, bytes, quads, writeMs });
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    if (offset % 50 === 0) console.log(JSON.stringify({ mode, completed: offset + batch.length, elapsedSeconds: elapsed(start) / 1000 }));
  }
  result.ingestWallMs = elapsed(start);
  const check = performance.now();
  // sparql-scan-allow: R2 -- Fixed-corpus integrity check in the benchmark-only fresh store; enumeration deliberately detects unexpected graphs as well as missing data.
  const grouped = await store.query('SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g');
  const counts = new Map(grouped.bindings.map(row => [row.g, numeric(row.n)]));
  result.actualQuads = [...counts.values()].reduce((sum, n) => {
    const next = sum + n;
    if (!Number.isSafeInteger(next)) throw new Error('Stored quad total exceeds safe integer');
    return next;
  }, 0);
  result.graphCountsMatch = selected.every(asset => counts.get(asset.graph) === asset.quads)
    && counts.size === selected.length + 1 && counts.get('urn:benchmark:meta') === selected.length;
  result.verificationMs = elapsed(check);
  result.complete = result.actualQuads === result.quads + selected.length && result.graphCountsMatch;
  if (!result.complete) throw new Error('Stored graph/count verification failed');
} catch (error) {
  result.error = String(error);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  result.totalMs = elapsed(start);
  result.peakClientRssKiB = process.resourceUsage().maxRSS;
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  await store.close();
  console.log(JSON.stringify({ mode, complete: result.complete, quads: result.quads, writeSeconds: result.writeMs / 1000, error: result.error }));
}
