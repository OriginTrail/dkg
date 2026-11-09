import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { HARDHAT_KEYS, makeAdapterConfig, takeSnapshot, revertSnapshot } from '../../chain/test/evm-test-context.js';
import * as execution from '../src/exact-recovery-execution.js';
import { graph, publicSnapshotFixture } from './helpers/public-snapshot-local-fixture.js';

let before: string;
let fixture: Awaited<ReturnType<typeof publicSnapshotFixture>> | undefined;
beforeEach(async () => {
  vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
  vi.stubEnv('DKG_PUBLIC_SNAPSHOT_BULK', '0');
  before = await takeSnapshot();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture?.dispose(); fixture = undefined;
  await revertSnapshot(before); vi.unstubAllEnvs();
});

it('recovers disjoint selections from two live cores with real verification and atomic writes', async () => {
  fixture = await publicSnapshotFixture('exact');
  const { make, adapter, source, rpcUrl, hubAddress, onChainId } = fixture;
  const first = await make('FirstCore', 'core', adapter, source);
  const second = await make('SecondCore', 'core', new EVMChainAdapter(
    makeAdapterConfig(rpcUrl, hubAddress, HARDHAT_KEYS.REC1_OP)), source);
  const target = new OxigraphStore();
  const edge = await make('ParallelEdge', 'edge', new EVMChainAdapter(
    makeAdapterConfig(rpcUrl, hubAddress, HARDHAT_KEYS.REC2_OP)), target);
  for (const core of [first, second]) await edge.connectTo(core.multiaddrs.find(
    a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!);
  const recover = execution.runExactRecovery;
  let active = 0, peak = 0;
  const suppliers = new Set<string>();
  vi.spyOn(execution, 'runExactRecovery').mockImplementation(async request => {
    active++; peak = Math.max(peak, active); suppliers.add(request.remotePeerId);
    try { return await recover(request); } finally { active--; }
  });
  const result = await edge.syncPublicGraphSnapshot({ contextGraphId: graph, onChainId,
    trustedCorePeerIds: [first.peerId, second.peerId], transport: 'exact' });
  expect(result).toMatchObject({ assets: 12, committed: 12, current: true, completeAsOfSnapshot: true });
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(suppliers).toEqual(new Set([first.peerId, second.peerId]));
  const rows = await target.query('SELECT ?name WHERE {GRAPH ?g {?s <http://schema.org/name> ?name}}');
  expect(rows.type === 'bindings' && rows.bindings.length).toBe(12);
  const privateRows = await target.query('SELECT ?value WHERE {GRAPH ?g {?s <urn:secret> ?value}}');
  expect(privateRows.type === 'bindings' && privateRows.bindings.length).toBe(0);
});
