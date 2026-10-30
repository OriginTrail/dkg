// SPDX-License-Identifier: Apache-2.0
/**
 * #3591 — the publisher re-runs a job on a refusal for funds, because the refusal proves its
 * transaction never took effect. That proof needs one more thing: no earlier attempt at the same
 * signed bytes may have been accepted. An endpoint can accept a transaction and lose its answer, and
 * the next endpoint can still refuse it (it may lag behind a top-up).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Network, Transaction, Wallet, type JsonRpcProvider } from 'ethers';
import { RpcEndpointsExhaustedError } from '../src/chain-rpc-transport-error.js';
import { retryBroadcastEndpointSet } from '../src/evm-adapter-rpc.js';
import { RpcFailoverClient } from '../src/rpc-failover-client.js';
import { _resetRpcFailoverStatsForTest } from '../src/rpc-failover-log.js';
import { createRpcRequestProvider } from '../src/rpc-request-transport.js';
import {
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcError,
  sendJsonRpcResult,
  type LoopbackJsonRpcRequest,
  type LoopbackJsonRpcServer,
} from './loopback-rpc-harness.js';
import { recorder, retryable429, NEVER_PREPARE, makeClient } from './rpc-failover-test-helpers.js';

const callExceptionErr = (msg = 'execution reverted: TooLowAllowance') => Object.assign(new Error(msg), { code: 'CALL_EXCEPTION' });
const knownTxError = () => new Error('already known');
const abortedRpcError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
const URLS = ['https://primary.example', 'https://backup.example'];

afterEach(() => { _resetRpcFailoverStatsForTest(); });

describe('RpcFailoverClient.broadcast — a refusal for funds after an attempt that may have been accepted', () => {
  const fundsRefusal = () => Object.assign(
    new Error('insufficient funds for gas * price + value: balance 1, tx cost 2, overshot 1'),
    { code: 'INSUFFICIENT_FUNDS' },
  );
  const refuses = () => ({ broadcastTransaction: recorder(async () => { throw fundsRefusal(); }) });
  const losesTheAnswer = () => ({ broadcastTransaction: recorder(async () => { throw abortedRpcError(); }) });

  it('reports an unknown outcome that names the transaction, not a refusal', async () => {
    const backup = refuses();
    const thrown: any = await makeClient([losesTheAnswer(), backup], URLS)
      .broadcast('0xsigned', '0xhash', 'unit write').catch((error) => error);

    expect(thrown).toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED', txHash: '0xhash', mayHaveBeenAccepted: true });
    expect(thrown.message).not.toMatch(/insufficient funds/i);
    expect(backup.broadcastTransaction.calls).toHaveLength(1);
  });

  it('still takes a later endpoint\'s word that it knows the transaction', async () => {
    const third = { broadcastTransaction: recorder(async () => { throw knownTxError(); }) };
    const client = makeClient([losesTheAnswer(), refuses(), third], [...URLS, 'https://third.example']);

    await expect(client.broadcast('0xsigned', '0xhash', 'unit write')).resolves.toBeUndefined();
    expect(third.broadcastTransaction.calls).toHaveLength(1);
  });

  it('keeps a refusal that is the first answer', async () => {
    const refusal = fundsRefusal();
    const primary = { broadcastTransaction: recorder(async () => { throw refusal; }) };
    const backup = { broadcastTransaction: recorder(async () => undefined) };

    await expect(makeClient([primary, backup], URLS).broadcast('0xsigned', '0xhash', 'unit write')).rejects.toBe(refusal);
    expect(backup.broadcastTransaction.calls).toEqual([]);
  });

  it.each([
    ['throttled the request', retryable429],
    ['refused the connection', () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['could not be resolved', () => Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })],
    ['could not be looked up yet', () => Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' })],
  ])('keeps a refusal when the earlier endpoint %s: it never took the transaction', async (_name, failure) => {
    const refusal = fundsRefusal();
    const primary = { broadcastTransaction: recorder(async () => { throw failure(); }) };
    const backup = { broadcastTransaction: recorder(async () => { throw refusal; }) };

    await expect(makeClient([primary, backup], URLS).broadcast('0xsigned', '0xhash', 'unit write')).rejects.toBe(refusal);
  });

  it('keeps a refusal when the earlier attempt failed before anything was sent', async () => {
    const refusal = fundsRefusal();
    const primary = { broadcastTransaction: recorder(async () => undefined) };
    const backup = { broadcastTransaction: recorder(async () => { throw refusal; }) };
    const client = new RpcFailoverClient(
      () => [{ provider: primary as any, rpcUrl: URLS[0] }, { provider: backup as any, rpcUrl: URLS[1] }],
      () => 'evm:31337',
      {
        prepareForSigning: NEVER_PREPARE,
        validateEndpoint: async (endpoint) => { if (endpoint.rpcUrl === URLS[0]) throw abortedRpcError(); },
      },
    );

    await expect(client.broadcast('0xsigned', '0xhash', 'unit write')).rejects.toBe(refusal);
    expect(primary.broadcastTransaction.calls).toEqual([]);
  });

  it('says on an exhausted pass whether the transaction may have been accepted', async () => {
    const throttled = () => ({ broadcastTransaction: recorder(async () => { throw retryable429(); }) });
    const onlyThrottled: any = await makeClient([throttled(), throttled()], URLS)
      .broadcast('0xsigned', '0xhash', 'unit write').catch((error) => error);
    const lostAnswer: any = await makeClient([throttled(), losesTheAnswer()], URLS)
      .broadcast('0xsigned', '0xhash', 'unit write').catch((error) => error);

    expect(onlyThrottled).toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED', mayHaveBeenAccepted: false });
    expect(lostAnswer).toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED', mayHaveBeenAccepted: true });
  });
});

describe('retryBroadcastEndpointSet — a refusal for funds on a later pass', () => {
  const refusal = () => Object.assign(new Error('insufficient funds for gas'), { code: 'INSUFFICIENT_FUNDS' });

  async function settled(first: RpcEndpointsExhaustedError, second: unknown) {
    vi.useFakeTimers();
    try {
      let pass = 0;
      const outcome = retryBroadcastEndpointSet(async () => { throw pass++ === 0 ? first : second; }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      return await outcome;
    } finally {
      vi.useRealTimers();
    }
  }

  it('leaves the earlier unknown outcome standing when that pass may have left the transaction with an endpoint', async () => {
    const unknown = new RpcEndpointsExhaustedError('exhausted', { txHash: '0xhash', mayHaveBeenAccepted: true });
    expect(await settled(unknown, refusal())).toBe(unknown);
  });

  it('stays a refusal after a pass that cannot have left the transaction anywhere', async () => {
    const throttled = new RpcEndpointsExhaustedError('exhausted', { txHash: '0xhash', mayHaveBeenAccepted: false });
    const refused = refusal();
    expect(await settled(throttled, refused)).toBe(refused);
  });

  it('passes any other later failure through', async () => {
    const unknown = new RpcEndpointsExhaustedError('exhausted', { txHash: '0xhash', mayHaveBeenAccepted: true });
    const reverted = callExceptionErr();
    expect(await settled(unknown, reverted)).toBe(reverted);
  });
});

describe('a real provider: what fails is the send itself', () => {
  const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const FUNDS = 'insufficient funds for gas * price + value: balance 1, tx cost 2, overshot 1';
  const harness = createLoopbackJsonRpcTestHarness();
  const providers: JsonRpcProvider[] = [];

  afterEach(async () => {
    for (const provider of providers.splice(0)) provider.destroy();
    await harness.stopAll();
  });

  async function signedTransaction() {
    const raw = await new Wallet(DEPLOYER_PK).signTransaction({
      to: '0x0000000000000000000000000000000000000001',
      nonce: 0,
      gasLimit: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      chainId: 31337n,
      type: 2,
    });
    return { raw, hash: Transaction.from(raw).hash! };
  }

  function provider(url: string) {
    const created = createRpcRequestProvider(url, {
      maxRetries: 0,
      network: Network.from(31337),
      providerOptions: { cacheTimeout: -1, polling: true, batchMaxCount: 1 },
    });
    providers.push(created);
    return created;
  }

  const clientOver = (...servers: LoopbackJsonRpcServer[]) => new RpcFailoverClient(
    () => servers.map((server) => ({ provider: provider(server.url), rpcUrl: server.url })),
    () => 'evm:31337',
    { prepareForSigning: NEVER_PREPARE },
  );

  const methods = (server: LoopbackJsonRpcServer) => server.calls.map((call: LoopbackJsonRpcRequest) => call.method);
  const throttled = (response: Parameters<typeof sendJsonRpcResult>[0], request: LoopbackJsonRpcRequest) => {
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32005, message: 'rate limited' } }));
  };

  /** Healthy for reads, and turns the transaction away. */
  const refuses = () => harness.start((request, response) => {
    if (request.method === 'eth_sendRawTransaction') sendJsonRpcError(response, request, -32000, FUNDS);
    else sendJsonRpcResult(response, request, '0x10');
  });

  it('does not let a throttled read hide a transaction the endpoint accepted', async () => {
    const { raw, hash } = await signedTransaction();
    const accepting = await harness.start((request, response) => {
      if (request.method === 'eth_sendRawTransaction') sendJsonRpcResult(response, request, hash);
      else throttled(response, request);
    });
    const refusing = await refuses();

    await expect(clientOver(accepting, refusing).broadcast(raw, hash, 'unit write')).resolves.toBeUndefined();

    expect(methods(accepting)).toEqual(['eth_sendRawTransaction']);
    expect(methods(refusing)).toEqual([]);
  });

  it('keeps a refusal after the send itself was throttled: that endpoint took nothing', async () => {
    const { raw, hash } = await signedTransaction();
    const limiting = await harness.start((request, response) => throttled(response, request));
    const refusing = await refuses();

    await expect(clientOver(limiting, refusing).broadcast(raw, hash, 'unit write')).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

    expect(methods(limiting)).toEqual(['eth_sendRawTransaction']);
  });

  it('reports an unknown outcome when the answer to the send is lost and the next endpoint refuses', async () => {
    const { raw, hash } = await signedTransaction();
    const losing = await harness.start((_request, _response, incoming) => { incoming.socket.destroy(); });
    const refusing = await refuses();

    const thrown: any = await clientOver(losing, refusing).broadcast(raw, hash, 'unit write').catch((error) => error);

    expect(thrown).toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED', txHash: hash, mayHaveBeenAccepted: true });
    expect(thrown.message).not.toMatch(/insufficient funds/i);
  });

  it('answers with a response for the sent transaction, and refuses a reply that names another hash', async () => {
    const { raw, hash } = await signedTransaction();
    const answering = (sent: string) => harness.start((request, response) => {
      sendJsonRpcResult(response, request, request.method === 'eth_sendRawTransaction' ? sent : '0x10');
    });
    const accepting = await answering(hash);
    const confused = await answering(`0x${'22'.repeat(32)}`);

    await expect(provider(accepting.url).broadcastTransaction(raw)).resolves.toMatchObject({ hash });
    await expect(provider(confused.url).broadcastTransaction(raw)).rejects.toThrow(/did not match/);
  });
});
