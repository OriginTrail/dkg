import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { holdCopyBatch, readGraphBuilderRestartSuite } from './helpers/read-graph-builder-restart.js';

readGraphBuilderRestartSuite('oxigraph');

describe('the proxy behind the receipt kill point', () => {
  it('reports receipt only once the store has answered the named copy batch, and keeps that answer from the sender', async () => {
    const bodies: string[] = [];
    const store = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => { bodies.push(body); res.end('ok'); });
    });
    await new Promise<void>((resolve) => store.listen(0, '127.0.0.1', resolve));
    const proxy = await holdCopyBatch(`http://127.0.0.1:${(store.address() as AddressInfo).port}/namespace/kb/sparql`, 2);
    let received = false;
    void proxy.received.then(() => { received = true; });
    const post = (body: string, contentType = 'application/sparql-update; charset=utf-8') =>
      fetch(proxy.url, { method: 'POST', headers: { 'Content-Type': contentType }, body });
    try {
      expect((await post('INSERT DATA { <urn:s> <urn:p> <urn:o> }')).status).toBe(200);
      expect((await post('SELECT * WHERE { VALUES ?g { <urn:g0> } }', 'application/sparql-query')).status).toBe(200);
      expect((await post('INSERT { } WHERE { VALUES ?g { <urn:g1> } }')).status).toBe(200);
      // Copy batch 2 has not been sent: an update that is not a copy batch, a query and copy batch 1 report no receipt.
      expect(received).toBe(false);
      const answered = post('INSERT { } WHERE { VALUES ?g { <urn:g2> } }').then(() => 'answered', () => 'closed');
      expect(await proxy.received).toBe(200);
      expect(bodies).toHaveLength(4);
      expect(bodies.at(-1)).toContain('<urn:g2>');
      expect(await Promise.race([answered, new Promise((resolve) => setTimeout(resolve, 200, 'held'))])).toBe('held');
    } finally {
      await proxy.close();
      store.closeAllConnections();
      await new Promise((resolve) => store.close(resolve));
    }
  });
});
