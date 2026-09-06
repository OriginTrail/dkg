/**
 * GH#1689 — the seal's author must reach the chain publish-plan request.
 *
 * WHY THIS FILE EXISTS (adversary finding, MAJOR):
 * `dkg-publisher.ts` forwards `options.precomputedAttestation?.authorAddress`
 * into `publisherPlanning.finalize({...})` on ONE line. That line is the sole
 * connection between the seal and the planner, and nothing exercised it: delete
 * it and the whole repo still type-checks (the field is optional on
 * `PublisherPlanningFinalizeInput`) and every publisher test still passes.
 *
 * That silence is not harmless, because the two lanes fail differently:
 *
 *   - The SYNC lane would survive the deletion. `createKnowledgeAssets`
 *     re-derives the author independently from `params.author?.address`, so the
 *     admission gate still sees it.
 *   - The ASYNC lane would NOT. It is rejected INSIDE the planner
 *     (`evm-adapter-publish.ts`, the pinned branch), before
 *     `createKnowledgeAssets` is ever reached — so the planner is the only place
 *     that can see the author, and this line is the only thing that puts it
 *     there.
 *
 * The async lane is the one #1689 was filed about. So deleting that line
 * silently un-fixes the issue for the lane that has the bug, while leaving the
 * suite green. The existing agent-side test
 * (`publish-foreign-author-resolution.test.ts`) covers the LATER hops — it hands
 * `attestedAuthorAddress` straight to `PublisherPlanner.finalize` and describes
 * this hop in prose — so it cannot catch this.
 *
 * This file drives the REAL `DKGPublisher.publish()` and records the request the
 * chain adapter actually received.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import type {
  ChainAdapter,
  OnChainPublishResult,
  PublisherPublishPlanRequest,
  V10PublishDirectParams,
} from '@origintrail-official/dkg-chain';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { buildSeal, mockSealCtx } from './_helpers/seal.js';
import { mockChainStubACKProvider } from './_helpers/acks.js';

/** Pays for the publish — the wallet the planner pins and the tx is sent from. */
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
/** Signs the seal — a DIFFERENT principal. The whole point of #1689. */
const AUTHOR_KEY = '0x5de4111a56f4c24611d9ed4d5318a7e03f9b9a9d73f3a5f3f6324a2a0e6fbb36';
const KAV10_ADDRESS = '0x00000000000000000000000000000000000000A1';

/** Records every publish-plan request the publisher issues. */
class PlanRecordingChain implements ChainAdapter {
  readonly chainId = 'mock:31337';
  readonly planRequests: PublisherPublishPlanRequest[] = [];

  constructor(private readonly payer: ethers.Wallet) {}

  isV10Ready(): boolean { return true; }
  async getEvmChainId(): Promise<bigint> { return 31337n; }
  async getKnowledgeAssetsLifecycleAddress(): Promise<string> { return KAV10_ADDRESS; }
  async getDKGKnowledgeAssetsAddress(): Promise<string> { return KAV10_ADDRESS; }
  async getAuthorizedPublisherAddress(): Promise<string> { return this.payer.address; }

  async resolvePublisherPublishPlan(request: PublisherPublishPlanRequest) {
    this.planRequests.push(request);
    const publishEpochs = request.explicitPublishEpochs ?? request.defaultPublishEpochs;
    return {
      publisherAddress: this.payer.address,
      publishEpochs,
      tokenAmount: BigInt(publishEpochs),
    };
  }

  async signMessageAs(_address: string, messageHash: Uint8Array) {
    const sig = ethers.Signature.from(await this.payer.signMessage(messageHash));
    return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
  }

  async signTypedDataAs(
    _address: string,
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.payer.signTypedData(domain, types, value);
  }

  async createKnowledgeAssets(params: V10PublishDirectParams): Promise<OnChainPublishResult> {
    const kaId = params.reservedKaId ?? 1n;
    return {
      batchId: kaId,
      startKAId: kaId,
      endKAId: kaId,
      txHash: `0x${'7a'.repeat(32)}`,
      blockNumber: 1,
      blockTimestamp: Math.floor(Date.now() / 1000),
      publisherAddress: this.payer.address,
    };
  }
}

const QUADS = [{
  subject: 'urn:test:1689-author-threading',
  predicate: 'http://schema.org/name',
  object: '"AuthorThreading"',
  graph: 'did:dkg:context-graph:1',
}];

async function publishWithSeal(options: { withSeal: boolean }) {
  const payer = new ethers.Wallet(PAYER_KEY);
  const author = new ethers.Wallet(AUTHOR_KEY);
  const chain = new PlanRecordingChain(payer);
  const publisher = new DKGPublisher({
    store: new OxigraphStore(),
    chain: chain as unknown as ChainAdapter,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    publisherAddress: payer.address,
    publisherNodeIdentityId: 1n,
  });

  const seal = options.withSeal
    ? await buildSeal({
      quads: QUADS,
      author,
      contextGraphId: '1',
      ctx: mockSealCtx({ chainId: 31337n, kav10Address: KAV10_ADDRESS }),
    })
    : undefined;

  // An unsealed on-chain publish is REJECTED — but only at dkg-publisher.ts:3744,
  // which runs AFTER planning. The plan request is therefore already recorded by
  // the time it throws, and that recorded request is exactly what this file
  // inspects, so the rejection is captured rather than propagated.
  const outcome = await publisher.publish({
    contextGraphId: '1',
    quads: QUADS,
    v10ACKProvider: mockChainStubACKProvider(),
    ...(seal ? { precomputedAttestation: seal } : {}),
  }).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  return { chain, payer, author, outcome };
}

describe('#1689 the seal author reaches the chain publish-plan request', () => {
  it('forwards precomputedAttestation.authorAddress as attestedAuthorAddress, with a DISTINCT payer', async () => {
    const { chain, payer, author, outcome } = await publishWithSeal({ withSeal: true });

    // A sealed publish must actually succeed — otherwise this could pass while
    // planning ran on a path that never reaches a real publish.
    expect(outcome.ok).toBe(true);
    expect(chain.planRequests).toHaveLength(1);
    const request = chain.planRequests[0]!;

    // THE assertion the adversary found missing. Deleting the forwarding line in
    // `dkg-publisher.ts` makes this `undefined`, and nothing else in the repo
    // notices — including a full type-check.
    expect(request.attestedAuthorAddress?.toLowerCase()).toBe(author.address.toLowerCase());

    // And the two principals really are different, so this cannot pass by the
    // author and payer coincidentally being the same wallet — which is the
    // degenerate case where #1689 has nothing to fix.
    expect(request.publisherAddress?.toLowerCase()).toBe(payer.address.toLowerCase());
    expect(request.attestedAuthorAddress?.toLowerCase())
      .not.toBe(request.publisherAddress?.toLowerCase());
  });

  it('omits attestedAuthorAddress when the publish carries no seal', async () => {
    // The negative half: routes with no precomputed attestation must leave the
    // field absent so the adapter's admission gate degrades to the payer-only
    // check and issues no extra RPC. A forwarding line that hardcoded some
    // address instead of reading the seal would fail here.
    const { chain, outcome } = await publishWithSeal({ withSeal: false });

    // Planning happened (and recorded), then the seal requirement rejected it.
    expect(outcome.ok).toBe(false);
    expect(chain.planRequests).toHaveLength(1);
    expect(chain.planRequests[0]!.attestedAuthorAddress).toBeUndefined();
  });
});
