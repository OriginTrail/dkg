import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type oxigraph from 'oxigraph';
import { startOxigraphSparqlEndpoint } from './helpers/oxigraph-sparql-endpoint.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test endpoint');
  return `http://127.0.0.1:${address.port}/query`;
}
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
const term = (value: oxigraph.Term) => value.termType === 'Literal'
  ? { type: value.termType, value: value.value, language: value.language, datatype: value.datatype.value }
  : { type: value.termType, value: value.value };

async function run(mode: string, populated: 'named' | 'default' | false,
  options: { lowDisk?: boolean; redirect?: 'query' | 'mutation'; assets?: number; group?: number; corrupt?: 'missing' | 'wrong-graph'; alteredInput?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ingest-guard-'));
  const nq = '<urn:s> <urn:p> "plain" <urn:g> .\n<urn:s> <urn:link> <urn:o> <urn:g> .\n<urn:s> <urn:lang> "hello"@en <urn:g> .\n<urn:s> <urn:number> "42"^^<http://www.w3.org/2001/XMLSchema#integer> <urn:g> .\n# comment without a final newline';
  const assets = [];
  for (let i = 0; i < (options.assets ?? 1); i++) {
    const graph = i === 0 ? 'urn:g' : `urn:g:${i}`;
    const text = nq.replaceAll('<urn:g>', `<${graph}>`).replaceAll('<urn:s>', i === 0 ? '<urn:s>' : `<urn:s:${i}>`);
    const file = `input-${i}.nq`;
    await writeFile(join(home, file), text);
    assets.push({ file, graph, quads: 4, sha256: createHash('sha256').update(text).digest('hex') });
  }
  await writeFile(join(home, 'manifest.json'), JSON.stringify({ assets }));
  if (options.alteredInput) await writeFile(join(home, assets[0]!.file), nq.replace('"plain"', '"other"'));
  let mutations = 0, successfulMutations = 0, redirectedRequests = 0, emittedRedirects = 0;
  const expectedWrites = mode === 'atomic' ? assets.length : Math.ceil(assets.length / (options.group ?? 1));
  const endpoint = await startOxigraphSparqlEndpoint({
    onMutation: () => { mutations++; },
    afterMutation: store => {
      successfulMutations++;
      if (!options.corrupt || successfulMutations !== expectedWrites) return;
      store.update('DELETE DATA { GRAPH <urn:g> { <urn:s> <urn:p> "plain" } }');
      if (options.corrupt === 'wrong-graph') store.update('INSERT DATA { GRAPH <urn:g:1> { <urn:s> <urn:p> "plain" } }');
    },
  });
  if (populated) endpoint.store.load(`<urn:old> <urn:p> "keep" ${populated === 'named' ? '<urn:g> ' : ''}.`, { format: 'application/n-quads' });
  let url = endpoint.queryEndpoint;
  const servers: Server[] = [];
  if (options.redirect) {
    const target = createServer((_req, res) => { redirectedRequests++; res.end('unexpected'); });
    servers.push(target);
    const destination = await listen(target);
    const proxy = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const type = String(req.headers['content-type']);
      const mutation = type.includes('n-quads') || type.includes('sparql-update');
      if (options.redirect === 'query' || (options.redirect === 'mutation' && mutation)) {
        emittedRedirects++;
        res.writeHead(307, { location: destination }); res.end(); return;
      }
      const response = await fetch(endpoint.queryEndpoint, { method: 'POST',
        headers: { 'content-type': type, accept: String(req.headers.accept) }, body: Buffer.concat(chunks) });
      res.writeHead(response.status, { 'content-type': String(response.headers.get('content-type')) });
      res.end(await response.text());
    });
    servers.push(proxy); url = await listen(proxy);
  }
  const args: string[] = [];
  if (options.lowDisk) {
    await writeFile(join(home, 'guard.mjs'), `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; fs.statfs=async path=>({bavail:String(path).endsWith('journal')?1:100000000,bsize:4096}); syncBuiltinESMExports();`);
    args.push('--import', join(home, 'guard.mjs'));
  }
  args.push(resolve('scripts/ingest-floor-benchmark.mjs'), '--manifest', join(home, 'manifest.json'),
    '--endpoint', url, '--mode', mode, '--out', join(home, 'out.json'), '--storage-path', join(home, 'journal'));
  if (options.group !== undefined) args.push('--group', String(options.group));
  await mkdir(join(home, 'journal'));
  let output = '';
  try {
    const code = await new Promise<number | null>(resolve => {
      const child = spawn(process.execPath, args, { timeout: 10000 });
      child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
      child.on('close', resolve);
    });
    const quads = endpoint.store.match().map(q => ({ subject: term(q.subject), predicate: term(q.predicate), object: term(q.object), graph: term(q.graph) }));
    const report = await readFile(join(home, 'out.json'), 'utf8').then(JSON.parse).catch(() => null);
    return { code, mutations, redirectedRequests, emittedRedirects, output, quads, report };
  } finally {
    for (const server of servers.reverse()) await close(server);
    await endpoint.close(); await rm(home, { recursive: true, force: true });
  }
}

describe('storage benchmark safety and RDF boundaries', () => {
  it.each(['atomic', 'rdf'])('refuses populated namespaces before %s writes', async mode => {
    for (const kind of ['named', 'default'] as const) {
      const r = await run(mode, kind);
      expect(r.code).not.toBe(0); expect(r.mutations).toBe(0); expect(r.quads).toHaveLength(1);
      expect(r.output).toContain('Refusing a nonempty');
    }
  });
  it.each(['atomic', 'rdf'])('checks the journal filesystem before %s writes', async mode => {
    const r = await run(mode, false, { lowDisk: true });
    expect(r.code).toBe(1); expect(r.mutations).toBe(0); expect(r.output).toContain('Disk below');
  });
  it.each(['atomic', 'rdf'])('preserves RDF terms and separates trailing comments in %s mode', async mode => {
    const r = await run(mode, false);
    expect(r.code, r.output).toBe(0);
    const named = (value: string) => ({ type: 'NamedNode', value });
    const literal = (value: string, datatype = 'http://www.w3.org/2001/XMLSchema#string', language = '') => ({ type: 'Literal', value, datatype, language });
    const expected = [
      { subject: named('urn:s'), predicate: named('urn:p'), object: literal('plain'), graph: named('urn:g') },
      { subject: named('urn:s'), predicate: named('urn:link'), object: named('urn:o'), graph: named('urn:g') },
      { subject: named('urn:s'), predicate: named('urn:lang'), object: literal('hello', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString', 'en'), graph: named('urn:g') },
      { subject: named('urn:s'), predicate: named('urn:number'), object: literal('42', 'http://www.w3.org/2001/XMLSchema#integer'), graph: named('urn:g') },
      { subject: named('urn:g'), predicate: named('urn:benchmark:status'), object: literal('confirmed'), graph: named('urn:benchmark:meta') },
    ];
    expect(r.quads).toHaveLength(expected.length);
    expect(r.quads).toEqual(expect.arrayContaining(expected));
  });
  it.each(['atomic', 'rdf'])('refuses query and mutation redirects in %s mode', async mode => {
    for (const redirect of ['query', 'mutation'] as const) {
      const r = await run(mode, false, { redirect });
      expect(r.code, r.output).not.toBe(0);
      expect(r.emittedRedirects).toBeGreaterThan(0);
      expect(r.redirectedRequests).toBe(0); expect(r.mutations).toBe(0); expect(r.quads).toEqual([]);
    }
  });
  it.each(['atomic', 'rdf'])('groups three assets with a partial final batch in %s mode', async mode => {
    const r = await run(mode, false, { assets: 3, group: 2 });
    expect(r.code, r.output).toBe(0);
    expect(r.mutations).toBe(mode === 'rdf' ? 2 : 3);
    expect(r.report).toMatchObject({ complete: true, assets: 3, groupSize: 2, quads: 12, actualQuads: 15, graphCountsMatch: true });
    expect(r.report.batches.map((b: { assets: number; quads: number; offset: number }) => [b.offset,b.assets,b.quads])).toEqual([[0,2,8],[2,1,4]]);
    expect(r.report.bytes).toBe(r.report.batches.reduce((sum: number, b: { bytes: number }) => sum+b.bytes, 0));
    for (const graph of ['urn:g', 'urn:g:1', 'urn:g:2']) {
      const data = r.quads.filter(q => q.graph.value === graph);
      expect(data).toHaveLength(4);
      expect(data.map(q => [q.predicate.value,q.object.value]).sort()).toEqual([
        ['urn:p','plain'],['urn:link','urn:o'],['urn:lang','hello'],['urn:number','42'],
      ].sort());
      expect(r.quads.filter(q => q.graph.value === 'urn:benchmark:meta' && q.subject.value === graph))
        .toEqual([expect.objectContaining({predicate:expect.objectContaining({value:'urn:benchmark:status'}),object:expect.objectContaining({value:'confirmed'})})]);
    }
  });

  it.each(['atomic', 'rdf'])('fails completion verification for missing and misplaced quads in %s mode', async mode => {
    for (const corrupt of ['missing','wrong-graph'] as const) {
      const r=await run(mode,false,{assets:3,group:2,corrupt});
      expect(r.code,r.output).toBe(1);
      expect(r.report).toMatchObject({complete:false,graphCountsMatch:false,quads:12,actualQuads:corrupt==='missing'?14:15});
      expect(r.report.error).toContain('Stored graph/count verification failed');
      expect(r.mutations).toBe(mode==='rdf'?2:3);
    }
  });

  it.each(['atomic', 'rdf'])('rejects changed input values before %s writes', async mode => {
    const r = await run(mode, false, { alteredInput: true });
    expect(r.code, r.output).toBe(1);
    expect(r.report).toMatchObject({ complete: false });
    expect(r.report.error).toContain('Input digest mismatch');
    expect(r.mutations).toBe(0); expect(r.quads).toEqual([]);
  });

});
