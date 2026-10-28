import { afterEach, vi } from 'vitest';
import { MockChainAdapter, sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { join } from 'node:path';
import { DKGAgent } from '../../src/dkg-agent.js';
import { checkpointFixture } from './public-checkpoint-fixture.js';
import { cg } from './bulk-graph-fixture.js';

afterEach(() => vi.unstubAllEnvs());

/** Real agents, loopback transport and stores; only chain authority is a local fixture. */
export async function checkpointAgentFixture() {
  vi.stubEnv('DKG_PUBLIC_SNAPSHOT_BULK', '1');
  const f = await checkpointFixture({}, 'rpc-only');
  const chain = new MockChainAdapter(f.initial.snapshot.chainId);
  Object.defineProperty(chain, 'deploymentId', { value: 'fixture' });
  for (let id = 1; id <= 14; id++) await chain.createOnChainContextGraph({
    accessPolicy: 0, publishPolicy: 1, ...(id === 14 ? { nameHash: f.initial.snapshot.nameHash } : {}),
  });
  const full = f.initial.snapshot;
  let snapshot = full;
  chain.readPublicGraphSnapshot = async () => sealPublicGraphSnapshot({ ...snapshot, observedAt: Date.now(), expiresAt: Date.now() + 120_000 });
  chain.getLatestMerkleRoot = async id => f.byId.get(id)!;
  chain.getMerkleRootCount = async () => 1n;
  chain.getKAContextGraphId = async () => 14n;
  const common = { name: 'checkpoint-sdk-fixture', chainAdapter: chain,
    listenHost: '127.0.0.1', listenPort: 0, enableMdns: false, randomSamplingUseWorkerThread: false,
    syncOnConnectEnabled: false, syncReconcilerEnabled: false, vmReconcilerEnabled: false };
  const core = await DKGAgent.create({ ...common, nodeRole: 'core', store: f.source });
  await core.start();
  core.setContextGraphSubscription(cg, { subscribed: true, synced: true, syncMode: 'on-demand',
    onChainId: '14', onChainHash: snapshot.nameHash }, { persist: false });
  const config = { ...common, nodeRole: 'edge' as const, dataDir: join(f.directory, 'fresh-edge'), bootstrapPeers: [...core.multiaddrs] };
  const sync = { contextGraphId: cg, onChainId: '14', mode: 'rpc-only' as const, trustedCorePeerIds: [core.peerId] };
  return { ...f, core, config, sync, setInventory(count: number) {
    snapshot = sealPublicGraphSnapshot({ ...full, assets: full.assets.slice(0, count) });
    f.initial.snapshot = snapshot;
    f.readFresh.mockImplementation(async () => ({ mode: 'rpc-only', sourceCore: null, snapshot }));
    return snapshot;
  } };
}
