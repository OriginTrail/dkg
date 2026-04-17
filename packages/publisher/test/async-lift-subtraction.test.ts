import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { DKGPublisher } from '../src/index.js';
import { validateLiftPublishPayload } from '../src/async-lift-validation.js';
import { subtractFinalizedExactQuads } from '../src/async-lift-subtraction.js';
import type { LiftValidationInput } from '../src/async-lift-validation.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, createTestContextGraph, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

describe('subtractFinalizedExactQuads', () => {
  let store: OxigraphStore;
  let graphManager: GraphManager;
  let publisher: DKGPublisher;
  let _testSnapshot: string;

  let PARANET: string;
  let _fileSnapshot: string;
  beforeAll(async () => {
    _fileSnapshot = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
    const cgId = await createTestContextGraph();
    PARANET = cgId.toString();
  });
  afterAll(async () => {
    await revertSnapshot(_fileSnapshot);
  });

  beforeEach(async () => {
    _testSnapshot = await takeSnapshot();
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
  afterEach(async () => {
    await revertSnapshot(_testSnapshot);
  });

  function baseInput(): LiftValidationInput {
    return {
      request: {
        swmId: 'swm-main',
        shareOperationId: 'swm-1',
        roots: ['urn:local:/rihana'],
        contextGraphId: PARANET,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
      resolved: {
        quads: [
          { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
          { subject: 'urn:local:/rihana', predicate: 'http://schema.org/genre', object: '"Pop"', graph: '' },
        ],
        privateQuads: [
          { subject: 'urn:local:/rihana', predicate: 'http://schema.org/secret', object: '"hidden"', graph: '' },
        ],
        publisherPeerId: 'peer-1',
      },
    };
  }

  it('removes only the exact finalized public quads and keeps the remainder', async () => {
    const validated = validateLiftPublishPayload(baseInput());
    const [publishedNameQuad, genreQuad] = validated.resolved.quads;
    const authoritativePublic = [publishedNameQuad!];

    await publisher.publish({
      contextGraphId: PARANET,
      quads: authoritativePublic,
      publisherPeerId: 'peer-1',
    });

    const result = await subtractFinalizedExactQuads({
      store,
      graphManager,
      request: baseInput().request,
      validation: validated.validation,
      resolved: validated.resolved,
    });

    expect(result.alreadyPublishedPublicCount).toBe(1);
    expect(result.alreadyPublishedPrivateCount).toBe(0);
    expect(result.resolved.quads).toEqual([genreQuad]);
  });

  it('removes exact finalized public and private quads and returns an empty remainder for full no-op', async () => {
    const validated = validateLiftPublishPayload(baseInput());
    const authoritativePublic = validated.resolved.quads;
    const authoritativePrivate = validated.resolved.privateQuads;

    await publisher.publish({
      contextGraphId: PARANET,
      quads: authoritativePublic,
      privateQuads: authoritativePrivate,
      publisherPeerId: 'peer-1',
    });

    const result = await subtractFinalizedExactQuads({
      store,
      graphManager,
      request: baseInput().request,
      validation: validated.validation,
      resolved: validated.resolved,
    });

    expect(result.alreadyPublishedPublicCount).toBe(validated.resolved.quads.length);
    expect(result.alreadyPublishedPrivateCount).toBe(validated.resolved.privateQuads?.length ?? 0);
    expect(result.resolved.quads).toEqual([]);
    expect(result.resolved.privateQuads).toBeUndefined();
  });

  it('does not subtract when the root is not confirmed even if the quad exists locally', async () => {
    const validated = validateLiftPublishPayload(baseInput());
    const dataGraph = graphManager.dataGraphUri(PARANET);
    await store.insert([
      { ...validated.resolved.quads[0]!, graph: dataGraph },
    ]);

    const result = await subtractFinalizedExactQuads({
      store,
      graphManager,
      request: baseInput().request,
      validation: validated.validation,
      resolved: validated.resolved,
    });

    expect(result.alreadyPublishedPublicCount).toBe(0);
    expect(result.resolved.quads).toEqual(validated.resolved.quads);
  });

  it('bypasses subtraction for non-CREATE transitions', async () => {
    const input: LiftValidationInput = {
      ...baseInput(),
      request: {
        ...baseInput().request,
        transitionType: 'MUTATE',
        priorVersion: 'did:dkg:mock:31337/0xabc/7',
      },
    };
    const validated = validateLiftPublishPayload(input);

    const result = await subtractFinalizedExactQuads({
      store,
      graphManager,
      request: input.request,
      validation: validated.validation,
      resolved: validated.resolved,
    });

    expect(result.alreadyPublishedPublicCount).toBe(0);
    expect(result.alreadyPublishedPrivateCount).toBe(0);
    expect(result.resolved).toEqual(validated.resolved);
  });

  it('subtracts only quads under confirmed roots in mixed-root payloads', async () => {
    const input: LiftValidationInput = {
      request: {
        ...baseInput().request,
        roots: ['urn:local:/rihana', 'urn:local:/manson'],
      },
      resolved: {
        quads: [
          { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
          { subject: 'urn:local:/manson', predicate: 'http://schema.org/name', object: '"Manson"', graph: '' },
        ],
        publisherPeerId: 'peer-1',
      },
    };
    const validated = validateLiftPublishPayload(input);
    const [rihanaQuad, mansonQuad] = validated.resolved.quads;

    await publisher.publish({
      contextGraphId: PARANET,
      quads: [rihanaQuad!],
      publisherPeerId: 'peer-1',
    });

    const result = await subtractFinalizedExactQuads({
      store,
      graphManager,
      request: input.request,
      validation: validated.validation,
      resolved: validated.resolved,
    });

    expect(result.alreadyPublishedPublicCount).toBe(1);
    expect(result.resolved.quads).toEqual([mansonQuad!]);
  });
});
