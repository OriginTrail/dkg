// SPDX-License-Identifier: Apache-2.0
/**
 * GH#2942 — `isTransientRpcTransportFailureWithoutTransaction` against the REAL emitters.
 *
 * The publisher keys a pre-send retry on this predicate, so what matters is not the predicate in
 * isolation but that the errors the failover module ACTUALLY throws land on the right side of it:
 * a preparation failure (nothing signed, nothing sent) qualifies; a broadcast or receipt failure
 * (a transaction exists) never does, whatever its code.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  ChainRpcTransportError,
  RpcEndpointsExhaustedError,
  createRpcAdmissionTimeoutError,
  createRpcTimeoutError,
  isTransientRpcTransportFailureWithoutTransaction,
} from '../src/chain-rpc-transport-error.js';
import { _resetRpcFailoverStatsForTest } from '../src/rpc-failover-log.js';
import type { SignPopulatedFn } from '../src/rpc-failover-client.js';
import { makeClient, recorder, retryable429 } from './rpc-failover-test-helpers.js';

afterEach(() => { _resetRpcFailoverStatsForTest(); });

const URLS = ['https://primary.example/v2/SECRET-KEY', 'https://backup.example/v2/SECRET-KEY'];
const TX_HASH = `0x${'ab'.repeat(32)}`;
const ADDRESS = `0x${'ab'.repeat(20)}`;

const makeSigner = () => ({
  address: ADDRESS,
  connect: (p: unknown) => ({ address: ADDRESS, boundTo: p }),
}) as any;

/** A contract whose `populateTransaction` rejects with a retryable transport error on every endpoint. */
const alwaysFailingContract = () => ({
  connect: () => ({ doWrite: { populateTransaction: () => Promise.reject(retryable429()) } }),
}) as any;

const NEVER_SIGNED: SignPopulatedFn = async () => {
  throw new Error('sign must not be reached: preparation never completes');
};

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected the operation to throw');
}

describe('isTransientRpcTransportFailureWithoutTransaction — real producers', () => {
  it('qualifies a write PREPARATION that exhausted every endpoint (nothing signed, no txHash)', async () => {
    const providers = [{}, {}];
    const client = makeClient(providers, URLS, NEVER_SIGNED);

    const err = await caught(() => client.populateAndSign(alwaysFailingContract(), 'doWrite', [], makeSigner(), 'publish'));

    expect(err).toBeInstanceOf(RpcEndpointsExhaustedError);
    expect((err as RpcEndpointsExhaustedError).code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect((err as RpcEndpointsExhaustedError).txHash).toBeUndefined();
    expect(isTransientRpcTransportFailureWithoutTransaction(err)).toBe(true);
  });

  it('qualifies the single-endpoint preparation exhaustion too (the producer keeps the provider text, URLs reduced to hosts)', async () => {
    const client = makeClient([{}], [URLS[0]], NEVER_SIGNED);

    const err = await caught(() => client.populateAndSign(alwaysFailingContract(), 'doWrite', [], makeSigner(), 'publish'));

    expect(err).toBeInstanceOf(RpcEndpointsExhaustedError);
    expect(isTransientRpcTransportFailureWithoutTransaction(err)).toBe(true);
  });

  it('does NOT qualify a BROADCAST that exhausted every endpoint: the producer stamps the txHash', async () => {
    const primary = { broadcastTransaction: recorder(async () => { throw retryable429(); }) };
    const backup = { broadcastTransaction: recorder(async () => { throw retryable429(); }) };
    const client = makeClient([primary, backup], URLS);

    const err = await caught(() => client.broadcast('0xsigned', TX_HASH, 'publish'));

    expect(err).toBeInstanceOf(RpcEndpointsExhaustedError);
    expect((err as RpcEndpointsExhaustedError).txHash).toBe(TX_HASH);
    expect(isTransientRpcTransportFailureWithoutTransaction(err)).toBe(false);
  });

  it('does NOT qualify a BROADCAST rejected by the local request governor: it carries the txHash', async () => {
    const full = Object.assign(new Error('request governor queue full'), { code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' });
    const primary = { broadcastTransaction: recorder(async () => { throw full; }) };
    const client = makeClient([primary], [URLS[0]]);

    const err = await caught(() => client.broadcast('0xsigned', TX_HASH, 'publish'));

    expect((err as ChainRpcTransportError).code).toBe('RPC_REQUEST_GOVERNOR_QUEUE_FULL');
    expect((err as ChainRpcTransportError).txHash).toBe(TX_HASH);
    expect(isTransientRpcTransportFailureWithoutTransaction(err)).toBe(false);
  });

  it('qualifies an admission wait that expired before anything was sent, and a bounded request timeout', () => {
    expect(isTransientRpcTransportFailureWithoutTransaction(createRpcAdmissionTimeoutError('queued too long'))).toBe(true);
    expect(isTransientRpcTransportFailureWithoutTransaction(createRpcTimeoutError('eth_estimateGas timed out after 10000ms'))).toBe(true);
  });

  it('does NOT qualify the receipt-wait timeout of a SENT transaction (same code, carries the hash)', () => {
    expect(isTransientRpcTransportFailureWithoutTransaction(
      createRpcTimeoutError('receipt wait timed out', { txHash: TX_HASH }),
    )).toBe(false);
  });

  it('does NOT qualify a receipt-lookup failure: only ever raised for a transaction that was sent', () => {
    expect(isTransientRpcTransportFailureWithoutTransaction(
      new ChainRpcTransportError('RPC_RECEIPT_LOOKUP_FAILED', 'receipt lookup failed on every endpoint'),
    )).toBe(false);
    expect(isTransientRpcTransportFailureWithoutTransaction(
      new ChainRpcTransportError('RPC_RECEIPT_LOOKUP_FAILED', 'receipt lookup failed', { txHash: TX_HASH }),
    )).toBe(false);
  });
});

describe('isTransientRpcTransportFailureWithoutTransaction — structural contract', () => {
  it('reads the code structurally, so a re-wrap that preserves it still qualifies', () => {
    expect(isTransientRpcTransportFailureWithoutTransaction({ code: 'RPC_ENDPOINTS_EXHAUSTED', message: 'x' })).toBe(true);
    expect(isTransientRpcTransportFailureWithoutTransaction({ code: 'RPC_ENDPOINTS_EXHAUSTED', txHash: TX_HASH })).toBe(false);
  });

  it('never qualifies prose, a re-wrap that lost the code, or a non-transport error', () => {
    expect(isTransientRpcTransportFailureWithoutTransaction(new Error('request timed out'))).toBe(false);
    expect(isTransientRpcTransportFailureWithoutTransaction(new Error('all configured RPC endpoints failed', {
      cause: new RpcEndpointsExhaustedError('inner'),
    }))).toBe(false);
    expect(isTransientRpcTransportFailureWithoutTransaction(Object.assign(new Error('revert'), { code: 'CALL_EXCEPTION' }))).toBe(false);
    expect(isTransientRpcTransportFailureWithoutTransaction(Object.assign(new Error('x'), { code: 'TIMEOUT' }))).toBe(false);
    expect(isTransientRpcTransportFailureWithoutTransaction(undefined)).toBe(false);
    expect(isTransientRpcTransportFailureWithoutTransaction(null)).toBe(false);
    expect(isTransientRpcTransportFailureWithoutTransaction('RPC_ENDPOINTS_EXHAUSTED')).toBe(false);
  });

  it('is throw-safe: a throwing accessor reads as "does not qualify"', () => {
    const hostile = {
      get code(): string { throw new Error('boom'); },
    };
    const hostileHash = {
      code: 'RPC_ENDPOINTS_EXHAUSTED',
      get txHash(): string { throw new Error('boom'); },
    };
    expect(isTransientRpcTransportFailureWithoutTransaction(hostile)).toBe(false);
    expect(isTransientRpcTransportFailureWithoutTransaction(hostileHash)).toBe(false);
  });
});
