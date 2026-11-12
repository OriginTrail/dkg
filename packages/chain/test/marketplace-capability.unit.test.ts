// SPDX-License-Identifier: Apache-2.0
/**
 * The marketplace of each chain adapter (marketplace.ts): the EVM adapter and
 * the mock answer with themselves, carrying every method a buyer or seller
 * calls, and an adapter with no chain has none.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter, MockChainAdapter, NoChainAdapter, marketplaceChainOf } from '../src/index.js';

/** The marketplace's own methods, then the methods of the rest of the adapter that it reads. */
const MARKETPLACE_METHODS = [
  'getMarketplaceContracts', 'getEpochTimes',
  'setServiceSpending', 'addBuyer', 'removeBuyer', 'setBuyerLimits', 'advanceGrantNonce',
  'signBuyerGrant', 'fundFromAccount', 'topUpFromAccount', 'previewCost', 'currentWindowAllowance',
  'fundFromWallet', 'topUpFromWallet', 'approveServiceSubscriptionsWallet', 'getServiceSubscriptionsWalletAllowance',
  'getSubscription', 'getBudgets', 'subscriptionExists', 'getGrant', 'grantEnd', 'grantNonce', 'getServiceSpending',
  'maxBudgetsPerSubscription', 'getAccountBuyers', 'listBuyerAccounts',
  'submitReceiptBatch', 'rebroadcastReceiptBatch', 'getReceiptBatchOutcome', 'listReceiptsLanded', 'budgetLeft', 'stakeFactor', 'epochPool', 'queryInferenceGross',
  'batchState', 'nonceWord', 'budgetUsed', 'fundingIn', 'getEpochTotals', 'getNodeEpoch',
  'getShardingTableNodeId', 'getNodeEpochScore', 'profileExists', 'getNodeStake', 'getMinimumStake',
  'getProtocolTreasury', 'getWalletBalances', 'getMinedNonce', 'getBaseFee', 'extendKnowledgeAssetLifetime',
] as const;
const ADAPTER_METHODS = [
  'getPublishingConvictionAccountInfo', 'getConvictionAccountLockDurationEpochs', 'getPublishingConvictionAgents',
  'listNodePublishingConvictionAccounts', 'getPublishingConvictionContracts',
  'getIdentityId', 'getIdentityIdForAddress', 'isShardingTableMember', 'verifyACKIdentityDetailed', 'signTypedDataAs',
  'getKnowledgeAssetUpdateContext',
] as const;

const SIGNER = ethers.Wallet.createRandom();
// Constructing the adapter reads nothing from its RPC; no test here calls a method.
const evm = () => new EVMChainAdapter({
  rpcUrl: 'http://127.0.0.1:1',
  privateKey: SIGNER.privateKey,
  hubAddress: '0x0000000000000000000000000000000000000001',
  chainId: 'evm:31337',
  allowNoAdminSigner: true,
  staticNetwork: false,
});
const mock = () => new MockChainAdapter('mock:31337', SIGNER.address);

describe('the marketplace of a chain adapter', () => {
  it.each([['the EVM adapter', evm], ['the mock', mock]] as const)(
    'is %s itself, with every method a buyer or seller calls',
    (_name, make) => {
      const chain = make();
      const marketplace = marketplaceChainOf(chain);
      expect(marketplace).toBe(chain);
      for (const method of [...MARKETPLACE_METHODS, ...ADAPTER_METHODS]) {
        expect(typeof (marketplace as unknown as Record<string, unknown>)[method], method).toBe('function');
      }
    },
  );

  it('is null with no chain configured', () => {
    expect(marketplaceChainOf(new NoChainAdapter())).toBeNull();
  });
});
