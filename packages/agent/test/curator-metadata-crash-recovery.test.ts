// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore, ChangelogStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKG_ONTOLOGY, encodePublishRequest, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { runCuratorMetaRefreshFromPeer } from '../src/curator-meta-refresh.js';
import { buildAuthoritativePublicMetaQuads } from '../src/context-graph-public-meta-proof.js';
import type { GossipPublishHandler } from '../src/gossip-publish-handler.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import type { ContextGraphSub, ContextGraphSubInput, ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';

const CG = 'curator-durable-crash';
const HASH = ethers.keccak256(ethers.toUtf8Bytes(CG));
const ROOT = contextGraphDataGraphUri(CG);
const META = contextGraphMetaGraphUri(CG);
const dirs: string[] = [];
const agents: DKGAgent[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const agent of agents.splice(0)) await agent.stop();
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
interface State {
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  setContextGraphSubscription(id: string, sub: ContextGraphSubInput, options?: { persist?: boolean }): ContextGraphSub;
  getOrCreateGossipPublishHandler(): GossipPublishHandler;
  fetchSyncPages(): Promise<SyncPageResult>;
  config: { contextGraphSubscriptionStore: { save(row: ContextGraphSubscriptionRecord): Promise<void> } };
}

async function reopen(dir: string, decorate = false) {
  const db = new DatabaseSync(join(dir, 'subscription.sqlite')); databases.push(db);
  const rows = () => db.prepare('SELECT body FROM subscription').all().map((row) => JSON.parse(String(row['body'])) as ContextGraphSubscriptionRecord);
  const chain = new MockChainAdapter();
  await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: HASH });
  const store = new OxigraphStore(join(dir, 'rdf.nq'));
  const outer = decorate ? new ChangelogStore(store) : store;
  const agent = await DKGAgent.create({ name: 'MetadataReopen', chainAdapter: chain, store: outer,
    contextGraphSubscriptionRehydrationEnabled: false, rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionStore: { loadAll: async () => rows(), save: async (row) => {
      db.prepare('INSERT OR REPLACE INTO subscription VALUES (?, ?)').run(row.id, JSON.stringify(row));
    }, delete: async (id) => { db.prepare('DELETE FROM subscription WHERE id=?').run(id); } } });
  agents.push(agent);
  (agent as unknown as { node: unknown }).node = { peerId: 'reopened', libp2p: { getPeers: () => [], getConnections: () => [{ remotePeer: { toString: () => 'curator' } }] } };
  const saved = rows()[0]!;
  (agent as unknown as State).setContextGraphSubscription(CG, { ...saved, subscribed: saved.subscribed,
    synced: saved.synced, syncMode: 'always-on' }, { persist: false });
  return { agent, saved, store, chain, outer, db, state: agent as unknown as State };
}

const tuple: Quad[] = [
  { subject: ROOT, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: '"1"', graph: META },
  { subject: ROOT, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`, object: `"${HASH}"`, graph: META },
];
async function nativeFixture(decorate = false) {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-curator-native-')); dirs.push(dir);
  const database = new DatabaseSync(join(dir, 'subscription.sqlite'));
  database.exec('PRAGMA synchronous=FULL; CREATE TABLE subscription (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  database.prepare('INSERT INTO subscription VALUES (?, ?)').run(CG, JSON.stringify({ id: CG,
    subscribed: true, synced: true, metaSynced: true, onChainId: '1', onChainHash: HASH, syncScoped: false }));
  database.close();
  const store = new OxigraphStore(join(dir, 'rdf.nq'));
  await store.insert([...buildAuthoritativePublicMetaQuads(CG), ...tuple]); await store.close();
  const f = await reopen(dir, decorate);
  vi.spyOn(f.state, 'fetchSyncPages').mockResolvedValue({ quads: [...buildAuthoritativePublicMetaQuads(CG), ...tuple],
    checkpointKey: 'curator-native', completed: true, resumedFromOffset: 0 } as SyncPageResult);
  const refresh = () => runCuratorMetaRefreshFromPeer(f.agent, CG, 'curator', { force: true });
  const persisted = () => JSON.parse(String(f.db.prepare('SELECT body FROM subscription WHERE id=?').get(CG)!['body'])) as ContextGraphSubscriptionRecord;
  return { ...f, dir, refresh, persisted };
}

describe('curator metadata crash consistency through actual agent and native durable stores', () => {
  it.each(['false-save', 'rdf-commit', 'rdf-flush', 'ready-save'])('reopens after abrupt exit at %s', async (boundary) => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-curator-crash-')); dirs.push(dir);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./_helpers/curator-metadata-crash-child.mjs', import.meta.url)), dir, boundary],
      { encoding: 'utf8', timeout: 20_000 });
    expect(child.error, child.stderr + child.stdout).toBeUndefined();
    expect(child.status, child.stderr + child.stdout).toBe(73);
    const { agent, saved, store } = await reopen(dir);
    const complete = boundary === 'ready-save';
    expect(saved.metaSynced).toBe(complete);
    await expect(agent.hasReadyMetadataRegistration(CG)).resolves.toBe(complete);
    await expect(agent.hasConfirmedMetaState(CG)).resolves.toBe(complete);
    await expect(agent.authorizeSyncRequest({ contextGraphId: CG, offset: 0, limit: 10, includeSharedMemory: false }, 'visitor')).resolves.toBe(complete);
    // Refresh cannot turn a durable false row into an unrelated tuple. The
    // aligned post-flush row is safely promotable; pre-flush has the old snapshot.
    if (complete || boundary === 'rdf-flush') {
      expect(await store.query(`ASK { GRAPH <${META}> { <${ROOT}> <${DKG_ONTOLOGY.SCHEMA_NAME}> "new" } }`)).toEqual({ type: 'boolean', value: true });
    }
  });
  it.each(['rdf-newer', 'subscription-newer'])('denies read, public sync and allowlisted gossip after %s mismatch', async (direction) => {
    const f = await nativeFixture();
    if (direction === 'rdf-newer') await f.store.update(`DELETE { GRAPH <${META}> { <${ROOT}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> ?old } }
      INSERT { GRAPH <${META}> { <${ROOT}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> "2" } }
      WHERE { GRAPH <${META}> { <${ROOT}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> ?old } }`);
    else f.state.setContextGraphSubscription(CG, { ...f.state.subscribedContextGraphs.get(CG)!, onChainId: '2' }, { persist: false });
    await f.store.insert([{ subject: ROOT, predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER, object: '"visitor"', graph: META }]);
    await expect(f.agent.canReadContextGraph(CG)).resolves.toBe(false);
    await expect(f.agent.hasConfirmedMetaState(CG)).resolves.toBe(false);
    await expect(f.agent.authorizeSyncRequest({ contextGraphId: CG, offset: 0, limit: 10, includeSharedMemory: false }, 'visitor')).resolves.toBe(false);
    const message = encodePublishRequest({ ual: '', contextGraphId: CG, kas: [],
      nquads: new TextEncoder().encode('<urn:gossip-test> <urn:p> "blocked" .'), publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x1111111111111111111111111111111111111111', startKAId: 0, endKAId: 0,
      chainId: 'mock:31337', publisherSignatureR: new Uint8Array(0), publisherSignatureVs: new Uint8Array(0) });
    await f.state.getOrCreateGossipPublishHandler().handlePublishMessage(message, CG, undefined, 'visitor');
    expect(await f.store.query('ASK { GRAPH ?g { <urn:gossip-test> ?p ?o } }')).toEqual({ type: 'boolean', value: false });
    await f.agent.refreshMetaSyncedFlags([CG]);
    await expect(f.agent.hasReadyMetadataRegistration(CG)).resolves.toBe(false);
  });

  it('refuses an uncertified atomic backend before staging or durable state mutation', async () => {
    const f = await nativeFixture();
    Object.defineProperty(f.store, 'atomicUpdateCertified', { value: false });
    const insert = vi.spyOn(f.store, 'insert');
    const before = await f.store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${META}> { ?s ?p ?o } }`);
    await expect(f.refresh()).resolves.toBe(false);
    expect(insert).not.toHaveBeenCalled();
    expect(f.persisted().metaSynced).toBe(true);
    expect(await f.store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${META}> { ?s ?p ?o } }`)).toEqual(before);
  });

  it('withholds and selectively cleans an actual decorated inner commit followed by an outer error', async () => {
    const f = await nativeFixture(true);
    const retained: Quad[] = [
      { subject: ROOT, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT, object: '"revoked"', graph: META },
      { subject: `${ROOT}/knowledge-asset/4`, predicate: DKG_ONTOLOGY.RDF_TYPE, object: 'urn:KA', graph: META },
    ];
    await f.store.insert(retained);
    const update = f.outer.update!.bind(f.outer);
    vi.spyOn(f.outer, 'update').mockImplementation(async (query, options) => {
      await update(query, options);
      if (options?.source === 'agent.metaRefresh.replace') throw new Error('post-commit changelog failure');
    });
    await expect(f.refresh()).resolves.toBe(false);
    expect(f.persisted().metaSynced).toBe(false);
    await expect(f.agent.hasReadyMetadataRegistration(CG)).resolves.toBe(false);
    const rows = await f.store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${META}> { ?s ?p ?o } }`);
    expect(rows.type).toBe('bindings');
    if (rows.type !== 'bindings') throw new Error('Metadata query did not return bindings');
    expect(rows.bindings).toHaveLength(retained.length);
    expect(rows.bindings).toEqual(expect.arrayContaining(retained.map((q) => ({ s: q.subject, p: q.predicate, o: q.object }))));
    // The same outer owner can retry successfully; no snapshot restoration
    // overwrites the independent rows written beside the curator projection.
    vi.restoreAllMocks();
    vi.spyOn(f.state, 'fetchSyncPages').mockResolvedValue({ quads: [...buildAuthoritativePublicMetaQuads(CG), ...tuple],
      checkpointKey: 'curator-native-retry', completed: true, resumedFromOffset: 0 } as SyncPageResult);
    await expect(f.refresh()).resolves.toBe(true);
    await expect(f.agent.hasReadyMetadataRegistration(CG)).resolves.toBe(true);
    expect(f.persisted().metaSynced).toBe(true);
  });

  it.each(['false-save', 'rdf-flush', 'ready-save'])('keeps readiness withheld after a %s failure and reopens on retry', async (boundary) => {
    const f = await nativeFixture();
    const save = f.state.config.contextGraphSubscriptionStore.save.bind(f.state.config.contextGraphSubscriptionStore);
    vi.spyOn(f.state.config.contextGraphSubscriptionStore, 'save').mockImplementation(async (row) => {
      if ((boundary === 'false-save' && row.metaSynced === false) || (boundary === 'ready-save' && row.metaSynced === true)) {
        throw new Error('SQLite commit refused');
      }
      await save(row);
    });
    if (boundary === 'rdf-flush') vi.spyOn(f.agent.store, 'flush').mockRejectedValueOnce(new Error('fsync refused'));
    await expect(f.refresh()).resolves.toBe(false);
    await expect(f.agent.hasReadyMetadataRegistration(CG)).resolves.toBe(false);
    expect(f.persisted().metaSynced).toBe(boundary === 'false-save');
    vi.restoreAllMocks();
    vi.spyOn(f.state, 'fetchSyncPages').mockResolvedValue({ quads: [...buildAuthoritativePublicMetaQuads(CG), ...tuple],
      checkpointKey: 'curator-native-retry', completed: true, resumedFromOffset: 0 } as SyncPageResult);
    await expect(f.refresh()).resolves.toBe(true);
    await expect(f.agent.hasReadyMetadataRegistration(CG)).resolves.toBe(true);
  });

});
