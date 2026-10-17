// Real daemon, local Hardhat chain and Oxigraph worker; no mocked queries.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';
import { runSharedMemoryMetadataRegression } from '../../../scripts/lib/shared-memory-metadata-regression.mjs';
let daemon: LiveDaemon;
beforeAll(async () => { daemon = await startLiveDaemon(); }, 120_000);
afterAll(async () => { await stopLiveDaemon(daemon); });
it('reads five contributors across registered subgraphs without child-CG attribution', async () => {
  const proof = await runSharedMemoryMetadataRegression({ base: daemon.base, token: daemon.token });
  expect(proof).toMatchObject({ contributors: 5, childExcluded: true, contentScopeUnchanged: true });
}, 240_000);
