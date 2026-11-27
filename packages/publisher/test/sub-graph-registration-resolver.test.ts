// SPDX-License-Identifier: Apache-2.0

/**
 * #3293: a write into a sub-graph this node has not registered is refused
 * with a typed `SubGraphNotFoundError` (the daemon answers it with HTTP 400,
 * never 500), after the publisher's resolver, when it has one, had the chance
 * to find and register it. The agent's resolver asks the graph's peers, so a
 * member can write into a sub-graph the owner registered.
 */
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { generateSubGraphRegistration } from '../src/metadata.js';
import {
  requireSubGraphRegistration,
  SUB_GRAPH_NOT_FOUND_CODE,
  SubGraphNotFoundError,
  type UnregisteredSubGraphResolver,
} from '../src/index.js';

const CG = 'sub-graph-resolver';
const AUTHOR = `0x${'22'.repeat(20)}`;
const SUB_GRAPH = 'reports';

const stores: OxigraphStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function openStore(): OxigraphStore {
  const store = new OxigraphStore();
  stores.push(store);
  return store;
}

function registration(subGraphName = SUB_GRAPH) {
  return generateSubGraphRegistration({ contextGraphId: CG, subGraphName, createdBy: 'owner-peer', timestamp: new Date() });
}

/** A resolver that registers the sub-graph, as the agent's does when a peer holds it. */
function registeringResolver(store: OxigraphStore) {
  return vi.fn<UnregisteredSubGraphResolver>(async (contextGraphId, subGraphName) => {
    await store.insert(generateSubGraphRegistration({ contextGraphId, subGraphName, createdBy: 'owner-peer', timestamp: new Date() }));
    return { registered: true };
  });
}

async function publisherOver(store: OxigraphStore, resolveUnregisteredSubGraph?: UnregisteredSubGraphResolver) {
  return new DKGPublisher({
    store,
    chain: new MockChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    ...(resolveUnregisteredSubGraph === undefined ? {} : { resolveUnregisteredSubGraph }),
  });
}

describe('requireSubGraphRegistration', () => {
  it('admits a registered sub-graph without asking the resolver', async () => {
    const store = openStore();
    await store.insert(registration());
    const resolve = vi.fn<UnregisteredSubGraphResolver>();

    await expect(requireSubGraphRegistration(store, CG, SUB_GRAPH, resolve)).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses an unregistered sub-graph with a typed error when there is no resolver', async () => {
    const refusal = await requireSubGraphRegistration(openStore(), CG, SUB_GRAPH).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(SubGraphNotFoundError);
    expect(refusal).toMatchObject({
      name: 'SubGraphNotFoundError',
      code: SUB_GRAPH_NOT_FOUND_CODE,
      contextGraphId: CG,
      subGraphName: SUB_GRAPH,
      detail: undefined,
    });
    expect((refusal as Error).message).toBe(
      `Sub-graph "${SUB_GRAPH}" has not been registered in context graph "${CG}". `
      + 'Create it first: createSubGraph(), or POST /api/sub-graph/create.',
    );
  });

  it('admits the sub-graph once the resolver registered it', async () => {
    const store = openStore();
    const resolve = registeringResolver(store);

    await expect(requireSubGraphRegistration(store, CG, SUB_GRAPH, resolve)).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledWith(CG, SUB_GRAPH);
  });

  it('still refuses when the resolver says registered but nothing was stored', async () => {
    const resolve = vi.fn<UnregisteredSubGraphResolver>(async () => ({ registered: true }));

    await expect(requireSubGraphRegistration(openStore(), CG, SUB_GRAPH, resolve)).rejects.toBeInstanceOf(SubGraphNotFoundError);
  });

  it('carries what the resolver found out into the refusal', async () => {
    const resolve = vi.fn<UnregisteredSubGraphResolver>(async () => ({
      registered: false,
      detail: 'none of the 2 peer(s) of the context graph asked holds it',
    }));

    await expect(requireSubGraphRegistration(openStore(), CG, SUB_GRAPH, resolve)).rejects.toThrow(
      `Sub-graph "${SUB_GRAPH}" has not been registered in context graph "${CG}" `
      + '(none of the 2 peer(s) of the context graph asked holds it). Create it first',
    );
  });
});

describe('DKGPublisher with a sub-graph resolver', () => {
  it('lets the first assertion write into a sub-graph its resolver finds', async () => {
    const store = openStore();
    const resolve = registeringResolver(store);
    const publisher = await publisherOver(store, resolve);

    await publisher.assertionCreate(CG, 'draft', AUTHOR, SUB_GRAPH);
    await publisher.assertionWrite(CG, 'draft', AUTHOR, [
      { subject: 'urn:test:3293', predicate: 'http://schema.org/name', object: '"first"', graph: '' },
    ], SUB_GRAPH);

    expect(resolve).toHaveBeenCalledOnce();
    await expect(publisher.assertionQuery(CG, 'draft', AUTHOR, SUB_GRAPH)).resolves.toHaveLength(1);
  });

  it('refuses a create, a share and a publish into a sub-graph nobody holds with SubGraphNotFoundError', async () => {
    const store = openStore();
    const resolve = vi.fn<UnregisteredSubGraphResolver>(async () => ({ registered: false, detail: 'asked nobody' }));
    const publisher = await publisherOver(store, resolve);
    const quads = [{ subject: 'urn:test:3293', predicate: 'http://schema.org/name', object: '"x"', graph: '' }];

    await expect(publisher.assertionCreate(CG, 'draft', AUTHOR, 'missing')).rejects.toMatchObject({
      code: SUB_GRAPH_NOT_FOUND_CODE, subGraphName: 'missing', detail: 'asked nobody',
    });
    await expect(publisher.writeToWorkspace(CG, quads, { publisherPeerId: 'peer', subGraphName: 'missing' }))
      .rejects.toBeInstanceOf(SubGraphNotFoundError);
    await expect(publisher.publish({ contextGraphId: CG, quads, subGraphName: 'missing' }))
      .rejects.toBeInstanceOf(SubGraphNotFoundError);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('refuses without a resolver as before, with the typed error', async () => {
    const publisher = await publisherOver(openStore());

    await expect(publisher.assertionCreate(CG, 'draft', AUTHOR, SUB_GRAPH)).rejects.toMatchObject({
      code: SUB_GRAPH_NOT_FOUND_CODE,
      message: expect.stringContaining(`Sub-graph "${SUB_GRAPH}" has not been registered`),
    });
  });
});
