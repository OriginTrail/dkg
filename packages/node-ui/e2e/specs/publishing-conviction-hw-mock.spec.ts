import { expect, type Locator, type Page, type Route, test } from '@playwright/test';

const WALLET = '0x1111111111111111111111111111111111111111';
const HOT_WALLET = '0x2222222222222222222222222222222222222222';
const NFT = '0x00000000000000000000000000000000000000a1';
const TOKEN = '0x00000000000000000000000000000000000000b2';
const APPROVE_HASH = `0x${'a'.repeat(64)}`;
const CREATE_HASH = `0x${'c'.repeat(64)}`;
const TOP_UP_HASH = `0x${'d'.repeat(64)}`;
const REGISTER_HASH = `0x${'e'.repeat(64)}`;
const DEREGISTER_HASH = `0x${'f'.repeat(64)}`;
const ACCOUNT_ID = '7';
const REGISTERED_AGENT = '0x3333333333333333333333333333333333333333';
const MOCK_RPC_PATH = '/mock-pca-rpc';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;
const MAX_ALLOWANCE = (1n << 96n) - 1n;
const CREATE_SELECTOR = '0xb034185b';
const TOP_UP_SELECTOR = '0x0382effb';
const REGISTER_SELECTOR = '0x047d4c27';
const DEREGISTER_SELECTOR = '0xf59c6b28';

type WalletMode = 'auto' | 'reject-approve' | 'reject-create';

declare global {
  interface Window {
    __PCA_HW_MOCK__?: {
      setMode(mode: WalletMode): void;
      setChain(chainId: number): void;
      calls: string[];
    };
  }
}

function topicAddress(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function uint256(value: bigint | number | string): string {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

function quantity(value: bigint | number | string): string {
  return `0x${BigInt(value).toString(16)}`;
}

function pcaSnapshot(owner = WALLET) {
  const now = Math.floor(Date.now() / 1000);
  return {
    accountId: ACCOUNT_ID,
    owner,
    committedTRAC: '50000000000000000000000',
    committedTRACTrac: '50000.0',
    baseEpochAllowance: '50000000000000000000',
    topUpBuffer: '0',
    topUpBufferTrac: '0.0',
    createdAtEpoch: 1,
    expiresAtEpoch: 100,
    createdAtTimestamp: now - 60,
    expiresAtTimestamp: now + 60 * 60 * 24 * 365,
    discountBps: 500,
    agentCount: 0,
    lastSettledWindow: 0,
    fullySwept: false,
    primaryNode: '11',
    remainingAllowance: '50000000000000000000',
    remainingAllowanceTrac: '50.0',
    currentEpoch: 2,
  };
}

function receipt(hash: string) {
  const nftHash = [CREATE_HASH, TOP_UP_HASH, REGISTER_HASH, DEREGISTER_HASH].includes(hash);
  return {
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: `0x${'b'.repeat(64)}`,
    blockNumber: '0x123',
    from: WALLET,
    to: nftHash ? NFT : TOKEN,
    cumulativeGasUsed: '0x5208',
    effectiveGasPrice: '0x1',
    gasUsed: '0x5208',
    contractAddress: null,
    logsBloom: `0x${'0'.repeat(512)}`,
    status: '0x1',
    type: '0x2',
    logs: hash === CREATE_HASH
      ? [
          {
            address: NFT,
            topics: [TRANSFER_TOPIC, ZERO_TOPIC, topicAddress(WALLET), uint256(ACCOUNT_ID)],
            data: '0x',
            blockNumber: '0x123',
            transactionHash: hash,
            transactionIndex: '0x0',
            blockHash: `0x${'b'.repeat(64)}`,
            logIndex: '0x0',
            removed: false,
          },
        ]
      : [],
  };
}

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installMockApis(page: Page) {
  let allowanceCalls = 0;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === '/api/status') {
      return fulfillJson(route, 200, {
        name: 'Mock PCA Core',
        nodeRole: 'core',
        hasIdentity: true,
        identityId: '11',
        chainId: 'base:84532',
        networkName: 'Base Sepolia',
        blockExplorerUrl: 'https://sepolia.basescan.org',
        connectedPeers: 1,
        peerCount: 1,
        synced: true,
      });
    }
    if (path === '/api/agent/identity') {
      return fulfillJson(route, 200, {
        agentAddress: HOT_WALLET,
        agentDid: 'did:dkg:mock',
        name: 'Mock Agent',
        peerId: 'mock-peer',
        nodeIdentityId: '11',
      });
    }
    if (path === '/api/notifications') {
      return fulfillJson(route, 200, { notifications: [], badgeCount: 0 });
    }
    if (path === '/api/context-graph/list') {
      return fulfillJson(route, 200, { contextGraphs: [] });
    }
    if (path === '/api/wallets/balances') {
      return fulfillJson(route, 200, {
        wallets: [HOT_WALLET],
        balances: [{ address: HOT_WALLET, eth: '1.0', trac: '100000.0', symbol: 'ETH' }],
        chainId: 'base:84532',
        rpcUrl: 'http://127.0.0.1/mock',
        symbol: 'ETH',
      });
    }
    if (path === '/api/pca/contracts') {
      return fulfillJson(route, 200, {
        nft: NFT,
        token: TOKEN,
        chainId: 'base:84532',
        rpcUrls: [`${url.origin}${MOCK_RPC_PATH}`],
      });
    }
    if (path === '/api/pca/designatable-nodes') {
      return fulfillJson(route, 200, {
        nodes: [
          {
            nodeId: `0x${'1'.repeat(64)}`,
            identityId: '11',
            stake: '100000000000000000000000',
            ask: '1000000000000000000',
          },
        ],
        total: 1,
      });
    }
    if (path === '/api/pca/mine') {
      return fulfillJson(route, 200, { accounts: [] });
    }
    if (path.startsWith('/api/pca/agent/')) {
      return fulfillJson(route, 200, { agent: decodeURIComponent(path.split('/').pop() ?? ''), accountId: null });
    }
    if (path === '/api/pca/0') {
      return fulfillJson(route, 404, { error: 'Unknown account', code: 'UnknownAccount' });
    }
    if (path === `/api/pca/${ACCOUNT_ID}`) {
      const snapshot = pcaSnapshot();
      if (url.searchParams.has('key')) {
        return fulfillJson(route, 200, {
          ...snapshot,
          probedKey: { key: url.searchParams.get('key'), registered: false, adapterSupported: true },
        });
      }
      return fulfillJson(route, 200, snapshot);
    }
    if (path === `/api/pca/${ACCOUNT_ID}/agents`) {
      return fulfillJson(route, 200, { accountId: ACCOUNT_ID, agents: [REGISTERED_AGENT] });
    }

    return fulfillJson(route, 200, {});
  });

  await page.route(`**${MOCK_RPC_PATH}`, async (route) => {
    const request = route.request();
    const payload = await request.postDataJSON();
    const calls = Array.isArray(payload) ? payload : [payload];
    const results = calls.map((call) => {
      const method = call.method as string;
      const params = (call.params ?? []) as unknown[];
      let result: unknown = '0x';
      if (method === 'eth_chainId') result = quantity(84532);
      if (method === 'eth_blockNumber') result = '0x123';
      if (method === 'eth_getTransactionReceipt') result = receipt(String(params[0]));
      if (method === 'eth_call') {
        const tx = params[0] as { to?: string; data?: string };
        const data = (tx.data ?? '').toLowerCase();
        if (data.startsWith('0xdd62ed3e')) {
          allowanceCalls += 1;
          result = allowanceCalls === 1 ? uint256(0) : uint256(MAX_ALLOWANCE);
        } else if (data.startsWith('0x70a08231')) {
          result = uint256(1);
        } else if (data.startsWith('0x2f745c59')) {
          result = uint256(ACCOUNT_ID);
        } else {
          result = uint256(0);
        }
      }
      return { jsonrpc: '2.0', id: call.id, result };
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(Array.isArray(payload) ? results : results[0]),
    });
  });
}

async function installMockWallet(page: Page, initialChainId = 84532) {
  await page.addInitScript(
    ({ wallet, nft, token, approveHash, createHash, topUpHash, registerHash, deregisterHash, chainId, selectors }) => {
      let mode: WalletMode = 'auto';
      let activeChain = chainId;
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const calls: string[] = [];
      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          calls.push(method);
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet];
          if (method === 'eth_chainId') return `0x${activeChain.toString(16)}`;
          if (method === 'wallet_switchEthereumChain') {
            const target = (params?.[0] as { chainId?: string } | undefined)?.chainId;
            if (target) {
              activeChain = parseInt(target, 16);
              for (const fn of listeners.get('chainChanged') ?? []) fn(target);
            }
            return null;
          }
          if (method === 'eth_sendTransaction') {
            const tx = (params?.[0] ?? {}) as { to?: string; data?: string };
            const to = tx.to?.toLowerCase();
            const data = (tx.data ?? '').toLowerCase();
            if (to === token.toLowerCase()) {
              if (mode === 'reject-approve') {
                const err = new Error('User rejected approve') as Error & { code: number };
                err.code = 4001;
                throw err;
              }
              return approveHash;
            }
            if (to === nft.toLowerCase()) {
              if (data.startsWith(selectors.create) && mode === 'reject-create') {
                const err = new Error('User rejected create') as Error & { code: number };
                err.code = 4001;
                throw err;
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
              if (data.startsWith(selectors.create)) return createHash;
              if (data.startsWith(selectors.topUp)) return topUpHash;
              if (data.startsWith(selectors.register)) return registerHash;
              if (data.startsWith(selectors.deregister)) return deregisterHash;
            }
          }
          throw new Error(`Mock wallet: unhandled ${method}`);
        },
        on(event: string, handler: (...args: unknown[]) => void) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(handler);
        },
        removeListener(event: string, handler: (...args: unknown[]) => void) {
          listeners.get(event)?.delete(handler);
        },
      };
      const detail = {
        info: {
          uuid: 'pca-hw-mock-wallet',
          name: 'Mock Hardware Wallet',
          icon: 'data:,',
          rdns: 'io.origintrail.pca-hw-mock',
        },
        provider,
      };
      const announce = () => {
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
      };
      window.addEventListener('eip6963:requestProvider', announce);
      queueMicrotask(announce);
      window.__PCA_HW_MOCK__ = {
        calls,
        setMode(nextMode: WalletMode) {
          mode = nextMode;
        },
        setChain(nextChainId: number) {
          activeChain = nextChainId;
          for (const fn of listeners.get('chainChanged') ?? []) fn(`0x${nextChainId.toString(16)}`);
        },
      };
    },
    {
      wallet: WALLET,
      nft: NFT,
      token: TOKEN,
      approveHash: APPROVE_HASH,
      createHash: CREATE_HASH,
      topUpHash: TOP_UP_HASH,
      registerHash: REGISTER_HASH,
      deregisterHash: DEREGISTER_HASH,
      chainId: initialChainId,
      selectors: {
        create: CREATE_SELECTOR,
        topUp: TOP_UP_SELECTOR,
        register: REGISTER_SELECTOR,
        deregister: DEREGISTER_SELECTOR,
      },
    },
  );
}

async function openPca(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('pca-launch-btn')).toBeVisible();
  await page.getByTestId('pca-launch-btn').click();
  await expect(page.getByTestId('pca-landing')).toBeVisible();
}

async function connectWallet(page: Page, root?: Locator) {
  const scope = root ?? page.locator('body');
  await expect(scope.getByTestId('pca-wallet-connect')).toBeVisible();
  await scope.getByTestId('pca-wallet-connect').click();
  await expect(page.getByText(/via Mock Hardware Wallet/i).first()).toBeVisible();
}

async function openWalletManagedPca(page: Page) {
  await openPca(page);
  await connectWallet(page);
  const walletCard = page.locator('[data-testid="pca-account-card"][data-owner-mode="wallet"]').filter({ hasText: `PCA #${ACCOUNT_ID}` });
  await expect(walletCard).toBeVisible();
  await walletCard.getByRole('button', { name: 'Manage' }).click();
  await expect(page.getByTestId('pca-detail')).toBeVisible();
}

test.describe('Publishing Conviction hardware-wallet mock lane', () => {
  test.beforeEach(async ({ page }) => {
    await installMockApis(page);
    await installMockWallet(page);
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test('connects a wallet and discovers connected-wallet-owned PCAs via ERC721Enumerable', async ({ page }) => {
    await openPca(page);
    await connectWallet(page);

    const walletCard = page.locator('[data-testid="pca-account-card"][data-owner-mode="wallet"]').filter({ hasText: `PCA #${ACCOUNT_ID}` });
    await expect(walletCard).toBeVisible();
    await expect(walletCard).toContainText(/wallet-managed/i);
    await expect(page.getByTestId('pca-discovered-strip')).toHaveCount(0);
  });

  test('blocks hardware create on wrong network until the wallet switches chains', async ({ page }) => {
    await openPca(page);
    await page.evaluate(() => window.__PCA_HW_MOCK__?.setChain(1));
    await page.getByTestId('pca-create-btn').click();
    await page.getByLabel('Hardware wallet (recommended)').check();
    await connectWallet(page, page.getByTestId('pca-create-modal'));
    await page.getByTestId('pca-create-tokens').fill('50000');

    await expect(page.getByText(/wrong network/i).first()).toBeVisible();
    await expect(page.getByTestId('pca-create-submit')).toBeDisabled();

    await page.getByTestId('pca-create-owner-key').getByRole('button', { name: /^Switch$/ }).click();
    await expect(page.getByText(/wrong network/i)).toHaveCount(0);
    await expect(page.getByTestId('pca-create-submit')).toBeEnabled();
  });

  test('runs approve-to-create progress and extracts the minted account id from the NFT Transfer', async ({ page }) => {
    await openPca(page);
    await page.getByTestId('pca-create-btn').click();
    await page.getByLabel('Hardware wallet (recommended)').check();
    await connectWallet(page, page.getByTestId('pca-create-modal'));
    await page.getByTestId('pca-create-tokens').fill('50000');
    await expect(page.getByTestId('pca-create-submit')).toBeEnabled();

    await page.getByTestId('pca-create-submit').click();

    await expect(page.getByText(/Confirm on your device/i).first()).toBeVisible();
    await expect(page.getByText(/Approve exact TRAC allowance/i)).toBeVisible();
    await expect(page.getByText(/Sign Create PCA/i)).toBeVisible();
    await expect(page.getByTestId('pca-create-success')).toContainText(`Account #${ACCOUNT_ID}`, { timeout: 20_000 });
    await expect(page.getByTestId('pca-create-success')).toContainText(/0\/100 wallets approved/i);
  });

  test('keeps the modal open and reports post-approve create rejection without claiming nothing changed', async ({ page }) => {
    await openPca(page);
    await page.evaluate(() => window.__PCA_HW_MOCK__?.setMode('reject-create'));
    await page.getByTestId('pca-create-btn').click();
    await page.getByLabel('Hardware wallet (recommended)').check();
    await connectWallet(page, page.getByTestId('pca-create-modal'));
    await page.getByTestId('pca-create-tokens').fill('50000');

    await page.getByTestId('pca-create-submit').click();

    await expect(page.getByTestId('pca-create-modal')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: /allowance/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('alert').filter({ hasText: /account not created/i })).toBeVisible();
    await expect(page.getByText(/nothing changed/i)).toHaveCount(0);
  });

  test('wallet-managed top-up signs through the connected wallet and shows the top-up result', async ({ page }) => {
    await openWalletManagedPca(page);
    await page.getByLabel('Top-up amount in TRAC').fill('10');
    await page.getByTestId('pca-topup-btn').click();

    await expect(page.locator('.v10-pca-device-progress-row').filter({ hasText: 'Sign top-up' })).toBeVisible();
    await expect(page.getByTestId('pca-action-result')).toContainText(/Added 10(\.00)? TRAC/i, { timeout: 20_000 });
  });

  test('wallet-managed approve registers a publishing wallet through the connected wallet', async ({ page }) => {
    await openPca(page);
    await connectWallet(page);
    const walletCard = page.locator('[data-testid="pca-account-card"][data-owner-mode="wallet"]').filter({ hasText: `PCA #${ACCOUNT_ID}` });
    await walletCard.getByRole('button', { name: 'Approve wallets' }).click();
    await expect(page.getByTestId('pca-approve-modal')).toBeVisible();
    await page.getByTestId('pca-approve-address').fill('0x4444444444444444444444444444444444444444');

    await page.getByTestId('pca-approve-submit').click();

    await expect(page.getByText(/Confirm on your device \(1 of 1\)/i)).toBeVisible();
    await expect(page.getByTestId('pca-approve-modal')).toContainText(/approved on-chain/i, { timeout: 20_000 });
  });

  test('wallet-managed remove deregisters a publishing wallet through the connected wallet', async ({ page }) => {
    await openWalletManagedPca(page);
    await expect(page.getByRole('button', { name: `Remove ${REGISTERED_AGENT}` })).toBeVisible();
    await page.getByRole('button', { name: `Remove ${REGISTERED_AGENT}` }).click();
    await page.getByTestId('pca-deregister-btn').click();

    await expect(page.getByText(/Sign remove wallet/i)).toBeVisible();
    await expect(page.getByTestId('pca-remove-result')).toContainText(`Removed ${REGISTERED_AGENT}`, { timeout: 20_000 });
  });
});
