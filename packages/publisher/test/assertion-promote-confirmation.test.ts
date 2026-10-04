// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair, assertionLifecycleUri, contextGraphMetaUri,
  createGraphKnowledgeAssetScope, createOperationContext, decodeWorkspacePublishRequest } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, StoreOperationTimeoutError } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { workspacePublicQuadsDigest } from '../src/workspace-snapshot-store.js';
import { resolveKnowledgeAssetWorkspaceHead } from '../src/workspace-resolution.js';
import { finalizeRootlessAssertionForTest } from './_helpers/rootless-lifecycle.js';
import { makeQuads } from './_helpers/workspace-snapshot-store.js';

const AUTHOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const CG = 'snapshot-cleanup';
const META = `did:dkg:context-graph:${CG}/_shared_memory_meta`;
const DKG = 'http://dkg.io/ontology/';
const quads = makeQuads(2, 'published');

/** Real store/publisher orchestration, independent of snapshot-file GC settings. */
async function fixture() {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({ store, chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
  return { store, publisher };
}
async function metaRows(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${META}> { ?s ?p ?o } }`);
  const rows = new Map<string, string[]>();
  for (const row of result.type === 'bindings' ? result.bindings : []) {
    rows.set(row['s']!, [...(rows.get(row['s']!) ?? []), `${row['p']} ${row['o']}`].sort());
  }
  return rows;
}

describe('assertion promote confirmation and recovery', () => {
  it('clears an inherited completion marker before rejecting malformed durable share identity', async () => {
    const f = await fixture(), name = 'malformed-promote-identity';
    await f.publisher.assertionCreate(CG, name, AUTHOR);
    await f.publisher.assertionWrite(CG, name, AUTHOR, quads);
    const sealed = await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store, contextGraphId: CG, name, agentAddress: AUTHOR });
    await f.publisher.markSwmShareComplete(CG, name, AUTHOR);
    await f.store.insert([{ graph: contextGraphMetaUri(CG), subject: assertionLifecycleUri(CG, AUTHOR, name),
      predicate: `${DKG}shareOperationId`, object: 'urn:invalid:non-literal-operation-id' }]);
    await expect(f.publisher.assertionPromote(CG, name, AUTHOR, { publisherPeerId: 'peer-publisher' }))
      .rejects.toMatchObject({ code: 'KA_SHARE_OPERATION_ID_CORRUPT' });
    expect(await f.publisher.hasSwmShareComplete(CG, name, AUTHOR)).toBe(false);
    expect(await f.store.countQuads(sealed.sharedGraphUri)).toBe(0);
    expect(await f.store.countQuads(sealed.graphUri)).toBe(sealed.publicQuads.length);
  });

  it('lets prior publication cleanup finish while the next promote awaits curator confirmation', async () => {
    const f = await fixture(), name = 'held-curator';
    const payload = [{ subject: 'urn:note:first', predicate: 'http://schema.org/value', object: '"first"', graph: '' }];
    await f.publisher.assertionCreate(CG, name, AUTHOR);
    await f.publisher.assertionWrite(CG, name, AUTHOR, payload);
    const first = await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store, contextGraphId: CG, name, agentAddress: AUTHOR });
    const firstShare = await f.publisher.assertionPromote(CG, name, AUTHOR, { publisherPeerId: 'peer-publisher' });
    await f.publisher.assertionPullFrom(CG, name, AUTHOR, 'swm');
    await f.publisher.assertionWrite(CG, name, AUTHOR, [{ subject: 'urn:note:new', predicate: 'http://schema.org/value', object: '"new"', graph: '' }]);
    await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store, contextGraphId: CG, name, agentAddress: AUTHOR });
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const promoting = f.publisher.assertionPromote(CG, name, AUTHOR, { publisherPeerId: 'peer-publisher',
      confirmBeforeCommit: async () => { entered(); await held; return { applied: true }; } });
    await reached;
    const asset = createGraphKnowledgeAssetScope(first.kaUal, 1);
    let cleared = false;
    const clearing = f.publisher.clearPublishedKnowledgeAssetSwm(CG,
      { kind: 'named-lifecycle', identity: { agentAddress: asset.agentAddress, kaNumber: BigInt(asset.kaNumber) } },
      undefined, createOperationContext('publish'), first.kaUal, 1,
      { publicQuadsDigest: workspacePublicQuadsDigest(payload), privateTripleCount: 0 }, firstShare.shareOperationId)
      .then(() => { cleared = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(cleared).toBe(true);
      expect(await f.store.countQuads(first.sharedGraphUri)).toBe(0);
    } finally { release(); await Promise.all([promoting, clearing]); }
    expect(await f.store.countQuads(first.sharedGraphUri)).toBe(2);
  });

  it.each(['operation', 'intent', 'layer'])('refuses %s lifecycle state changed during curator confirmation', async changed => {
    const f = await fixture(), name = `changed-lifecycle-${changed}`;
    await f.publisher.assertionCreate(CG, name, AUTHOR);
    await f.publisher.assertionWrite(CG, name, AUTHOR, quads);
    const sealed = await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store, contextGraphId: CG, name, agentAddress: AUTHOR });
    const predicate = `${DKG}${changed === 'operation' ? 'shareOperationId' : changed === 'intent' ? 'promoteOperationIntent' : 'memoryLayer'}`;
    await expect(f.publisher.assertionPromote(CG, name, AUTHOR, { publisherPeerId: 'peer-publisher',
      confirmBeforeCommit: async () => {
        await f.store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: assertionLifecycleUri(CG, AUTHOR, name), predicate });
        await f.store.insert([{ graph: contextGraphMetaUri(CG), subject: assertionLifecycleUri(CG, AUTHOR, name), predicate,
          object: JSON.stringify(changed === 'layer' ? 'VM' : 'different-operation-state') }]);
        return { applied: true };
      } })).rejects.toMatchObject({ code: changed === 'layer' ? 'KA_LIFECYCLE_STATE_CHANGED' : 'KA_PROMOTE_OPERATION_INTENT_CONFLICT' });
    expect(await f.store.countQuads(sealed.sharedGraphUri)).toBe(0);
    expect(await f.store.countQuads(sealed.graphUri)).toBe(sealed.publicQuads.length);
    expect(await f.publisher.hasSwmShareComplete(CG, name, AUTHOR)).toBe(false);
  });

  it.each([1, 2])('refuses an independent version %i head received during curator confirmation', async incomingVersion => {
    const f = await fixture(), name = `incoming-during-confirm-${incomingVersion}`;
    await f.publisher.assertionCreate(CG, name, AUTHOR);
    await f.publisher.assertionWrite(CG, name, AUTHOR, quads);
    const sealed = await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store, contextGraphId: CG, name, agentAddress: AUTHOR });
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const outcome = f.publisher.assertionPromote(CG, name, AUTHOR, { publisherPeerId: 'peer-publisher',
      confirmBeforeCommit: async () => { entered(); await held; return { applied: true }; } })
      .then(result => ({ result }), error => ({ error }));
    await reached;
    // Version 1 deliberately has identical content but a distinct share identity.
    const incoming = incomingVersion === 1 ? sealed.publicQuads : makeQuads(3, 'incoming-v2');
    let staged = false;
    const staging = f.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId: CG, kaUal: sealed.kaUal, assertionVersion: incomingVersion,
      shareOperationId: 'independent-incoming', quads: incoming, privateTripleCount: 0,
      publisherPeerId: 'peer-publisher', accessPolicy: 'public',
    }).then(() => { staged = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(staged).toBe(true);
    } finally { release(); await staging; }
    expect(await outcome).toMatchObject({ error: { code: 'KA_PROMOTE_SWM_HEAD_CHANGED' } });
    expect(await f.store.countQuads(sealed.sharedGraphUri)).toBe(incoming.length);
    expect((await metaRows(f)).get(`${sealed.kaUal}#dkg-swm-head`)).toContain(`${DKG}shareOperationId "independent-incoming"`);
    expect(await f.store.countQuads(sealed.graphUri)).toBe(sealed.publicQuads.length);
    expect(await f.publisher.hasSwmShareComplete(CG, name, AUTHOR)).toBe(false);
  });

  it.each([false, true])('accepts its own curator-applied head after reacquiring the lock (private: %s)', async withPrivate => {
    const f = await fixture(), name = `curator-applied-${withPrivate}`;
    await f.publisher.assertionCreate(CG, name, AUTHOR);
    await f.publisher.assertionWrite(CG, name, AUTHOR, quads);
    if (withPrivate) await f.publisher.assertionWritePrivate(CG, name, AUTHOR, makeQuads(1, 'private'));
    const sealed = await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store, contextGraphId: CG, name, agentAddress: AUTHOR });
    const promoted = await f.publisher.assertionPromote(CG, name, AUTHOR, { publisherPeerId: 'peer-publisher',
      confirmBeforeCommit: async message => {
        const request = decodeWorkspacePublishRequest(message);
        await f.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({ contextGraphId: CG, kaUal: sealed.kaUal,
          assertionVersion: 1, shareOperationId: request.shareOperationId, quads: sealed.publicQuads,
          privateMerkleRoot: request.privateMerkleRoot, privateTripleCount: sealed.privateQuads.length,
          publisherPeerId: 'peer-publisher', accessPolicy: withPrivate ? 'ownerOnly' : 'public' });
        return { applied: true };
      } });
    expect(promoted.promotedCount).toBe(sealed.publicQuads.length + sealed.privateQuads.length);
    expect(await f.publisher.hasSwmShareComplete(CG, name, AUTHOR)).toBe(true);
    expect((await metaRows(f)).get(`${sealed.kaUal}#dkg-swm-head`)).toContain(`${DKG}shareOperationId "${promoted.shareOperationId}"`);
  });

  it('does not restore an empty-WM recovery source retired during curator confirmation', async () => {
    const f = await fixture(), name = 'recovery-retired-during-confirm';
    await f.publisher.assertionCreate(CG, name, AUTHOR);
    await f.publisher.assertionWrite(CG, name, AUTHOR, quads);
    const sealed = await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store, contextGraphId: CG, name, agentAddress: AUTHOR });
    const promoted = await f.publisher.assertionPromote(CG, name, AUTHOR, { publisherPeerId: 'peer-publisher', confirmBeforeCommit: async () => ({ applied: true }) });
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const outcome = f.publisher.assertionPromote(CG, name, AUTHOR, { publisherPeerId: 'peer-publisher',
      confirmBeforeCommit: async () => { entered(); await held; return { applied: true }; } })
      .then(result => ({ result }), error => ({ error }));
    await reached;
    const asset = createGraphKnowledgeAssetScope(sealed.kaUal, 1);
    const clearing = f.publisher.clearPublishedKnowledgeAssetSwm(CG,
      { kind: 'named-lifecycle', identity: { agentAddress: asset.agentAddress, kaNumber: BigInt(asset.kaNumber) } },
      undefined, createOperationContext('publish'), sealed.kaUal, 1,
      { publicQuadsDigest: workspacePublicQuadsDigest(sealed.publicQuads), privateTripleCount: 0 }, promoted.shareOperationId);
    try {
      await Promise.race([clearing, new Promise((_, reject) => setTimeout(() => reject(new Error('cleanup blocked by confirmation')), 100))]);
    } finally { release(); await clearing; }
    expect(await outcome).toMatchObject({ error: { message: expect.stringContaining('triple-count mismatch') } });
    expect(await f.store.countQuads(sealed.sharedGraphUri)).toBe(0);
    expect(await f.publisher.hasSwmShareComplete(CG, name, AUTHOR)).toBe(false);
  });

  it('serializes assertionPromote replacement and its head with confirmed-publication cleanup', async () => {
    const f = await fixture();
    const NAME = 'promote-overlap';
    const payload = [{ subject: 'urn:note:first', predicate: 'http://schema.org/value', object: '"first"', graph: '' }];
    await f.publisher.assertionCreate(CG, NAME, AUTHOR);
    await f.publisher.assertionWrite(CG, NAME, AUTHOR, payload);
    const first = await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR, assertionVersion: 1 });
    await f.publisher.assertionPromote(CG, NAME, AUTHOR, { publisherPeerId: 'peer-publisher' });
    await f.publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm');
    await f.publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:note:new', predicate: 'http://schema.org/value', object: '"new"', graph: '' }]);
    await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR, assertionVersion: 1 });
    const replace = f.store.replaceGraph.bind(f.store);
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.store, 'replaceGraph').mockImplementationOnce(async (graph, quads) => {
      await replace(graph, quads);
      entered();
      await held;
    });
    const promoting = f.publisher.assertionPromote(CG, NAME, AUTHOR, { publisherPeerId: 'peer-publisher' });
    await reached;
    const drop = vi.spyOn(f.store, 'dropGraph');
    const asset = createGraphKnowledgeAssetScope(first.kaUal, 1);
    const clearing = f.publisher.clearPublishedKnowledgeAssetSwm(CG,
      { kind: 'named-lifecycle', identity: { agentAddress: asset.agentAddress, kaNumber: BigInt(asset.kaNumber) } },
      undefined, createOperationContext('publish'), first.kaUal, 1,
      { publicQuadsDigest: workspacePublicQuadsDigest(payload), privateTripleCount: 0 });
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(drop).not.toHaveBeenCalled();
    } finally { release(); await Promise.all([promoting, clearing]); }
    const promoted = await promoting;
    await clearing;
    expect(await f.store.countQuads(first.sharedGraphUri)).toBe(2);
    expect((await metaRows(f)).get(`${first.kaUal}#dkg-swm-head`)).toEqual(expect.arrayContaining([`${DKG}shareOperationId "${promoted.shareOperationId}"`]));
  });

  it('repairs its own missing operation after a not-started metadata insertion on replay', async () => {
    const f = await fixture(), name = 'interrupted-same-operation';
    await f.publisher.assertionCreate(CG, name, AUTHOR);
    await f.publisher.assertionWrite(CG, name, AUTHOR, quads);
    const sealed = await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store,
      contextGraphId: CG, name, agentAddress: AUTHOR });
    const first = await f.publisher.assertionPromote(CG, name, AUTHOR, { publisherPeerId: 'peer-publisher' });
    const subject = `urn:dkg:share:${CG}:${first.shareOperationId}`;
    const insert = f.store.insert.bind(f.store);
    let failed = false;
    const failure = vi.spyOn(f.store, 'insert').mockImplementation(async rows => {
      if (!failed && rows.some(row => row.subject === subject && row.predicate === `${DKG}publicQuadsDigest`)) {
        failed = true;
        expect(await f.store.query(`ASK { GRAPH <${META}> { <${subject}> ?p ?o } }`))
          .toEqual({ type: 'boolean', value: false });
        throw new StoreOperationTimeoutError({ backend: 'managed-oxigraph', operation: 'insert', outcome: 'not_started' });
      }
      await insert(rows);
    });
    await expect(f.publisher.assertionPromote(CG, name, AUTHOR, { publisherPeerId: 'peer-publisher' }))
      .rejects.toMatchObject({ code: 'STORE_OPERATION_TIMEOUT', outcome: 'not_started' });
    failure.mockRestore();
    expect(failed).toBe(true);
    expect(await f.publisher.hasSwmShareComplete(CG, name, AUTHOR)).toBe(false);
    expect(await f.store.countQuads(sealed.sharedGraphUri)).toBe(quads.length);
    const recovered = await f.publisher.assertionPromote(CG, name, AUTHOR, { publisherPeerId: 'peer-publisher' });
    expect(recovered.shareOperationId).toBe(first.shareOperationId);
    expect(await f.publisher.hasSwmShareComplete(CG, name, AUTHOR)).toBe(true);
    expect(await resolveKnowledgeAssetWorkspaceHead({ store: f.store, graphManager: new GraphManager(f.store),
      contextGraphId: CG, kaUal: sealed.kaUal })).toMatchObject({ shareOperationId: first.shareOperationId });
  });
  it.each(['newer-version', 'unrelated-alias', 'partial-operation'])('does not repair a missing operation with %s evidence', async changed => {
    const f = await fixture(), name = `unsafe-recovery-${changed}`;
    await f.publisher.assertionCreate(CG, name, AUTHOR);
    await f.publisher.assertionWrite(CG, name, AUTHOR, quads);
    const sealed = await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store,
      contextGraphId: CG, name, agentAddress: AUTHOR });
    const first = await f.publisher.assertionPromote(CG, name, AUTHOR, { publisherPeerId: 'peer-publisher' });
    const operation = `urn:dkg:share:${CG}:${first.shareOperationId}`;
    await f.store.deleteByPattern({ graph: META, subject: operation });
    if (changed === 'partial-operation') {
      await f.store.insert([{ graph: META, subject: operation, predicate: `${DKG}shareOperationId`, object: JSON.stringify(first.shareOperationId) }]);
    } else {
      const predicate = `${DKG}${changed === 'newer-version' ? 'assertionVersion' : 'shareOperationId'}`;
      const subject = `${sealed.kaUal}#dkg-swm-head`;
      await f.store.deleteByPattern({ graph: META, subject, predicate });
      await f.store.insert([{ graph: META, subject, predicate,
        object: changed === 'newer-version' ? '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' : '"unrelated-operation"' }]);
    }
    const before = await metaRows(f);
    await expect(f.publisher.assertionPromote(CG, name, AUTHOR, { publisherPeerId: 'peer-publisher' }))
      .rejects.toMatchObject({ code: 'KA_WORKSPACE_HEAD_CORRUPT' });
    expect(await metaRows(f)).toEqual(before);
    expect(await f.store.countQuads(sealed.sharedGraphUri)).toBe(quads.length);
    expect(await f.publisher.hasSwmShareComplete(CG, name, AUTHOR)).toBe(false);
  });
});
