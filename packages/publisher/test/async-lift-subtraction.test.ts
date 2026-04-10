import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { DKGPublisher } from '../src/index.js';
import { validateLiftPublishPayload } from '../src/async-lift-validation.js';
import { subtractFinalizedExactQuads } from '../src/async-lift-subtraction.js';
import type { LiftValidationInput } from '../src/async-lift-validation.js';

describe('subtractFinalizedExactQuads', () => {
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

  function baseInput(): LiftValidationInput {
    return {
      request: {
        swmId: 'swm-main',
        shareOperationId: 'swm-1',
        roots: ['urn:local:/rihana'],
        contextGraphId: 'music-social',
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
      contextGraphId: 'music-social',
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

    const removedPublic = validated.resolved.quads.filter(
      (quad) => !result.resolved.quads.some((remaining) => JSON.stringify(remaining) === JSON.stringify(quad)),
    );

    console.log('Input public quads:', validated.resolved.quads);
    console.log('Already finalized public quads:', authoritativePublic);
    console.log('Removed public quads:', removedPublic);
    console.log('Remaining public quads:', result.resolved.quads);

    expect(result.alreadyPublishedPublicCount).toBe(1);
    expect(result.alreadyPublishedPrivateCount).toBe(0);
    expect(result.resolved.quads).toEqual([genreQuad]);
  });

  it('removes exact finalized public and private quads and returns an empty remainder for full no-op', async () => {
    const validated = validateLiftPublishPayload(baseInput());
    const authoritativePublic = validated.resolved.quads;
    const authoritativePrivate = validated.resolved.privateQuads;

    await publisher.publish({
      contextGraphId: 'music-social',
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

    console.log('Input public quads:', validated.resolved.quads);
    console.log('Input private quads:', validated.resolved.privateQuads);
    console.log('Already finalized public quads:', authoritativePublic);
    console.log('Already finalized private quads:', authoritativePrivate);
    console.log('Removed public quads:', validated.resolved.quads);
    console.log('Removed private quads:', validated.resolved.privateQuads);
    console.log('Remaining public quads:', result.resolved.quads);
    console.log('Remaining private quads:', result.resolved.privateQuads);

    expect(result.alreadyPublishedPublicCount).toBe(validated.resolved.quads.length);
    expect(result.alreadyPublishedPrivateCount).toBe(validated.resolved.privateQuads?.length ?? 0);
    expect(result.resolved.quads).toEqual([]);
    expect(result.resolved.privateQuads).toBeUndefined();
  });

  it('does not subtract when the root is not confirmed even if the quad exists locally', async () => {
    const validated = validateLiftPublishPayload(baseInput());
    const dataGraph = graphManager.dataGraphUri('music-social');
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
      contextGraphId: 'music-social',
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
