import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

/** Deterministic inference only; the daemon still owns HTTP, indexing and SQLite search. */
export async function startEmbeddingFixture() {
  const inputs: string[] = [];
  const apiKey = 'local-vector-regression-only';
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/chat/completions') {
        // Semantic extraction is independent of this vector isolation test.
        res.end(JSON.stringify({ choices: [{ message: { content: 'NONE' } }] }));
        return;
      }
      assert.equal(req.url, '/v1/embeddings');
      assert.equal(typeof body.input, 'string');
      assert.equal(body.dimensions, 1536);
      inputs.push(body.input);
      // Every owner's vector matches equally. Missing tenant filtering must
      // expose another owner's row, rather than hide behind semantic ranking.
      const embedding = Array.from({ length: body.dimensions }, (_, i) => i === 0 ? 1 : 0);
      res.end(JSON.stringify({ data: [{ embedding }] }));
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    config: { apiKey, baseURL: `http://127.0.0.1:${address.port}/v1` },
    inputs,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
