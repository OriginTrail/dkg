import { describe } from 'vitest';
import { registerPrimaryPersistenceBlazegraphCases } from '../../publisher/test/_helpers/primary-persistence-blazegraph.js';
import { createListContextGraphsCacheInvalidatingStore } from '../src/internal/context-graph-cache-invalidating-store.js';

const endpoint = process.env.BLAZEGRAPH_TEST_URL;

// test-disable-allow: D1 #3274 -- owner=Jurij89 lane=tornado-blazegraph expires=2026-11-14 Requires BLAZEGRAPH_TEST_URL; the required Blazegraph CI lane supplies it.
describe.skipIf(!endpoint)('agent cache wrapper compound primary persistence (live Blazegraph)', () => {
  registerPrimaryPersistenceBlazegraphCases({
    endpoint: endpoint!,
    decorateStore: store => createListContextGraphsCacheInvalidatingStore(store, () => {}),
    proofPrefix: 'agent',
  });
});
