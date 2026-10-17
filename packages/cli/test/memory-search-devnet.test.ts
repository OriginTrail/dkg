// Real daemon, local Hardhat chain, actual API routes and Oxigraph worker store.
// The same scenario is independently runnable against a local devnet.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';
import { runMemorySearchRegression } from '../../../scripts/lib/memory-search-regression.mjs';
let daemon: LiveDaemon;
beforeAll(async () => { daemon = await startLiveDaemon(); }, 120_000);
afterAll(async () => { await stopLiveDaemon(daemon); });
it('keeps shared matches under a full WM result budget and preserves tenant isolation', async () => {
  const proof = await runMemorySearchRegression({ base: daemon.base, token: daemon.token });
  expect(proof.cases).toHaveLength(4);
}, 120_000);
