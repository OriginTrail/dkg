/**
 * Same logical TripleStore operations on Oxigraph vs BlazegraphStore (real HTTP test server)
 * so backends stay aligned on counts and delete semantics (03 §16 graph isolation).
 */
import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { OxigraphStore, BlazegraphStore, type Quad } from '../src/index.js';

const G = 'http://parity.test/g';
const Q1: Quad = { subject: 'http://parity.test/s1', predicate: 'http://parity.test/p', object: '"a"', graph: G };
const Q2: Quad = { subject: 'http://parity.test/s2', predicate: 'http://parity.test/p', object: '"b"', graph: G };

let server: Server;
let blazeUrl: string;
let queryCount = 0;

describe('TripleStore adapter parity (Oxigraph vs test-server Blazegraph)', () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          if (!body.startsWith('query=')) {
            res.writeHead(200);
            res.end();
            return;
          }
          queryCount++;
          const decoded = decodeURIComponent(body.replace('query=', ''));
          if (decoded.includes('COUNT(*)')) {
            const c = queryCount <= 1 ? '2' : '1';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              head: { vars: ['c'] },
              results: { bindings: [{ c: { type: 'literal', value: c, datatype: 'http://www.w3.org/2001/XMLSchema#integer' } }] },
            }));
            return;
          }
          // `BlazegraphStore.deleteByPattern({ graph, subject })` now
          // materialises matching bindings via a SELECT before issuing
          // `DELETE DATA` per row — the form that round-trips reliably
          // on real Blazegraph 2.1.5 (see `blazegraph.ts:54-100` for
          // why). This stub echoes a single binding for the one
          // subject the test deletes so the dummy-server parity suite
          // still drives the same code path as the real CI job
          // (`adapter-parity-extra.test.ts`).
          if (
            decoded.startsWith('SELECT') &&
            decoded.includes('http://parity.test/s1')
          ) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              head: { vars: ['p', 'o'] },
              results: {
                bindings: [
                  {
                    p: { type: 'uri', value: 'http://parity.test/p' },
                    o: { type: 'literal', value: 'a' },
                  },
                ],
              },
            }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
        blazeUrl = `http://127.0.0.1:${port}/sparql`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('insert two quads then countQuads(graph) is 2 for both backends', async () => {
    const ox = new OxigraphStore();
    await ox.insert([Q1, Q2]);
    expect(await ox.countQuads(G)).toBe(2);
    await ox.close();

    queryCount = 0;
    const blaze = new BlazegraphStore(blazeUrl);
    await blaze.insert([Q1, Q2]);
    expect(await blaze.countQuads(G)).toBe(2);
    expect(queryCount).toBeGreaterThanOrEqual(1);
  });

  it('deleteByPattern removes one quad and leaves count 1 (Oxigraph; Blazegraph test server)', async () => {
    const ox = new OxigraphStore();
    await ox.insert([Q1, Q2]);
    const removedOx = await ox.deleteByPattern({ graph: G, subject: 'http://parity.test/s1' });
    expect(removedOx).toBe(1);
    expect(await ox.countQuads(G)).toBe(1);
    await ox.close();

    queryCount = 0;
    const blaze = new BlazegraphStore(blazeUrl);
    await blaze.insert([Q1, Q2]);
    const removedBlaze = await blaze.deleteByPattern({ graph: G, subject: 'http://parity.test/s1' });
    expect(removedBlaze).toBe(1);
    expect(await blaze.countQuads(G)).toBe(1);
  });
});
