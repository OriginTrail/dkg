// SPDX-License-Identifier: Apache-2.0
// Run the emitted agent and native stores in a disposable process. Intentional
// exit happens at an actual durability boundary, without stop()/close() flushing.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKG_ONTOLOGY, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../../dist/index.js';
import { runCuratorMetaRefreshFromPeer } from '../../dist/curator-meta-refresh.js';
import { buildAuthoritativePublicMetaQuads } from '../../dist/context-graph-public-meta-proof.js';

const [dir, boundary] = process.argv.slice(2);
const cg = 'curator-durable-crash';
const hash = ethers.keccak256(ethers.toUtf8Bytes(cg));
const root = contextGraphDataGraphUri(cg);
const meta = contextGraphMetaGraphUri(cg);
const db = new DatabaseSync(join(dir, 'subscription.sqlite'));
db.exec('PRAGMA synchronous=FULL; CREATE TABLE subscription (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
const write = db.prepare('INSERT OR REPLACE INTO subscription VALUES (?, ?)');
const rows = () => db.prepare('SELECT body FROM subscription').all().map(({ body }) => JSON.parse(body));
let armed = false;
const subscriptions = {
  loadAll: async () => rows(),
  load: async (id) => rows().find((row) => row.id === id) ?? null,
  save: async (row) => {
    write.run(row.id, JSON.stringify(row));
    if (armed && ((boundary === 'false-save' && row.metaSynced === false)
      || (boundary === 'ready-save' && row.metaSynced === true))) process.exit(73);
  },
  delete: async (id) => db.prepare('DELETE FROM subscription WHERE id=?').run(id),
};
const chain = new MockChainAdapter();
await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
const store = new OxigraphStore(join(dir, 'rdf.nq'));
const registration = [
  { subject: root, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: '"1"', graph: meta },
  { subject: root, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`, object: `"${hash}"`, graph: meta },
];
await store.insert([...buildAuthoritativePublicMetaQuads(cg), ...registration,
  { subject: root, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"old"', graph: meta }]);
await store.flush();
const agent = await DKGAgent.create({ name: 'MetadataCrash', chainAdapter: chain, store,
  contextGraphSubscriptionStore: subscriptions, contextGraphSubscriptionRehydrationEnabled: false,
  rfc64CatalogActivation: { enabled: false } });
agent.node = { peerId: 'curator-crash-peer', libp2p: { getConnections: () => [{ remotePeer: { toString: () => 'curator' } }], getPeers: () => [] } };
agent.scheduleRfc64CatalogResponsibilityReconciliationV1 = () => false;
agent.setContextGraphSubscription(cg, { subscribed: true, synced: true, syncMode: 'always-on',
  metaSynced: true, onChainId: '1', onChainHash: hash }, { persist: false });
await subscriptions.save({ id: cg, subscribed: true, synced: true, metaSynced: true,
  onChainId: '1', onChainHash: hash, syncScoped: false });
agent.fetchSyncPages = async () => ({ quads: [...buildAuthoritativePublicMetaQuads(cg), ...registration,
  { subject: root, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"new"', graph: meta }],
  checkpointKey: 'snapshot', resumedFromOffset: 0, completed: true });
const update = store.update.bind(store);
store.update = async (query, options) => {
  await update(query, options);
  if (armed && boundary === 'rdf-commit' && options?.source === 'agent.metaRefresh.replace') process.exit(73);
};
const flush = store.flush.bind(store);
store.flush = async (options) => {
  await flush();
  if (armed && boundary === 'rdf-flush' && options?.source === 'agent.metadataReadiness.flush') process.exit(73);
};
armed = true;
const result = await runCuratorMetaRefreshFromPeer(agent, cg, 'curator', { force: true });
throw new Error(`Crash boundary ${boundary} was not reached: ${result}`);
