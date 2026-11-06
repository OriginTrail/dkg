/**
 * DKGAgent facade for Conviction Account service spending (OT-RFC-27): every
 * method answers `null` when the chain adapter lacks the capability (the
 * no-chain adapter lacks it entirely) and passes through to the adapter
 * otherwise, with its arguments, results and typed refusals untouched.
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import {
  EVMChainAdapter,
  MockChainAdapter,
  NoChainAdapter,
  ConvictionServiceRevertError,
  SERVICE_ASSIGNMENT_TYPES,
  type CaAssignmentTerms,
  type CaFundingRequest,
} from '@origintrail-official/dkg-chain';

const TRAC = 10n ** 18n;
const DAY = 86_400;
const T0 = 20_000 * DAY;

async function makeAgent(chain: MockChainAdapter | NoChainAdapter): Promise<DKGAgent> {
  return DKGAgent.create({
    name: 'CaFacade',
    listenHost: '127.0.0.1',
    listenPort: 0,
    chainAdapter: chain,
    nodeRole: 'core',
  });
}

/** Every facade method, with arguments of the right shape. */
function calls(accountId: bigint, terms: CaAssignmentTerms, request: CaFundingRequest, assignee: string) {
  return {
    getConvictionServiceContracts: [],
    getConvictionServiceWindowAllowance: [accountId],
    getConvictionServiceAssignmentNonce: [accountId],
    setConvictionServiceSpending: [accountId, true],
    signConvictionServiceConsent: [terms],
    assignConvictionServiceBuyer: [terms, { assignee: '0x1234' }, 'owner'],
    revokeConvictionServiceBuyer: [accountId, assignee],
    updateConvictionServiceCaps: [accountId, assignee, terms],
    advanceConvictionServiceNonce: [accountId],
    listConvictionServiceAssignments: [accountId],
    listConvictionServiceAccountsByAssignee: [assignee],
    getConvictionServiceLabels: [accountId, 20_000, 20_001],
    fundServicePeriodFromConviction: [request],
    getServicePeriod: [ethers.ZeroHash],
    listServicePeriods: [accountId, 0, 10],
  } as const satisfies Partial<Record<keyof DKGAgent, readonly unknown[]>>;
}

describe('DKGAgent Conviction Account service facade', () => {
  const owner = ethers.Wallet.createRandom();
  const buyer = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);

  function fixtures(accountId: bigint) {
    const terms: CaAssignmentTerms = {
      accountId,
      assignee: buyer.address,
      maxCostPerPeriod: 25n * TRAC,
      maxInferenceCostPerPeriod: 25n * TRAC,
      maxQueryCostPerPeriod: 0n,
      maxCostPerWindow: 100n * TRAC,
      maxTotalCost: 1000n * TRAC,
      maxPeriodSeconds: 31 * DAY,
      expiresAt: T0 + 60 * DAY,
      nonce: 0n,
    };
    const request: CaFundingRequest = {
      accountId,
      periodId: ethers.toBeHex(0xa1, 32),
      sessionKey: ethers.ZeroAddress,
      periodSeconds: 30 * DAY,
      planDigest: ethers.toBeHex(0xd1, 32),
      buckets: [{ bucketId: ethers.toBeHex(1, 32), serviceClass: 1, value: 40n * TRAC, maxAskWeiPerUnit: 1_000n }],
    };
    return { terms, request };
  }

  it('answers null from every method on the no-chain adapter, which lacks the capability', async () => {
    const agent = await makeAgent(new NoChainAdapter());
    expect(agent.supportsConvictionService).toBe(false);
    const { terms, request } = fixtures(1n);
    for (const [method, args] of Object.entries(calls(1n, terms, request, buyer.address))) {
      await expect((agent as any)[method](...args), method).resolves.toBeNull();
    }
    await expect(agent.getConvictionServiceStatus(1n)).resolves.toBeNull();
    expect(agent.getConvictionServiceBuyerAddress()).toBeNull();
  });

  it('answers null from a method the adapter lacks, and passes through the ones it has', async () => {
    const chain = new MockChainAdapter('mock:31337', owner.address);
    Reflect.defineProperty(chain, 'listConvictionServiceAccountsByAssignee', { value: undefined });
    const agent = await makeAgent(chain);
    expect(agent.supportsConvictionService).toBe(true);
    await expect(agent.listConvictionServiceAccountsByAssignee(buyer.address)).resolves.toBeNull();
    await expect(agent.getConvictionServiceAssignmentNonce(1n)).resolves.toBe(0n);
  });

  it('passes every call through with its arguments and returns the adapter\'s answer', async () => {
    const chain = new MockChainAdapter('mock:31337', owner.address);
    const agent = await makeAgent(chain);
    const { terms, request } = fixtures(7n);
    for (const [method, args] of Object.entries(calls(7n, terms, request, buyer.address))) {
      const answer = { method };
      const spy = vi.spyOn(chain as any, method).mockResolvedValue(answer);
      await expect((agent as any)[method](...args), method).resolves.toBe(answer);
      expect(spy, method).toHaveBeenCalledWith(...args);
    }
    const buyerKey = vi.spyOn(chain, 'getConvictionServiceBuyerAddress').mockReturnValue(buyer.address);
    expect(agent.getConvictionServiceBuyerAddress()).toBe(buyer.address);
    expect(buyerKey).toHaveBeenCalledOnce();
  });

  it('always reads the status fresh', async () => {
    const chain = new MockChainAdapter('mock:31337', owner.address);
    const status = vi.spyOn(chain, 'getConvictionServiceStatus');
    const agent = await makeAgent(chain);
    const { accountId } = await chain.createPublishingConvictionAccount(1_200_000n * TRAC);
    expect((await agent.getConvictionServiceStatus(accountId))!.owner).toBe(owner.address);
    expect(status).toHaveBeenCalledWith(accountId, { fresh: true });
  });

  it('runs an assignment and a funding through the adapter, and lets its refusals through typed', async () => {
    const chain = new MockChainAdapter('mock:31337', owner.address);
    chain.configureMockConvictionService({ now: T0, buyer });
    const agent = await makeAgent(chain);
    const { accountId } = await chain.createPublishingConvictionAccount(1_200_000n * TRAC);
    const { terms, request } = fixtures(accountId);

    await agent.setConvictionServiceSpending(accountId, true);
    const consent = (await agent.signConvictionServiceConsent(terms))!;
    const { domain } = (await agent.getConvictionServiceContracts())!;
    expect(ethers.verifyTypedData(domain, SERVICE_ASSIGNMENT_TYPES, { ...terms }, consent.signature)).toBe(buyer.address);
    expect((await agent.assignConvictionServiceBuyer(terms, { assignee: consent.signature }, 'owner'))!.digest).toBe(consent.digest);
    const funded = (await agent.fundServicePeriodFromConviction(request))!;
    expect(funded).toMatchObject({ existing: false, cost: 10n * TRAC });
    expect((await agent.fundServicePeriodFromConviction(request))!.existing).toBe(true);
    expect((await agent.listConvictionServiceAccountsByAssignee(buyer.address))!.map((a) => a.accountId)).toEqual([accountId]);

    const refused = await agent.setConvictionServiceSpending(accountId, true).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ConvictionServiceRevertError);
    expect(refused).toMatchObject({ revertName: 'ServiceSpendingUnchanged', kind: 'conflict' });
  });

  it('hands chainConfig.convictionServiceBuyerAddress to the EVM adapter it builds', async () => {
    const primary = ethers.Wallet.createRandom();
    const second = ethers.Wallet.createRandom();
    const build = (convictionServiceBuyerAddress?: string) => DKGAgent.create({
      name: 'CaBuyerKeyConfig',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainConfig: {
        rpcUrl: 'http://127.0.0.1:0',
        hubAddress: ethers.ZeroAddress,
        operationalKeys: [primary.privateKey, second.privateKey],
        ...(convictionServiceBuyerAddress === undefined ? {} : { convictionServiceBuyerAddress }),
      },
      nodeRole: 'edge',
    });
    const configured = await build(second.address.toLowerCase());
    expect((configured as any).chain).toBeInstanceOf(EVMChainAdapter);
    expect(configured.getConvictionServiceBuyerAddress()).toBe(second.address);
    expect((await build()).getConvictionServiceBuyerAddress()).toBe(primary.address);
    // A key the node holds no signer for: the buyer routes answer 503.
    expect((await build(ethers.Wallet.createRandom().address)).getConvictionServiceBuyerAddress()).toBeNull();
  });
});
