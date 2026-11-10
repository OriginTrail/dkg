// SPDX-License-Identifier: Apache-2.0
/**
 * ContextGraphs 10.1.0, publish path: `DKGPublisher.publish` asks the chain's
 * author gate before it asks any core for an ACK. A non-member author stops
 * there, with no ACK requested and no transaction attempted; a member author
 * publishes as before.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, type OnChainPublishResult, type V10PublishParams } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { AuthorNotContextGraphMemberError } from '../src/author-membership-preflight.js';
import { mockSealCtx, withSeal } from './_helpers/seal.js';

const PRODUCER = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const CG_ID = '42';

/** A mock chain with the author gate, answering `member` and recording what it was asked. */
class AuthorGateChain extends MockChainAdapter {
  readonly asked: Array<[bigint, string]> = [];
  readonly submitted: V10PublishParams[] = [];

  constructor(private readonly member: boolean) {
    super('mock:31337', PRODUCER.address);
    this.minimumRequiredSignatures = 0;
  }

  async isAuthorizedAuthor(contextGraphId: bigint, author: string): Promise<boolean> {
    this.asked.push([contextGraphId, author]);
    return this.member;
  }

  override async createKnowledgeAssets(params: V10PublishParams): Promise<OnChainPublishResult> {
    this.submitted.push(params);
    return super.createKnowledgeAssets(params);
  }
}

async function publishThrough(chain: AuthorGateChain) {
  const acksRequested: unknown[] = [];
  const publisher = new DKGPublisher({
    store: new OxigraphStore(),
    chain,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    publisherPrivateKey: PRODUCER.privateKey,
    publisherNodeIdentityId: 1n,
  });
  const args = await withSeal({
    contextGraphId: CG_ID,
    quads: [{ subject: 'urn:member-gate', predicate: 'http://schema.org/name', object: '"v1"', graph: '' }] as Quad[],
    publisherPeerId: 'peer-1',
    v10ACKProvider: async (request: unknown) => {
      acksRequested.push(request);
      return [{ peerId: 'peer-core-1', signatureR: new Uint8Array(32), signatureVS: new Uint8Array(32), nodeIdentityId: 1n }];
    },
  }, PRODUCER, mockSealCtx());
  return { publisher, args, acksRequested };
}

describe('DKGPublisher author gate (ContextGraphs 10.1.0)', () => {
  it('refuses a non-member author before any ACK is requested or transaction attempted', async () => {
    const chain = new AuthorGateChain(false);
    const { publisher, args, acksRequested } = await publishThrough(chain);

    const refusal = await publisher.publish(args).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(AuthorNotContextGraphMemberError);
    expect((refusal as AuthorNotContextGraphMemberError).contextGraphId).toBe(42n);
    expect(chain.asked).toEqual([[42n, PRODUCER.address]]);
    expect(acksRequested).toEqual([]);
    expect(chain.submitted).toEqual([]);
  });

  it('publishes a member author as before', async () => {
    const chain = new AuthorGateChain(true);
    const { publisher, args, acksRequested } = await publishThrough(chain);

    const result = await publisher.publish(args);

    expect(result.status).not.toBe('failed');
    expect(chain.asked).toEqual([[42n, PRODUCER.address]]);
    expect(acksRequested).toHaveLength(1);
    expect(chain.submitted).toHaveLength(1);
    expect(chain.submitted[0].author.address.toLowerCase()).toBe(PRODUCER.address.toLowerCase());
  });
});
