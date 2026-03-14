import { describe, it, expect, vi } from 'vitest';
import { requestFaucetFunding } from '../src/faucet.js';

function mockFetch(status: number, body: unknown): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  }) as unknown as typeof globalThis.fetch;
}

describe('requestFaucetFunding', () => {
  it('returns funded amounts on success', async () => {
    const fetch = mockFetch(200, {
      summary: { success: 2, failed: 0 },
      results: [
        { chainId: 'eth-sepolia', amount: '0.01', status: 'success' },
        { chainId: 'trac-base', amount: '1000', status: 'success' },
      ],
    });
    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'v9_base_sepolia',
      ['0xAAA', '0xBBB'], 'test-node', fetch,
    );
    expect(result.success).toBe(true);
    expect(result.funded).toEqual(['0.01 ETH', '1000 TRAC']);
    expect(fetch).toHaveBeenCalledOnce();
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.wallets).toEqual(['0xAAA', '0xBBB']);
    expect(body.mode).toBe('v9_base_sepolia');
  });

  it('caps wallets at 3', async () => {
    const fetch = mockFetch(200, { summary: { success: 1 }, results: [] });
    await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test',
      ['0x1', '0x2', '0x3', '0x4', '0x5'], 'big-node', fetch,
    );
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.wallets).toHaveLength(3);
    expect(body.wallets).toEqual(['0x1', '0x2', '0x3']);
  });

  it('returns error on HTTP failure', async () => {
    const fetch = mockFetch(429, 'rate limited');
    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', ['0xAAA'], 'test-node', fetch,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('429');
  });

  it('returns no-wallets error for empty array', async () => {
    const fetch = mockFetch(200, {});
    const result = await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', [], 'test-node', fetch,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('no wallets');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns success=false when faucet reports 0 successes', async () => {
    const fetch = mockFetch(200, {
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

  it('propagates network errors', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof globalThis.fetch;
    await expect(
      requestFaucetFunding('https://faucet.example.com/fund', 'test', ['0xAAA'], 'test-node', fetch),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('includes nodeName in callerId and Idempotency-Key', async () => {
    const fetch = mockFetch(200, { summary: { success: 0 }, results: [] });
    await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', ['0xAAA'], 'my-special-node', fetch,
    );
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.callerId).toBe('dkg-node:my-special-node');
    const headers = call[1].headers;
    expect(headers['Idempotency-Key']).toMatch(/^init-my-special-node-/);
  });

  it('sanitizes non-ASCII node names in Idempotency-Key header', async () => {
    const fetch = mockFetch(200, { summary: { success: 0 }, results: [] });
    await requestFaucetFunding(
      'https://faucet.example.com/fund', 'test', ['0xAAA'], 'mon-n\u0153ud-\u00e9l\u00e8ve', fetch,
    );
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers;
    const key = headers['Idempotency-Key'];
    expect(key).toMatch(/^init-mon-n_ud-_l_ve-\d+$/);
    expect(key).toMatch(/^[\x20-\x7E]+$/);
  });
});
