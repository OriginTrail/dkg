import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { DKGPublisher } from '../src/index.js';
import { resolveLiftWorkspaceSlice, resolveWorkspaceSelection } from '../src/workspace-resolution.js';

const PARANET = 'test-workspace';
const ENTITY = 'urn:test:entity:1';
const ENTITY_2 = 'urn:test:entity:2';

describe('async lift workspace resolution', () => {
  let store: OxigraphStore;
  let graphManager: GraphManager;
  let publisher: DKGPublisher;
  const wallet = ethers.Wallet.createRandom();

  beforeEach(async () => {
    store = new OxigraphStore();
    graphManager = new GraphManager(store);
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });
  });

  it('resolves workspace selection by roots with graphless quads', async () => {
    await publisher.writeToWorkspace(PARANET, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const quads = await resolveWorkspaceSelection({
      store,
      graphManager,
      paranetId: PARANET,
      selection: { rootEntities: [ENTITY] },
    });

    expect(quads).toHaveLength(1);
    expect(quads[0]?.subject).toBe(ENTITY);
    expect(quads[0]?.graph).toBe('');
  });

  it('includes skolemized descendants when resolving by root selection', async () => {
    const skolem = `${ENTITY}/.well-known/genid/child-1`;
    await publisher.writeToWorkspace(PARANET, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: skolem, predicate: 'http://schema.org/value', object: '"Nested"', graph: '' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const quads = await resolveWorkspaceSelection({
      store,
      graphManager,
      paranetId: PARANET,
      selection: { rootEntities: [ENTITY] },
    });

    expect(quads).toHaveLength(2);
    expect(quads.map((quad) => quad.subject).sort()).toEqual([ENTITY, skolem].sort());
  });

  it('resolves a LiftRequest slice using workspaceOperationId and roots', async () => {
    const skolem = `${ENTITY}/.well-known/genid/child-1`;
    const write = await publisher.writeToWorkspace(PARANET, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: skolem, predicate: 'http://schema.org/value', object: '"Nested"', graph: '' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        workspaceId: 'workspace-main',
        workspaceOperationId: write.workspaceOperationId,
        roots: [ENTITY],
        paranetId: PARANET,
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

  it('rejects roots not linked to the requested workspace operation', async () => {
    const write = await publisher.writeToWorkspace(PARANET, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    await expect(
      resolveLiftWorkspaceSlice({
        store,
        graphManager,
        request: {
          workspaceId: 'workspace-main',
          workspaceOperationId: write.workspaceOperationId,
          roots: [ENTITY_2],
          paranetId: PARANET,
          namespace: 'aloha',
          scope: 'person-profile',
          transitionType: 'CREATE',
          authority: { type: 'owner', proofRef: 'proof:owner:1' },
        },
      }),
    ).rejects.toThrow(`Lift workspace resolution roots are not part of workspace operation ${write.workspaceOperationId}`);
  });

  it('rejects unsafe workspaceOperationId values before querying workspace metadata', async () => {
    await expect(
      resolveLiftWorkspaceSlice({
        store,
        graphManager,
        request: {
          workspaceId: 'workspace-main',
          workspaceOperationId: 'bad>op',
          roots: [ENTITY],
          paranetId: PARANET,
          namespace: 'aloha',
          scope: 'person-profile',
          transitionType: 'CREATE',
          authority: { type: 'owner', proofRef: 'proof:owner:1' },
        },
      }),
    ).rejects.toThrow('Workspace resolution rejected unsafe workspaceOperationId: bad>op');
  });
});
