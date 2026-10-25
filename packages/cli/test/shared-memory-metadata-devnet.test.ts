// Real daemon, local Hardhat chain and Oxigraph worker; no mocked queries.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';
import { runSharedMemoryMetadataRegression } from '../../../scripts/lib/shared-memory-metadata-regression.mjs';
let daemon: LiveDaemon;
beforeAll(async () => { daemon = await startLiveDaemon(); }, 120_000);
afterAll(async () => { await stopLiveDaemon(daemon); });
it('preserves content and attribution from five contributors in scoped queries, excluding child-CG content', async () => {
  const proof = await runSharedMemoryMetadataRegression({ base: daemon.base, token: daemon.token });
  expect(proof).toMatchObject({ contributors: 5, childExcluded: true, contentRows: 5,
    contentScopeUnchanged: true, sharedWorkingMemoryViewContentUnchanged: true });
}, 240_000);
