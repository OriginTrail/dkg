import type {
  PcaSnapshot,
  CreatePcaResult,
  PcaTopUpResult,
  PcaAddAgentResult,
  PcaSettleResult,
} from '../api.js';
import type { ConvictionCostCovered } from '../components/Pca/index.js';

// E3 — shared PCA fixtures for unit/component tests (and Storybook-style manual
// QA). One healthy baseline + the health variants, plus the B8 CostCovered
// sample. Wei amounts are decimal strings; `*Timestamp` are unix SECONDS.

const NOW_SEC = Math.floor(Date.now() / 1000);
const DAY = 86_400;

export const MOCK_OWNER = '0x9A3f000000000000000000000000000000000E41D';
export const MOCK_POOL_WALLET = '0x5C1b000000000000000000000000000000000077A2';
export const MOCK_EDGE_WALLET = '0x71D4000000000000000000000000000000009Ac2';

/** A healthy 100k-TRAC / 30% PCA expiring far in the future. */
export function makePcaSnapshot(over: Partial<PcaSnapshot> = {}): PcaSnapshot {
  return {
    accountId: '7',
    owner: MOCK_OWNER,
    committedTRAC: '100000000000000000000000',
    committedTRACTrac: '100000.0',
    baseEpochAllowance: '850000000000000000000',
    topUpBuffer: '12500000000000000000000',
    topUpBufferTrac: '12500.0',
    createdAtEpoch: 1200,
    expiresAtEpoch: 1560,
    createdAtTimestamp: NOW_SEC - 14 * DAY,
    expiresAtTimestamp: NOW_SEC + 46 * DAY,
    discountBps: 3000,
    agentCount: 4,
    lastSettledWindow: 1283,
    fullySwept: false,
    ...over,
  };
}

export const PCA_FIXTURES = {
  healthy: makePcaSnapshot(),
  expiring: makePcaSnapshot({ accountId: '8', expiresAtTimestamp: NOW_SEC + 3 * DAY }),
  expired: makePcaSnapshot({ accountId: '9', expiresAtTimestamp: NOW_SEC - 2 * DAY }),
  swept: makePcaSnapshot({ accountId: '10', fullySwept: true }),
  capNear: makePcaSnapshot({ accountId: '11', agentCount: 96 }),
  // No spendable budget — the P2 "insolvent" health (not derived in P0).
  insolvent: makePcaSnapshot({ accountId: '12', topUpBuffer: '0', baseEpochAllowance: '0' }),
} satisfies Record<string, PcaSnapshot>;

/** A B8 CostCovered event sample (baseCost 1000 → discountedCost 700 ⇒ 30%). */
export const MOCK_COST_COVERED: ConvictionCostCovered = {
  accountId: '7',
  // P2 — epoch is a JSON number (uint40, fits safely in Number); the wei cost fields
  // stay decimal strings. (Supersedes the P0 L10 all-strings note for epoch.)
  epoch: 1284,
  baseCost: '1000',
  discountedCost: '700',
  drawnFromEpoch: '700',
  drawnFromTopUp: '0',
};

// L10 — shared write-route response fixtures so tests/bench stop hand-rolling
// (and drifting) the create/top-up/approve/settle 200 shapes.
export const MOCK_CREATE_RESULT: CreatePcaResult = {
  accountId: '7',
  txHash: '0xcreate0000000000000000000000000000000000000000000000000000000001',
  blockNumber: 12_345,
  committedTokens: '100000.0',
};

export const MOCK_TOPUP_RESULT: PcaTopUpResult = {
  accountId: '7',
  addedTokens: '5000.0',
  txHash: '0xtopup00000000000000000000000000000000000000000000000000000000002',
  blockNumber: 12_400,
};

export const MOCK_ADD_AGENT_RESULT: PcaAddAgentResult = {
  accountId: '7',
  agent: MOCK_POOL_WALLET,
  registered: true,
  adapterSupported: true,
  txHash: '0xagent00000000000000000000000000000000000000000000000000000000003',
  blockNumber: 12_410,
};

export const MOCK_SETTLE_RESULT: PcaSettleResult = {
  accountId: '7',
  settled: true,
  txHash: '0xsettle0000000000000000000000000000000000000000000000000000000004',
  blockNumber: 12_420,
};

/** `/api/wallets/balances` shape on Base Sepolia (one funded core wallet). */
export const MOCK_WALLETS_BALANCES = {
  wallets: [MOCK_OWNER],
  balances: [{ address: MOCK_OWNER, eth: '0.42', trac: '184200', symbol: 'TRAC' }],
  chainId: '84532',
  rpcUrl: null as string | null,
};
