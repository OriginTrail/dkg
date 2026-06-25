// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { ChainRpcTransportError } from '@origintrail-official/dkg-chain';
import { classifyChainRpcTransportStatus } from '../src/daemon/http-utils.js';

describe('classifyChainRpcTransportStatus (W2 shared transport-status helper)', () => {
  it('maps RPC_ENDPOINTS_EXHAUSTED -> 503 (+code)', () => {
    expect(
      classifyChainRpcTransportStatus({ code: 'RPC_ENDPOINTS_EXHAUSTED', message: 'all endpoints failed' }),
    ).toEqual({ status: 503, body: { error: 'all endpoints failed', code: 'RPC_ENDPOINTS_EXHAUSTED' } });
  });

  it('maps RPC_RECEIPT_LOOKUP_FAILED -> 503 (+code, +txHash)', () => {
    const r = classifyChainRpcTransportStatus({ code: 'RPC_RECEIPT_LOOKUP_FAILED', message: 'm', txHash: '0xabc' });
    expect(r?.status).toBe(503);
    expect(r?.body).toMatchObject({ code: 'RPC_RECEIPT_LOOKUP_FAILED', txHash: '0xabc' });
  });

  it('maps a ChainRpcTransportError TIMEOUT instance -> 504', () => {
    // TIMEOUT is recognised via the instance (not a bare code) — #1332 review.
    expect(classifyChainRpcTransportStatus(new ChainRpcTransportError('TIMEOUT', 'm'))?.status).toBe(504);
  });

  it('does NOT classify a bare generic `code: TIMEOUT` (not our instance)', () => {
    expect(classifyChainRpcTransportStatus({ code: 'TIMEOUT', message: 'some other op timed out' })).toBeUndefined();
  });

  it('returns undefined for on-chain reverts / app errors (preserves the #988 contract)', () => {
    // On-chain reverts carry CALL_EXCEPTION, not a transport code -> stays 5xx via the route's own mapping.
    expect(classifyChainRpcTransportStatus({ code: 'CALL_EXCEPTION', message: 'execution reverted' })).toBeUndefined();
    expect(classifyChainRpcTransportStatus({ code: 'INSUFFICIENT_FUNDS' })).toBeUndefined();
    // Message-only "header not found" must NOT be mistaken for a transport error (code-keyed, never message).
    expect(classifyChainRpcTransportStatus(new Error('header not found'))).toBeUndefined();
    expect(classifyChainRpcTransportStatus('plain string')).toBeUndefined();
    expect(classifyChainRpcTransportStatus(undefined)).toBeUndefined();
    expect(classifyChainRpcTransportStatus(null)).toBeUndefined();
  });

  it('falls back to a generic message when the error carries none', () => {
    expect(classifyChainRpcTransportStatus({ code: 'RPC_ENDPOINTS_EXHAUSTED' })?.body.error).toMatch(/exhausted/i);
  });

  it('strips RPC URLs (and any embedded key) from the response body', () => {
    const r = classifyChainRpcTransportStatus({
      code: 'RPC_ENDPOINTS_EXHAUSTED',
      message:
        'create context graph transaction preparation failed on all configured RPC endpoints ' +
        '(https://rpc.example/v2/SECRETKEY123, https://backup.example): boom',
    });
    expect(r?.status).toBe(503);
    const error = String(r?.body.error);
    expect(error).not.toContain('://');
    expect(error).not.toContain('SECRETKEY123');
    expect(error).toContain('[rpc]');
    // The non-URL context is preserved so the response is still meaningful.
    expect(error).toMatch(/RPC endpoints/);
  });
});
