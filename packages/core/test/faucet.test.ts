import { describe, it, expect } from 'vitest';
import { requestFaucetFunding } from '../src/faucet.js';

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

  it('funds wallets in batches of 3', async () => {
    const { fetch, calls } = createTrackingFetch(200, { summary: { success: 1 }, results: [] });
    await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test',
      ['0x1', '0x2', '0x3', '0x4', '0x5'], 'big-node', fetch,
    );
    expect(calls).toHaveLength(2);
    const reqBody = JSON.parse(calls[0].init.body as string);
    expect(reqBody.wallets).toHaveLength(3);
    expect(reqBody.wallets).toEqual(['0x1', '0x2', '0x3']);
    const secondReqBody = JSON.parse(calls[1].init.body as string);
    expect(secondReqBody.wallets).toEqual(['0x4', '0x5']);
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
          summary: { success: 6 },
          results: [{ chainId: 'eth-sepolia', amount: '0.01', status: 'success' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('rate limited', { status: 429 });
    }) as typeof globalThis.fetch;

    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test',
      ['0x1', '0x2', '0x3', '0x4'], 'partial-node', fetch,
    );

    expect(calls).toHaveLength(2);
    expect(result.success).toBe(true);
    expect(result.funded).toEqual(['0.01 ETH']);
    expect(result.fundedWallets).toEqual(['0x1', '0x2', '0x3']);
    expect(result.failedWallets).toEqual(['0x4']);
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

  it('preserves earlier funded wallets when a later batch throws', async () => {
    const calls: FetchCall[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url as any, init: init as RequestInit });
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          summary: { success: 6 },
          results: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('faucet offline');
    }) as typeof globalThis.fetch;

    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test',
      ['0x1', '0x2', '0x3', '0x4'], 'throwing-node', fetch,
    );

    expect(result.success).toBe(true);
    expect(result.fundedWallets).toEqual(['0x1', '0x2', '0x3']);
    expect(result.failedWallets).toEqual(['0x4']);
    expect(result.error).toContain('faucet offline');
  });

  it('includes nodeName in callerId and Idempotency-Key', async () => {
    const { fetch, calls } = createTrackingFetch(200, { summary: { success: 0 }, results: [] });
    await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', ['0xAAA'], 'my-special-node', fetch,
    );
    const reqBody = JSON.parse(calls[0].init.body as string);
    expect(reqBody.callerId).toBe('dkg-node:my-special-node');
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
