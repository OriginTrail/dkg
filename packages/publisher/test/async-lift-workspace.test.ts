import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { DKGPublisher } from '../src/index.js';
import { resolveLiftWorkspaceSlice, resolveWorkspaceSelection } from '../src/workspace-resolution.js';
import { createEVMAdapter, getSharedContext, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';

const PARANET = 'test-workspace';
const ENTITY = 'urn:test:entity:1';
const ENTITY_2 = 'urn:test:entity:2';

describe('async lift workspace resolution', () => {
  let store: OxigraphStore;
  let graphManager: GraphManager;
  let publisher: DKGPublisher;
  beforeEach(async () => {
    store = new OxigraphStore();
    graphManager = new GraphManager(store);
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
  });

  it('resolves workspace selection by roots with graphless quads', async () => {
    await publisher.share(PARANET, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const quads = await resolveWorkspaceSelection({
      store,
      graphManager,
      contextGraphId: PARANET,
      selection: { rootEntities: [ENTITY] },
    });

    expect(quads).toHaveLength(1);
    expect(quads[0]?.subject).toBe(ENTITY);
    expect(quads[0]?.graph).toBe('');
  });

  it('includes skolemized descendants when resolving by root selection', async () => {
    const skolem = `${ENTITY}/.well-known/genid/child-1`;
    await publisher.share(PARANET, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: skolem, predicate: 'http://schema.org/value', object: '"Nested"', graph: '' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const quads = await resolveWorkspaceSelection({
      store,
      graphManager,
      contextGraphId: PARANET,
      selection: { rootEntities: [ENTITY] },
    });

    expect(quads).toHaveLength(2);
    expect(quads.map((quad) => quad.subject).sort()).toEqual([ENTITY, skolem].sort());
  });

  it('resolves a LiftRequest slice using shareOperationId and roots', async () => {
    const skolem = `${ENTITY}/.well-known/genid/child-1`;
    const write = await publisher.share(PARANET, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: skolem, predicate: 'http://schema.org/value', object: '"Nested"', graph: '' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId: write.shareOperationId,
        roots: [ENTITY],
        contextGraphId: PARANET,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
    });

    expect(resolved.quads).toHaveLength(2);
    expect(resolved.quads.map((quad) => quad.subject).sort()).toEqual([ENTITY, skolem].sort());
    expect(resolved.publisherPeerId).toBe('peer1');
  });

  it('resolves a LiftRequest slice with the renamed fields', async () => {
    const write = await publisher.share(PARANET, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId: write.shareOperationId,
        roots: [ENTITY],
        contextGraphId: PARANET,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
    });

    expect(resolved.quads).toHaveLength(1);
    expect(resolved.quads[0]?.subject).toBe(ENTITY);
  });

  it('rejects roots not linked to the requested workspace operation', async () => {
    const write = await publisher.share(PARANET, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    await expect(
      resolveLiftWorkspaceSlice({
        store,
        graphManager,
        request: {
          swmId: 'swm-main',
          shareOperationId: write.shareOperationId,
          roots: [ENTITY_2],
          contextGraphId: PARANET,
          namespace: 'aloha',
          scope: 'person-profile',
          transitionType: 'CREATE',
          authority: { type: 'owner', proofRef: 'proof:owner:1' },
        },
      }),
    ).rejects.toThrow(`Lift shared-memory resolution roots are not part of share operation ${write.shareOperationId}`);
  });

  it('rejects unsafe shareOperationId values before querying workspace metadata', async () => {
    await expect(
      resolveLiftWorkspaceSlice({
        store,
        graphManager,
        request: {
          swmId: 'swm-main',
          shareOperationId: 'bad>op',
          roots: [ENTITY],
          contextGraphId: PARANET,
          namespace: 'aloha',
          scope: 'person-profile',
          transitionType: 'CREATE',
          authority: { type: 'owner', proofRef: 'proof:owner:1' },
        },
      }),
    ).rejects.toThrow('Shared-memory resolution rejected unsafe shareOperationId: bad>op');
  });
});
