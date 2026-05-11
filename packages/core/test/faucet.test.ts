import { describe, it, expect, vi } from 'vitest';
import { getFundableWalletAddresses, requestFaucetFunding } from '../src/faucet.js';

interface FetchCall {
  url: string | URL | Request;
  init: RequestInit;
}

function createTrackingFetch(status: number, body: unknown): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url as any, init: init as RequestInit });
    return new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      {
        status,
        statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  return { fetch: fn as typeof globalThis.fetch, calls };
}

describe('getFundableWalletAddresses', () => {
  it('returns the admin wallet before operational wallets for the current shape', () => {
    const result = getFundableWalletAddresses({
      adminWallet: { address: '0xAdmin' },
      wallets: [
        { address: '0xWallet1' },
        { address: '0xWallet2' },
        { address: '0xWallet3' },
      ],
    });

    expect(result).toEqual(['0xAdmin', '0xWallet1', '0xWallet2', '0xWallet3']);
  });

  it('returns only operational wallets for the legacy array shape', () => {
    const result = getFundableWalletAddresses([
      { address: '0xWallet1' },
      { address: '0xWallet2' },
    ]);

    expect(result).toEqual(['0xWallet1', '0xWallet2']);
  });

  it('returns only operational wallets when adminWallet is missing', () => {
    const result = getFundableWalletAddresses({
      wallets: [
        { address: '0xWallet1' },
        { address: '0xWallet2' },
      ],
    });

    expect(result).toEqual(['0xWallet1', '0xWallet2']);
  });

  it('deduplicates addresses case-insensitively with admin position winning', () => {
    const result = getFundableWalletAddresses({
      adminWallet: { address: '0xAdmin' },
      wallets: [
        { address: '0xadmin' },
        { address: '0xWallet1' },
        { address: '0xwallet1' },
      ],
    });

    expect(result).toEqual(['0xAdmin', '0xWallet1']);
  });

  it('returns an empty list when there are no operational wallet addresses', () => {
    expect(getFundableWalletAddresses({ adminWallet: { address: '0xAdmin' }, wallets: [] }))
      .toEqual([]);
    expect(getFundableWalletAddresses({ adminWallet: { address: '0xAdmin' } }))
      .toEqual([]);
  });

  it('ignores malformed wallet address fields', () => {
    const result = getFundableWalletAddresses({
      adminWallet: { address: 123 },
      wallets: [
        { address: '' },
        { address: null },
        {},
        { address: '0xWallet1' },
      ],
    });

    expect(result).toEqual(['0xWallet1']);
  });
});

describe('requestFaucetFunding', () => {
  it('returns funded amounts on success', async () => {
    const { fetch, calls } = createTrackingFetch(200, {
      summary: { success: 4, failed: 0 },
      results: [
        { chainId: 'eth-sepolia', address: '0xAAA', amount: '0.01', status: 'success' },
        { chainId: 'trac-base', address: '0xAAA', amount: '1000', status: 'success' },
        { chainId: 'eth-sepolia', address: '0xBBB', amount: '0.01', status: 'success' },
        { chainId: 'trac-base', address: '0xBBB', amount: '1000', status: 'success' },
      ],
    });
    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'v10_base_sepolia',
      ['0xAAA', '0xBBB'], 'test-node', fetch,
    );
    expect(result.success).toBe(true);
    expect(result.funded).toEqual(['0.01 ETH', '1000 TRAC', '0.01 ETH', '1000 TRAC']);
    expect(result.fundedWallets).toEqual(['0xAAA', '0xBBB']);
    expect(result.failedWallets).toEqual([]);
    expect(calls).toHaveLength(1);
    const reqBody = JSON.parse(calls[0].init.body as string);
    expect(reqBody.wallets).toEqual(['0xAAA', '0xBBB']);
    expect(reqBody.mode).toBe('v10_base_sepolia');
  });

  it('uses a three-minute timeout for faucet batches', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValue(new AbortController().signal);
    const { fetch } = createTrackingFetch(200, { summary: { success: 0 }, results: [] });
    try {
      await requestFaucetFunding(
        'https://faucet.example.com/fund', 'test', ['0xAAA'], 'timeout-node', fetch,
      );

      expect(timeoutSpy).toHaveBeenCalledWith(180_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('funds wallets in batches of 4', async () => {
    const { fetch, calls } = createTrackingFetch(200, { summary: { success: 1 }, results: [] });
    await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test',
      ['0x1', '0x2', '0x3', '0x4', '0x5'], 'big-node', fetch,
    );
    expect(calls).toHaveLength(2);
    const reqBody = JSON.parse(calls[0].init.body as string);
    expect(reqBody.wallets).toHaveLength(4);
    expect(reqBody.wallets).toEqual(['0x1', '0x2', '0x3', '0x4']);
    const secondReqBody = JSON.parse(calls[1].init.body as string);
    expect(secondReqBody.wallets).toEqual(['0x5']);
  });

  it('returns error on HTTP failure', async () => {
    const { fetch } = createTrackingFetch(429, 'rate limited');
    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', ['0xAAA'], 'test-node', fetch,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('429');
    expect(result.fundedWallets).toEqual([]);
    expect(result.failedWallets).toEqual(['0xAAA']);
  });

  it('keeps success=true for partial batch success while surfacing the later error', async () => {
    const calls: FetchCall[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url as any, init: init as RequestInit });
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          summary: { success: 8 },
          results: [{ chainId: 'eth-sepolia', amount: '0.01', status: 'success' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('rate limited', { status: 429 });
    }) as typeof globalThis.fetch;

    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test',
      ['0x1', '0x2', '0x3', '0x4', '0x5'], 'partial-node', fetch,
    );

    expect(calls).toHaveLength(2);
    expect(result.success).toBe(true);
    expect(result.funded).toEqual(['0.01 ETH']);
    expect(result.fundedWallets).toEqual(['0x1', '0x2', '0x3', '0x4']);
    expect(result.failedWallets).toEqual(['0x5']);
    expect(result.error).toContain('429');
  });

  it('keeps wallets failed when address-less summaries show only partial transfer success', async () => {
    const { fetch } = createTrackingFetch(200, {
      summary: { success: 1, failed: 3 },
      results: [
        { chainId: 'eth-sepolia', amount: '0.01', status: 'success' },
      ],
    });
    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', ['0x1', '0x2'], 'partial-summary-node', fetch,
    );

    expect(result.success).toBe(true);
    expect(result.fundedWallets).toEqual([]);
    expect(result.failedWallets).toEqual(['0x1', '0x2']);
    expect(result.error).toContain('0x1');
    expect(result.error).toContain('0x2');
  });

  it('uses per-wallet result addresses to report remaining failed wallets', async () => {
    const { fetch } = createTrackingFetch(200, {
      summary: { success: 3, failed: 1 },
      results: [
        { chainId: 'eth-sepolia', address: '0x1', amount: '0.01', status: 'success' },
        { chainId: 'trac-base', address: '0x1', amount: '1000', status: 'success' },
        { chainId: 'eth-sepolia', address: '0x2', amount: '0.01', status: 'success' },
        { chainId: 'trac-base', address: '0x2', amount: '0', status: 'cooldown_active' },
      ],
    });
    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', ['0x1', '0x2'], 'mixed-node', fetch,
    );

    expect(result.success).toBe(true);
    expect(result.fundedWallets).toEqual(['0x1']);
    expect(result.failedWallets).toEqual(['0x2']);
    expect(result.error).toContain('0x2');
  });

  it('surfaces faucet result reasons when no wallets are funded', async () => {
    const { fetch } = createTrackingFetch(200, {
      summary: { success: 0, failed: 2 },
      results: [
        {
          chainId: 'v10_base_sepolia_eth',
          address: '0x1',
          status: 'cooldown_active',
          error: 'Caller cooldown active until 2026-05-11T19:17:45.000Z',
        },
        {
          chainId: 'v10_base_sepolia_trac',
          address: '0x1',
          status: 'cooldown_active',
          error: 'Caller cooldown active until 2026-05-11T19:17:49.000Z',
        },
      ],
    });
    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', ['0x1'], 'cooldown-node', fetch,
    );

    expect(result.success).toBe(false);
    expect(result.fundedWallets).toEqual([]);
    expect(result.failedWallets).toEqual(['0x1']);
    expect(result.error).toContain('Faucet did not fund all wallets: 0x1');
    expect(result.error).toContain('cooldown_active: Caller cooldown active until 2026-05-11T19:17:45.000Z');
    expect(result.error).toContain('cooldown_active: Caller cooldown active until 2026-05-11T19:17:49.000Z');
  });

  it('returns no-wallets error for empty array', async () => {
    const { fetch, calls } = createTrackingFetch(200, {});
    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', [], 'test-node', fetch,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('no wallets');
    expect(calls).toHaveLength(0);
  });

  it('returns success=false when faucet reports 0 successes', async () => {
    const { fetch } = createTrackingFetch(200, {
      summary: { success: 0, failed: 2 },
      results: [
        { chainId: 'eth-sepolia', amount: '0', status: 'failed' },
        { chainId: 'trac-base', amount: '0', status: 'failed' },
      ],
    });
    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', ['0xAAA'], 'test-node', fetch,
    );
    expect(result.success).toBe(false);
    expect(result.funded).toEqual([]);
  });

  it('rejects network errors before any wallet is funded', async () => {
    const fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof globalThis.fetch;
    await expect(requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', ['0xAAA'], 'test-node', fetch,
    )).rejects.toThrow('ECONNREFUSED');
  });

  it('explains that a first-batch timeout may still complete on-chain', async () => {
    const fetch = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof globalThis.fetch;

    await expect(requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', ['0xAAA'], 'timeout-node', fetch,
    )).rejects.toThrow('funding may still complete');
  });

  it('preserves earlier funded wallets when a later batch throws', async () => {
    const calls: FetchCall[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url as any, init: init as RequestInit });
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          summary: { success: 8 },
          results: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('faucet offline');
    }) as typeof globalThis.fetch;

    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test',
      ['0x1', '0x2', '0x3', '0x4', '0x5'], 'throwing-node', fetch,
    );

    expect(result.success).toBe(true);
    expect(result.fundedWallets).toEqual(['0x1', '0x2', '0x3', '0x4']);
    expect(result.failedWallets).toEqual(['0x5']);
    expect(result.error).toContain('faucet offline');
  });

  it('includes the idempotency seed in the Idempotency-Key without sending callerId', async () => {
    const { fetch, calls } = createTrackingFetch(200, { summary: { success: 0 }, results: [] });
    await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', ['0xAAA'], 'my-special-node', fetch,
    );
    const reqBody = JSON.parse(calls[0].init.body as string);
    expect(reqBody).toEqual({ mode: 'test', wallets: ['0xAAA'] });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^init-test-my-special-node-/);
  });

  it('sanitizes non-ASCII node names in Idempotency-Key header', async () => {
    const { fetch, calls } = createTrackingFetch(200, { summary: { success: 0 }, results: [] });
    await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', ['0xAAA'], 'mon-n\u0153ud-\u00e9l\u00e8ve', fetch,
    );
    const headers = calls[0].init.headers as Record<string, string>;
    const key = headers['Idempotency-Key'];
    expect(key).toMatch(/^init-test-mon-n_ud-_l_ve-0xAAA$/);
    expect(key).toMatch(/^[\x20-\x7E]+$/);
  });
});
