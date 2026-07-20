import { describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  TypedEventBus,
  createOperationContext,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import {
  DKGPublisher,
  computePrivateRootV10,
  type PublisherWalShadowMutationV1,
  type PublisherWalShadowObjectReceiptV1,
  type PublisherWalShadowWriter,
} from '../src/index.js';
import { finalizeRootlessAssertionForTest } from './_helpers/rootless-lifecycle.js';

const PRIVATE_KEY = `0x${'42'.repeat(32)}`;
const CONTEXT_GRAPH = 'wal-shadow-cg';
const ROOT_A = 'urn:wal:root:a';
const ROOT_B = 'urn:wal:root:b';
const WAL_AUTHOR = new ethers.Wallet(PRIVATE_KEY).address;
const WAL_UAL = `did:dkg:base:8453/${WAL_AUTHOR}/41`;

function quad(subject: string, object: string): Quad {
  return { subject, predicate: 'https://schema.org/name', object, graph: '' };
}

function receipt(resource: string, index: number): PublisherWalShadowObjectReceiptV1 {
  const bytes = index.toString(16).padStart(64, '0');
  return {
    logicalResource: resource,
    walObjectId: `0x${bytes}`,
    checkpointId: `0x${bytes}`,
    walStatus: 'committed',
    materializationStatus: 'pending',
    nudgeStatus: 'not-configured',
    propagationStatus: 'not-claimed',
    sequence: String(index),
    objectCount: String(index + 1),
    objectSetRoot: `0x${bytes}`,
  };
}

async function publisher(walShadowWriter?: PublisherWalShadowWriter) {
  const store = new OxigraphStore();
  const instance = new DKGPublisher({
    store,
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    publisherPrivateKey: PRIVATE_KEY,
    walShadowWriter,
  });
  return { instance, store };
}

describe('WAL-013 publisher shadow boundary', () => {
  it('has zero WAL capture or response side effects when the explicit hook is absent', async () => {
    const { instance, store } = await publisher();
    const query = vi.spyOn(store, 'query');
    const result = await instance.share(CONTEXT_GRAPH, [quad(ROOT_A, '"legacy"')], {
      publisherPeerId: 'peer-legacy',
      operationCtx: { ...createOperationContext('share'), operationId: 'legacy-operation' },
      localOnly: true,
    });

    expect(result).not.toHaveProperty('wal');
    expect(query.mock.calls.some(([, options]) => options?.source === 'wal-shadow-capture')).toBe(false);
    await store.close();
  });

  it('emits one exact shadow mutation per logical key and captures replacement bases', async () => {
    const mutations: PublisherWalShadowMutationV1[] = [];
    const writer: PublisherWalShadowWriter = {
      write: vi.fn(async mutation => {
        mutations.push(mutation);
        return receipt(mutation.logicalResource, mutations.length);
      }),
    };
    const { instance, store } = await publisher(writer);
    const query = vi.spyOn(store, 'query');

    const first = await instance.share(CONTEXT_GRAPH, [
      quad(ROOT_A, '"one"'),
      quad(ROOT_B, '"two"'),
    ], {
      publisherPeerId: 'peer-parallel',
      operationCtx: { ...createOperationContext('share'), operationId: 'parallel-operation-1' },
      localOnly: true,
    });
    expect(first.wal).toMatchObject({
      mode: 'parallel', status: 'committed', propagationStatus: 'not-claimed',
    });
    expect(first.wal?.objects).toHaveLength(2);
    expect(mutations.map(mutation => mutation.logicalResource)).toEqual([ROOT_A, ROOT_B]);
    expect(mutations.every(mutation => mutation.baseQuads.length === 0)).toBe(true);
    expect(mutations.every(mutation => mutation.resultQuads.length > 0)).toBe(true);
    expect(query.mock.calls.some(([, options]) => options?.source === 'wal-shadow-capture')).toBe(false);
    expect(mutations[0]?.idempotencyKey).toBe('share:parallel-operation-1:urn:wal:root:a');
    expect(mutations[0]?.signer.address).toBe(new ethers.Wallet(PRIVATE_KEY).address);

    await instance.share(CONTEXT_GRAPH, [quad(ROOT_A, '"changed"')], {
      publisherPeerId: 'peer-parallel',
      operationCtx: { ...createOperationContext('share'), operationId: 'parallel-operation-2' },
      localOnly: true,
    });
    const replacement = mutations.at(-1)!;
    expect(query.mock.calls.some(([, options]) => options?.source === 'wal-shadow-capture')).toBe(true);
    expect(replacement.logicalResource).toBe(ROOT_A);
    expect(replacement.baseQuads.some(value => value.object === '"one"')).toBe(true);
    expect(replacement.resultQuads.some(value => value.object === '"changed"')).toBe(true);
    expect(replacement.resultQuads.some(value => value.object === '"one"')).toBe(false);
    await store.close();
  });

  it('reports bounded per-key shadow failure without rolling back the DKG mutation', async () => {
    let calls = 0;
    const writer: PublisherWalShadowWriter = {
      write: async mutation => {
        calls += 1;
        if (mutation.logicalResource === ROOT_B) throw new Error('shadow unavailable');
        return receipt(mutation.logicalResource, calls);
      },
    };
    const { instance, store } = await publisher(writer);
    const result = await instance.share(CONTEXT_GRAPH, [
      quad(ROOT_A, '"kept-a"'),
      quad(ROOT_B, '"kept-b"'),
    ], { publisherPeerId: 'peer-failure', localOnly: true });

    expect(result.wal).toMatchObject({ status: 'partial' });
    expect(result.wal?.objects).toHaveLength(1);
    expect(result.wal?.failures).toEqual([{ logicalResource: ROOT_B, status: 'blocked', shadowError: 'shadow unavailable' }]);
    const stored = await store.query(`SELECT ?o WHERE {
      GRAPH <did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory> {
        <${ROOT_B}> <https://schema.org/name> ?o
      }
    }`);
    expect(stored.type === 'bindings' ? stored.bindings[0]?.o : undefined).toBe('"kept-b"');
    await store.close();
  });

  it('captures one UAL-scoped publish object and an exact replacement update', async () => {
    const mutations: PublisherWalShadowMutationV1[] = [];
    const writer: PublisherWalShadowWriter = {
      write: vi.fn(async mutation => {
        mutations.push(mutation);
        return receipt(mutation.logicalResource, mutations.length);
      }),
    };
    const { instance, store } = await publisher(writer);
    const published = await instance.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [quad(ROOT_A, '"published"')],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: WAL_UAL,
      assertionVersion: 1,
      publicTripleCount: 1,
      operationCtx: { ...createOperationContext('publish'), operationId: 'publish-operation' },
    });

    expect(published.wal).toMatchObject({ status: 'committed' });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      kind: 'publish',
      operation: 'PUT',
      logicalResource: published.ual,
      logicalAuthorAddress: WAL_AUTHOR.toLowerCase(),
      idempotencyKey: `publish:publish-operation:${published.ual}`,
    });
    expect(mutations[0]!.baseQuads).toEqual([]);
    expect(mutations[0]!.resultQuads.some(value => value.object === '"published"')).toBe(true);
    expect(new Set(mutations[0]!.resultQuads.map(value => value.graph)).size).toBeGreaterThan(1);

    const updated = await instance.update(published.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [quad(ROOT_A, '"updated"')],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: WAL_UAL,
      assertionVersion: 2,
      publicTripleCount: 1,
      operationCtx: { ...createOperationContext('update'), operationId: 'update-operation' },
    });

    expect(updated.wal).toMatchObject({ status: 'committed' });
    expect(mutations).toHaveLength(2);
    expect(mutations[1]).toMatchObject({
      kind: 'update',
      operation: 'PUT',
      logicalResource: published.ual,
      logicalAuthorAddress: WAL_AUTHOR.toLowerCase(),
      idempotencyKey: `update:update-operation:${published.ual}`,
    });
    expect(mutations[1]!.baseQuads.some(value => value.object === '"published"')).toBe(true);
    expect(mutations[1]!.resultQuads.some(value => value.object === '"updated"')).toBe(true);
    expect(mutations[1]!.resultQuads.some(value => value.object === '"published"')).toBe(false);
    await store.close();
  });

  it('partitions one accepted private publish into isolated public and private WAL views', async () => {
    const mutations: PublisherWalShadowMutationV1[] = [];
    const write = vi.fn<PublisherWalShadowWriter['write']>(async mutation => {
      mutations.push(mutation);
      return receipt(mutation.logicalResource, mutations.length);
    });
    const { instance, store } = await publisher({ write });
    const result = await instance.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [quad(ROOT_A, '"public"')],
      privateQuads: [quad(ROOT_A, '"secret"')],
      publisherPeerId: 'private-owner',
      accessPolicy: 'ownerOnly',
      operationCtx: { ...createOperationContext('publish'), operationId: 'private-operation' },
    });

    expect(result.status).toBe('tentative');
    expect(result.wal).toMatchObject({
      status: 'committed',
      propagationStatus: 'not-claimed',
    });
    expect(mutations).toHaveLength(2);
    expect(mutations.map(mutation => mutation.visibility)).toEqual(['public', 'private']);
    expect(mutations[0]!.resultQuads.some(value => value.object === '"secret"')).toBe(false);
    expect(mutations[1]!.resultQuads).toEqual([
      expect.objectContaining({ subject: ROOT_A, object: '"secret"' }),
    ]);
    expect(mutations[1]!.resultQuads.every(value => value.graph.includes('/_private'))).toBe(true);
    expect(mutations[1]!.idempotencyKey).toBe(
      `publish:private-operation:${result.ual}:private`,
    );
    await store.close();
  });

  it('captures exact private replacement and deletion bases without exposing them to public WAL', async () => {
    const mutations: PublisherWalShadowMutationV1[] = [];
    const writer: PublisherWalShadowWriter = {
      write: vi.fn(async mutation => {
        mutations.push(mutation);
        return receipt(mutation.logicalResource, mutations.length);
      }),
    };
    const { instance, store } = await publisher(writer);
    const privateV1 = [quad(ROOT_A, '"private-v1"')];
    const published = await instance.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [quad(ROOT_A, '"public-v1"')],
      privateQuads: privateV1,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: WAL_UAL,
      assertionVersion: 1,
      publicTripleCount: 1,
      privateTripleCount: 1,
      privateMerkleRoot: computePrivateRootV10(privateV1),
      publisherPeerId: 'private-owner',
      accessPolicy: 'ownerOnly',
      operationCtx: { ...createOperationContext('publish'), operationId: 'private-publish-v1' },
    });
    expect(published.wal).toMatchObject({ status: 'committed' });
    expect(mutations.map(mutation => mutation.visibility)).toEqual(['public', 'private']);

    const privateV2 = [quad(ROOT_A, '"private-v2"')];
    const updated = await instance.update(published.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [quad(ROOT_A, '"public-v2"')],
      privateQuads: privateV2,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: WAL_UAL,
      assertionVersion: 2,
      publicTripleCount: 1,
      privateTripleCount: 1,
      privateMerkleRoot: computePrivateRootV10(privateV2),
      operationCtx: { ...createOperationContext('update'), operationId: 'private-update-v2' },
    });
    expect(updated.wal).toMatchObject({ status: 'committed' });
    const publicUpdate = mutations[2]!;
    const privateUpdate = mutations[3]!;
    expect(publicUpdate).toMatchObject({ kind: 'update', visibility: 'public', operation: 'PUT' });
    expect(publicUpdate.baseQuads.some(value => value.object === '"private-v1"')).toBe(false);
    expect(publicUpdate.resultQuads.some(value => value.object === '"private-v2"')).toBe(false);
    expect(privateUpdate).toMatchObject({ kind: 'update', visibility: 'private', operation: 'PUT' });
    expect(privateUpdate.baseQuads.some(value => value.object === '"private-v1"')).toBe(true);
    expect(privateUpdate.resultQuads.some(value => value.object === '"private-v2"')).toBe(true);
    expect(new Set(privateUpdate.baseQuads.map(value => value.graph))).not.toEqual(
      new Set(privateUpdate.resultQuads.map(value => value.graph)),
    );

    const deleted = await instance.update(published.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [quad(ROOT_A, '"public-v3"')],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: WAL_UAL,
      assertionVersion: 3,
      publicTripleCount: 1,
      privateTripleCount: 0,
      operationCtx: { ...createOperationContext('update'), operationId: 'private-delete-v3' },
    });
    expect(deleted.wal).toMatchObject({ status: 'committed' });
    const privateDelete = mutations[5]!;
    expect(privateDelete).toMatchObject({
      kind: 'update',
      visibility: 'private',
      operation: 'DELETE',
      resultQuads: [],
    });
    expect(privateDelete.baseQuads.some(value => value.object === '"private-v2"')).toBe(true);
    expect(mutations.filter(mutation => mutation.visibility === 'public')
      .some(mutation => [...mutation.baseQuads, ...mutation.resultQuads]
        .some(value => value.object === '"private-v1"' || value.object === '"private-v2"'))).toBe(false);
    await store.close();
  });

  it('authors the graph-scoped assertion promote used by the daemon and replays its stable intent', async () => {
    const mutations: PublisherWalShadowMutationV1[] = [];
    const committedByKey = new Map<string, PublisherWalShadowObjectReceiptV1>();
    const writer: PublisherWalShadowWriter = {
      write: vi.fn(async mutation => {
        mutations.push(mutation);
        const existing = committedByKey.get(mutation.idempotencyKey);
        if (existing) return { ...existing, walStatus: 'already-committed' };
        const committed = receipt(mutation.logicalResource, committedByKey.size + 1);
        committedByKey.set(mutation.idempotencyKey, committed);
        return committed;
      }),
    };
    const { instance, store } = await publisher(writer);
    const assertionName = 'wal-graph-share';
    await instance.assertionCreate(CONTEXT_GRAPH, assertionName, WAL_AUTHOR);
    await instance.assertionWrite(CONTEXT_GRAPH, assertionName, WAL_AUTHOR, [
      quad(ROOT_A, '"graph-scoped"'),
    ]);
    const finalized = await finalizeRootlessAssertionForTest({
      publisher: instance,
      store,
      contextGraphId: CONTEXT_GRAPH,
      name: assertionName,
      agentAddress: WAL_AUTHOR,
    });

    const first = await instance.assertionPromote(
      CONTEXT_GRAPH,
      assertionName,
      WAL_AUTHOR,
      { localOnly: true },
    );
    expect(first.wal).toMatchObject({
      mode: 'parallel',
      status: 'committed',
      objects: [{ walStatus: 'committed' }],
    });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      kind: 'share',
      operation: 'PUT',
      contextGraphId: CONTEXT_GRAPH,
      logicalAuthorAddress: WAL_AUTHOR.toLowerCase(),
      logicalResource: finalized.kaUal,
      idempotencyKey: `share:${first.shareOperationId}:${finalized.kaUal}`,
    });
    expect(mutations[0]!.baseQuads).toEqual([]);
    expect(mutations[0]!.resultQuads.some(value => value.object === '"graph-scoped"')).toBe(true);
    const firstWalObjectId = first.wal?.objects[0]?.walObjectId;
    const firstTimestamp = mutations[0]!.timestampMs;

    const retried = await instance.assertionPromote(
      CONTEXT_GRAPH,
      assertionName,
      WAL_AUTHOR,
      { localOnly: true },
    );
    expect(retried.shareOperationId).toBe(first.shareOperationId);
    expect(retried.wal).toMatchObject({
      status: 'committed',
      objects: [{ walObjectId: firstWalObjectId, walStatus: 'already-committed' }],
    });
    expect(mutations).toHaveLength(2);
    expect(mutations[1]!.idempotencyKey).toBe(mutations[0]!.idempotencyKey);
    expect(mutations[1]!.timestampMs).toBe(firstTimestamp);
    expect(mutations[1]!.resultQuads).toEqual(mutations[0]!.resultQuads);
    expect(mutations[1]!.baseQuads.length).toBeGreaterThan(0);
    await store.close();
  });

  it('keeps graph-scoped legacy SWM committed when the WAL writer fails', async () => {
    const writer: PublisherWalShadowWriter = {
      write: vi.fn(async () => {
        throw new Error('graph-scoped WAL unavailable');
      }),
    };
    const { instance, store } = await publisher(writer);
    const assertionName = 'wal-graph-share-failure';
    await instance.assertionCreate(CONTEXT_GRAPH, assertionName, WAL_AUTHOR);
    await instance.assertionWrite(CONTEXT_GRAPH, assertionName, WAL_AUTHOR, [
      quad(ROOT_A, '"legacy-survives"'),
    ]);
    const finalized = await finalizeRootlessAssertionForTest({
      publisher: instance,
      store,
      contextGraphId: CONTEXT_GRAPH,
      name: assertionName,
      agentAddress: WAL_AUTHOR,
    });

    const promoted = await instance.assertionPromote(
      CONTEXT_GRAPH,
      assertionName,
      WAL_AUTHOR,
      { localOnly: true },
    );
    expect(promoted.wal).toMatchObject({
      status: 'blocked',
      failures: [{
        logicalResource: finalized.kaUal,
        status: 'blocked',
        shadowError: 'graph-scoped WAL unavailable',
      }],
    });
    const stored = await store.query(`ASK { GRAPH <${finalized.sharedGraphUri}> {
      <${ROOT_A}> <https://schema.org/name> "legacy-survives"
    } }`);
    expect(stored).toEqual({ type: 'boolean', value: true });
    await store.close();
  });

  it('partitions graph-scoped promote bytes into isolated public and private WAL views', async () => {
    const mutations: PublisherWalShadowMutationV1[] = [];
    const write = vi.fn<PublisherWalShadowWriter['write']>(async mutation => {
      mutations.push(mutation);
      return receipt(mutation.logicalResource, mutations.length);
    });
    const { instance, store } = await publisher({ write });
    const assertionName = 'wal-private-graph-share';
    await instance.assertionCreate(CONTEXT_GRAPH, assertionName, WAL_AUTHOR);
    await instance.assertionWrite(CONTEXT_GRAPH, assertionName, WAL_AUTHOR, [
      quad(ROOT_A, '"public-part"'),
    ]);
    await instance.assertionWritePrivate(CONTEXT_GRAPH, assertionName, WAL_AUTHOR, [
      quad('urn:wal:private', '"secret-part"'),
    ]);
    const finalized = await finalizeRootlessAssertionForTest({
      publisher: instance,
      store,
      contextGraphId: CONTEXT_GRAPH,
      name: assertionName,
      agentAddress: WAL_AUTHOR,
    });

    const promoted = await instance.assertionPromote(
      CONTEXT_GRAPH,
      assertionName,
      WAL_AUTHOR,
      { localOnly: true },
    );
    expect(promoted.wal).toMatchObject({
      status: 'committed',
      failures: [],
    });
    expect(mutations).toHaveLength(2);
    expect(mutations.map(mutation => mutation.visibility)).toEqual(['public', 'private']);
    expect(mutations[0]!.resultQuads.some(value => value.object === '"secret-part"')).toBe(false);
    expect(mutations[1]).toMatchObject({
      logicalResource: finalized.kaUal,
      visibility: 'private',
      baseQuads: [],
    });
    expect(mutations[1]!.resultQuads.some(value => value.object === '"secret-part"')).toBe(true);
    expect(mutations[1]!.resultQuads.every(value => value.graph.includes('/_private/'))).toBe(true);
    await store.close();
  });
});
