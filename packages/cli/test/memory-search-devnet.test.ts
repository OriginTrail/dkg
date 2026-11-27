// Real daemon, local Hardhat chain, actual API routes and Oxigraph worker store.
// The text scenario is also runnable against a local devnet. Vector inference
// uses a deterministic loopback service; auth, routes and vector indexing are real.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';
import { startEmbeddingFixture } from './helpers/embedding-http-fixture.js';
import { runMemorySearchRegression, runMemoryVectorSearchRegression } from '../../../scripts/lib/memory-search-regression.mjs';
let daemon: LiveDaemon;
let embeddings: Awaited<ReturnType<typeof startEmbeddingFixture>>;
beforeAll(async () => {
  embeddings = await startEmbeddingFixture();
  daemon = await startLiveDaemon({ extraConfig: { llm: embeddings.config } });
}, 120_000);
afterAll(async () => {
  try { await stopLiveDaemon(daemon); }
  finally { await embeddings?.close(); }
});
it('keeps shared matches under a full WM result budget and preserves tenant isolation', async () => {
  const proof = await runMemorySearchRegression({ base: daemon.base, token: daemon.token });
  expect(proof.cases).toHaveLength(4);
  // Reuse the daemon's registry and store: a retry must not collide with the
  // previous scenario's agent names even though its graph ID was already unique.
  const repeated = await runMemorySearchRegression({ base: daemon.base, token: daemon.token });
  expect(repeated.cases).toHaveLength(4);
  expect(repeated.contextGraphId).not.toBe(proof.contextGraphId);
}, 120_000);

it('indexes tenant-owned vectors through real HTTP and isolates vector-only searches', async () => {
  const proof = await runMemoryVectorSearchRegression({ base: daemon.base, token: daemon.token });
  expect(proof.cases).toHaveLength(4);
  for (const markdown of proof.documents) expect(embeddings.inputs).toContain(markdown);
  expect(embeddings.inputs.filter(input => input === proof.query)).toHaveLength(3);
}, 120_000);
