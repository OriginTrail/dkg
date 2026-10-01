// SPDX-License-Identifier: Apache-2.0
/**
 * GH#2945 - the write transport's exhaustion messages never carry a full RPC URL.
 *
 * A configured RPC URL can carry an API key, and ethers embeds the request URL in the message of an
 * HTTP-level error. The read path already reduced it to its host; the write path (prepare, broadcast,
 * receipt lookup, and the estimate-fallback breadcrumb) forwarded the provider's own text verbatim, and
 * those messages reach HTTP clients, logs and the publisher's persisted failure records.
 *
 * Per site: no key and no path in `message`, the host survives, the original error stays reachable
 * untouched as `cause`, and the error's `code` / `txHash` contract is unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { _resetRpcFailoverStatsForTest } from '../src/rpc-failover-log.js';
import type { SignPopulatedFn } from '../src/rpc-failover-client.js';
import { makeClient, recorder } from './rpc-failover-test-helpers.js';

afterEach(() => { _resetRpcFailoverStatsForTest(); });

const KEYED = 'https://rpc.example/v2/SECRET-API-KEY';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const ADDRESS = `0x${'ab'.repeat(20)}`;

/** The shape of an ethers HTTP-level error: the request URL quoted inside the message. */
const keyed429 = () => Object.assign(
  new Error(`server response 429 Too Many Requests (info={ "requestUrl": "${KEYED}", "responseStatus": "429 Too Many Requests" }, code=SERVER_ERROR)`),
  { status: 429 },
);

const makeSigner = () => ({
  address: ADDRESS,
  connect: (p: unknown) => ({ address: ADDRESS, boundTo: p }),
}) as any;

const NEVER_SIGNED: SignPopulatedFn = async () => {
  throw new Error('sign must not be reached');
};

async function caught(run: () => Promise<unknown>): Promise<any> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected the operation to throw');
}

function expectHostOnly(err: any): void {
  expect(err.message).not.toContain('SECRET-API-KEY');
  expect(err.message).not.toContain('/v2/');
  expect(err.message).toContain('rpc.example');
}

describe('write-transport exhaustion messages are host-only', () => {
  const failingContract = () => ({
    connect: () => ({ doWrite: { populateTransaction: () => Promise.reject(keyed429()) } }),
  }) as any;

  it('populateAndSign, single endpoint: the provider text is no longer forwarded verbatim', async () => {
    const client = makeClient([{}], [KEYED], NEVER_SIGNED);

    const err = await caught(() => client.populateAndSign(failingContract(), 'doWrite', [], makeSigner(), 'publish'));

    expect(err.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(err.txHash).toBeUndefined();
    expectHostOnly(err);
    // The original error stays reachable, unreduced, for the one consumer that needs it.
    expect(err.cause.message).toContain('SECRET-API-KEY');
  });

  it('populateAndSign, several endpoints: the aggregate host list plus a reduced cause text', async () => {
    const client = makeClient([{}, {}], [KEYED, 'https://backup.example/v2/OTHER-KEY'], NEVER_SIGNED);

    const err = await caught(() => client.populateAndSign(failingContract(), 'doWrite', [], makeSigner(), 'publish'));

    expect(err.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expectHostOnly(err);
    expect(err.message).toContain('backup.example');
    expect(err.message).not.toContain('OTHER-KEY');
  });

  it('broadcast exhaustion keeps its txHash and code, with a host-only message', async () => {
    const provider = { broadcastTransaction: recorder(async () => { throw keyed429(); }) };
    const client = makeClient([provider], [KEYED]);

    const err = await caught(() => client.broadcast('0xsigned', TX_HASH, 'publish'));

    expect(err.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(err.txHash).toBe(TX_HASH);
    expectHostOnly(err);
    expect(err.message).toContain(TX_HASH);
  });

  it('a governor rejection at the broadcast boundary keeps its txHash, with a host-only message', async () => {
    const full = Object.assign(new Error(`request governor queue full while calling ${KEYED}`), {
      code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL',
    });
    const provider = { broadcastTransaction: recorder(async () => { throw full; }) };
    const client = makeClient([provider], [KEYED]);

    const err = await caught(() => client.broadcast('0xsigned', TX_HASH, 'publish'));

    expect(err.code).toBe('RPC_REQUEST_GOVERNOR_QUEUE_FULL');
    expect(err.txHash).toBe(TX_HASH);
    expect(err.message).not.toContain('SECRET-API-KEY');
    expect(err.message).toContain('rpc.example');
  });

  it('receipt-lookup failure keeps its code and txHash, with a host-only message', async () => {
    const provider = { getTransactionReceipt: recorder(async () => { throw keyed429(); }) };
    const client = makeClient([provider], [KEYED]);

    const err = await caught(() => client.getReceipt(TX_HASH));

    expect(err.code).toBe('RPC_RECEIPT_LOOKUP_FAILED');
    expect(err.txHash).toBe(TX_HASH);
    expectHostOnly(err);
  });

  it('the unbuffered-estimate breadcrumb in the log is host-only too', async () => {
    const populateTransaction = recorder(async () => ({ to: '0xTO', data: '0x' }));
    const estimateGas = recorder(async () => { throw keyed429(); });
    const contract = { connect: () => ({ doWrite: { populateTransaction, estimateGas } }) } as any;
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const client = makeClient([{}], [KEYED], signPopulated as SignPopulatedFn);

    const warns: string[] = [];
    const original = console.warn;
    console.warn = ((...args: unknown[]) => { warns.push(String(args[0])); }) as typeof console.warn;
    try {
      await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'publish', { gasLimitBufferBps: 1_000 });
    } finally {
      console.warn = original;
    }

    const breadcrumb = warns.find((w) => w.includes('buffered gas estimation failed'));
    expect(breadcrumb).toBeDefined();
    expect(breadcrumb).not.toContain('SECRET-API-KEY');
    expect(breadcrumb).toContain('rpc.example');
  });
});
