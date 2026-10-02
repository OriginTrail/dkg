/** Child process for the SQLite-backed name-adoption crash regression. */
import { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { DKGAgent, type ContextGraphSubscriptionRecord, type ContextGraphSubscriptionStore } from '@origintrail-official/dkg-agent';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

const CLEARTEXT = 'acme-fun-facts';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CLEARTEXT)).toLowerCase();
const ON_CHAIN_ID = '33';
const EVENT_PREFIX = 'DKG_ADOPTION_CRASH_EVENT ';
const [mode, dataDir] = process.argv.slice(2);
if ((mode !== 'stage' && mode !== 'verify') || !dataDir) throw new Error('expected stage|verify and dataDir');

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify(event)}\n`);
}

const db = new DashboardDB({ dataDir });
let hashDeletePending = false;
let cleartextSaved = false;
let checkpointEmitted = false;
function rows() {
  return db.listContextGraphSubscriptions().map((row) => row.context_graph_id);
}
function checkpoint(): void {
  if (!hashDeletePending || !cleartextSaved || checkpointEmitted) return;
  checkpointEmitted = true;
  emit({ kind: 'crash-window', rows: rows() });
}

const subscriptionStore: ContextGraphSubscriptionStore = {
  loadAll: async () => db.listContextGraphSubscriptions().map((row) => ({
    id: row.context_graph_id,
    name: row.name ?? undefined,
    subscribed: row.subscribed === 1,
    synced: row.synced === 1,
    sharedMemorySynced: row.shared_memory_synced == null ? undefined : row.shared_memory_synced === 1,
    metaSynced: row.meta_synced == null ? undefined : row.meta_synced === 1,
    onChainId: row.on_chain_id ?? undefined,
    onChainHash: row.on_chain_hash ?? undefined,
    lastReconciledOrdinal: row.last_reconciled_ordinal ?? undefined,
    coreHosted: row.core_hosted == null ? undefined : row.core_hosted === 1,
    syncScoped: row.sync_scoped === 1,
  })),
  save: async (record: ContextGraphSubscriptionRecord) => {
    db.upsertContextGraphSubscription({
      context_graph_id: record.id,
      name: record.name ?? null,
      subscribed: record.subscribed ? 1 : 0,
      synced: record.synced ? 1 : 0,
      shared_memory_synced: record.sharedMemorySynced == null ? null : Number(record.sharedMemorySynced),
      meta_synced: record.metaSynced == null ? null : Number(record.metaSynced),
      on_chain_id: record.onChainId ?? null,
      on_chain_hash: record.onChainHash ?? null,
      last_reconciled_ordinal: record.lastReconciledOrdinal ?? null,
      core_hosted: record.coreHosted == null ? null : Number(record.coreHosted),
      sync_scoped: Number(record.syncScoped),
      updated_at: Date.now(),
    });
    if (record.id === CLEARTEXT) {
      cleartextSaved = true;
      checkpoint();
    }
  },
  delete: async (id: string) => {
    if (mode === 'stage' && id === NAME_HASH) {
      hashDeletePending = true;
      checkpoint();
      await new Promise<never>(() => {});
    }
    db.deleteContextGraphSubscription(id);
  },
};

const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: BigInt(ON_CHAIN_ID) });
await chain.createOnChainContextGraph({
  accessPolicy: 0,
  publishPolicy: 1,
  nameHash: NAME_HASH,
} as never);
const agent = await DKGAgent.create({
  name: 'CrashWindowNameAdoption',
  chainAdapter: chain,
  contextGraphSubscriptionStore: subscriptionStore,
  syncContextGraphs: [NAME_HASH],
});
// The subscription transition is independent of networking. Give its gossip
// and peer hooks inert implementations, as in context-graph-name-adoption.test.
const internals = agent as unknown as Record<string, any>;
internals.node = { peerId: '12D3KooWCrashWindowTestPeer', libp2p: { getPeers: () => [] } };
internals.gossip = {
  subscribe: () => {}, unsubscribe: () => {},
  onMessage: () => {}, offMessage: () => {}, publish: async () => {},
  subscribedTopics: [],
};

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('subscription persistence did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

if (mode === 'stage') {
  agent.stageOnChainContextGraphBindingFromNameHash(NAME_HASH, ON_CHAIN_ID);
  agent.onChainAccessPolicyCache.set(ON_CHAIN_ID, 0);
  agent.subscribeToContextGraph(NAME_HASH, { syncMode: 'always-on' });
  await waitFor(() => rows().includes(NAME_HASH));
  await agent.adoptVerifiedContextGraphCleartext(
    { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID },
    CLEARTEXT,
    'peer-protocol',
  );
  await waitFor(() => checkpointEmitted);
  setInterval(() => {}, 1_000);
} else {
  const before = rows();
  await agent.rehydrateContextGraphSubscriptions(null);
  await waitFor(() => rows().length === 1 && rows()[0] === CLEARTEXT);
  emit({
    kind: 'verified', before, after: rows(),
    active: [...agent.getSubscribedContextGraphs().keys()],
    alias: agent.resolveContextGraphIdAlias(NAME_HASH),
  });
  db.close();
}
