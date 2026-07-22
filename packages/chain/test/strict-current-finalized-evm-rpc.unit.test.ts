import {
  type ChainIdV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1,
  CONTROL_EIP1271_CALL_FROM_V1,
  CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1,
  CONTROL_EIP1271_GAS_LIMIT_V1,
  CONTROL_EIP1271_MAX_ATTEMPTS_V1,
  CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1,
  CONTROL_EIP1271_MAX_RETURN_BYTES_V1,
  CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1,
  CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1,
  CurrentFinalizedEvmCallErrorV1,
  type CurrentFinalizedEvmCallRequestV1,
} from '../src/control-object-signature-verifier.js';
import {
  CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
  CURRENT_FINALIZED_EVM_READ_CALL_FROM_V1,
  CURRENT_FINALIZED_EVM_READ_ENDPOINT_ATTEMPT_POLICY_V1,
  CURRENT_FINALIZED_EVM_READ_GAS_LIMIT_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1,
  CURRENT_FINALIZED_EVM_READ_TOTAL_DEADLINE_MS_V1,
} from '../src/current-finalized-evm-read-profile.js';
import {
  createStrictCurrentFinalizedEvmChainAdapterV1,
  createStrictCurrentFinalizedEvmReadV1,
  readStrictCurrentFinalizedEvmRevertDataV1,
  type StrictCurrentFinalizedEvmRpcConfigV1,
} from '../src/strict-current-finalized-evm-rpc.js';
import {
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcError as sendError,
  sendJsonRpcResult as sendResult,
  type LoopbackJsonRpcHandler as LoopbackHandler,
} from './loopback-rpc-harness.js';

const CHAIN_ID = '20430' as ChainIdV1;
const CHAIN_QUANTITY = '0x4fce';
const TO = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const OTHER_TO = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const BLOCK_HASH = `0x${'22'.repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${'23'.repeat(32)}`;
const OBJECT_DIGEST = `${'33'.repeat(32)}`;
const CANONICAL_CALL_DATA = `0x1626ba7e${OBJECT_DIGEST}${'0'.repeat(62)}40${'0'.repeat(63)}1aa${'0'.repeat(62)}`;
const MAGIC_RETURN = `0x1626ba7e${'00'.repeat(28)}`;
const WRONG_MAGIC_RETURN = `0xffffffff${'00'.repeat(28)}`;
const FIRST_READ_DATA = '0x11111111';
const SECOND_READ_DATA = '0x22222222';

const rpcHarness = createLoopbackJsonRpcTestHarness();
const startRpcServer = rpcHarness.start;

afterEach(async () => {
  await rpcHarness.stopAll();
});

describe('RFC-64 strict current-finalized raw JSON-RPC transport', () => {
  it('keeps the EIP-1271 specialization pinned to the generic finalized-read profile', () => {
    expect(CONTROL_EIP1271_CALL_FROM_V1).toBe(CURRENT_FINALIZED_EVM_READ_CALL_FROM_V1);
    expect(CONTROL_EIP1271_GAS_LIMIT_V1).toBe(CURRENT_FINALIZED_EVM_READ_GAS_LIMIT_V1);
    expect(CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1)
      .toBe(CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1);
    expect(CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1)
      .toBe(CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1);
    expect(CONTROL_EIP1271_MAX_ATTEMPTS_V1)
      .toBe(CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1);
    expect(CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1)
      .toBe(CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1);
    expect(CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1)
      .toBe(CURRENT_FINALIZED_EVM_READ_TOTAL_DEADLINE_MS_V1);
    expect(CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1)
      .toBe(CURRENT_FINALIZED_EVM_READ_ENDPOINT_ATTEMPT_POLICY_V1);
  });

  it('executes multiple ABI reads at one EIP-1898 anchor and checks shared code once', async () => {
    const server = await startRpcServer((call, response) => {
      switch (call.method) {
        case 'eth_chainId':
          sendResult(response, call, CHAIN_QUANTITY);
          return;
        case 'eth_getBlockByNumber':
          sendResult(response, call, { number: '0x7b', hash: BLOCK_HASH });
          return;
        case 'eth_getCode':
          sendResult(response, call, '0x6000');
          return;
        case 'eth_call': {
          const callObject = call.params[0] as { readonly data?: unknown };
          if (callObject.data === FIRST_READ_DATA) sendResult(response, call, '0xaaaa');
          else if (callObject.data === SECOND_READ_DATA) sendResult(response, call, '0xbbbbcc');
          else sendError(response, call, -32602, 'unexpected call payload');
          return;
        }
        default:
          sendError(response, call, -32601, 'method not found');
      }
    });
    const read = createStrictCurrentFinalizedEvmReadV1({
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });

    const result = await read({
      chainId: CHAIN_ID,
      calls: [
        { to: TO, data: FIRST_READ_DATA, maxReturnBytes: 2 },
        { to: TO, data: SECOND_READ_DATA, maxReturnBytes: 3 },
      ],
      signal: new AbortController().signal,
    });

    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.returnData)).toBe(true);
    expect(result).toEqual({
      chainId: CHAIN_ID,
      blockNumber: '123',
      blockHash: BLOCK_HASH,
      returnData: ['0xaaaa', '0xbbbbcc'],
    });
    expect(server.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_call',
    ]);
    const hashReference = { blockHash: BLOCK_HASH, requireCanonical: true };
    expect(server.calls[2]!.params).toEqual([TO, hashReference]);
    const ethCallParams = server.calls
      .filter(({ method }) => method === 'eth_call')
      .map(({ params }) => params);
    expect(ethCallParams).toHaveLength(2);
    expect(ethCallParams).toEqual(expect.arrayContaining([
      [{
        from: CONTROL_EIP1271_CALL_FROM_V1,
        to: TO,
        data: FIRST_READ_DATA,
        gas: '0xf4240',
      }, hashReference],
      [{
        from: CONTROL_EIP1271_CALL_FROM_V1,
        to: TO,
        data: SECOND_READ_DATA,
        gas: '0xf4240',
      }, hashReference],
    ]));
  });

  it('closes one hash sandwich after every call in a multi-read fallback', async () => {
    const server = await startRpcServer(successfulHandler());
    const read = createStrictCurrentFinalizedEvmReadV1({
      chainId: CHAIN_ID,
      endpoints: [server.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(read({
      chainId: CHAIN_ID,
      calls: [
        { to: TO, data: FIRST_READ_DATA, maxReturnBytes: 32 },
        { to: TO, data: SECOND_READ_DATA, maxReturnBytes: 32 },
      ],
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      blockNumber: '123',
      blockHash: BLOCK_HASH,
      returnData: [MAGIC_RETURN, MAGIC_RETURN],
    });
    expect(server.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_call',
      'eth_getBlockByNumber',
    ]);
    expect(server.calls[3]!.params[1]).toBe('0x7b');
    expect(server.calls[4]!.params[1]).toBe('0x7b');
    expect(server.calls[5]!.params).toEqual(['0x7b', false]);
  });

  it('checks every distinct target before executing any call', async () => {
    const server = await startRpcServer((call, response) => {
      switch (call.method) {
        case 'eth_chainId':
          sendResult(response, call, CHAIN_QUANTITY);
          return;
        case 'eth_getBlockByNumber':
          sendResult(response, call, { number: '0x7b', hash: BLOCK_HASH });
          return;
        case 'eth_getCode':
          sendResult(response, call, call.params[0] === TO ? '0x6000' : '0x');
          return;
        case 'eth_call':
          sendResult(response, call, MAGIC_RETURN);
          return;
        default:
          sendError(response, call, -32601, 'method not found');
      }
    });
    const read = createStrictCurrentFinalizedEvmReadV1({
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });

    await expect(read({
      chainId: CHAIN_ID,
      calls: [
        { to: TO, data: FIRST_READ_DATA, maxReturnBytes: 32 },
        { to: OTHER_TO, data: SECOND_READ_DATA, maxReturnBytes: 32 },
      ],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'no-code' });
    expect(server.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_getCode',
    ]);
    expect(server.calls[2]!.params[0]).toBe(TO);
    expect(server.calls[3]!.params[0]).toBe(OTHER_TO);
  });

  it('rejects an oversized generic return only after a stable fallback sandwich', async () => {
    const server = await startRpcServer(successfulHandler({ returnData: '0xaaaaaa' }));
    const read = createStrictCurrentFinalizedEvmReadV1({
      chainId: CHAIN_ID,
      endpoints: [server.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(read({
      chainId: CHAIN_ID,
      calls: [{ to: TO, data: FIRST_READ_DATA, maxReturnBytes: 2 }],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'malformed-return' });
    expect(server.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getBlockByNumber',
    ]);
  });

  it('fails hostile generic read shapes closed before transport', async () => {
    const server = await startRpcServer(successfulHandler());
    const read = createStrictCurrentFinalizedEvmReadV1({
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });
    const validCall = { to: TO, data: FIRST_READ_DATA, maxReturnBytes: 32 };
    const sparse = new Array(1);
    const accessor = { to: TO, data: FIRST_READ_DATA } as Record<string, unknown>;
    Object.defineProperty(accessor, 'maxReturnBytes', {
      enumerable: true,
      get() {
        throw new Error('must not execute');
      },
    });

    for (const request of [
      { chainId: CHAIN_ID, calls: [], signal: new AbortController().signal },
      {
        chainId: CHAIN_ID,
        calls: Array.from(
          { length: CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1 + 1 },
          () => validCall,
        ),
        signal: new AbortController().signal,
      },
      {
        chainId: CHAIN_ID,
        calls: [{ ...validCall, maxReturnBytes: 0 }],
        signal: new AbortController().signal,
      },
      {
        chainId: CHAIN_ID,
        calls: [{
          ...validCall,
          maxReturnBytes: CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1 + 1,
        }],
        signal: new AbortController().signal,
      },
      { chainId: CHAIN_ID, calls: sparse, signal: new AbortController().signal },
      { chainId: CHAIN_ID, calls: [accessor], signal: new AbortController().signal },
      { chainId: CHAIN_ID, calls: [validCall], signal: {} },
      { chainId: CHAIN_ID, calls: [validCall], signal: new AbortController().signal, rpcUrl: server.url },
    ]) {
      await expect(read(request as never)).rejects.toMatchObject({ code: 'rpc-unavailable' });
    }
    expect(server.calls).toHaveLength(0);
  });

  it('rejects a fifth concurrent generic read without queueing it', async () => {
    const gate = deferred<void>();
    const baseHandler = successfulHandler();
    const server = await startRpcServer(async (call, response, request) => {
      if (call.method === 'eth_chainId') await gate.promise;
      await baseHandler(call, response, request);
    });
    const read = createStrictCurrentFinalizedEvmReadV1({
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });
    const request = () => ({
      chainId: CHAIN_ID,
      calls: [{ to: TO, data: FIRST_READ_DATA, maxReturnBytes: 32 }],
      signal: new AbortController().signal,
    });
    const active = Array.from({ length: 4 }, () => read(request()));

    await expect(read(request())).rejects.toMatchObject({
      code: 'concurrency-saturated',
    });
    gate.resolve(undefined);
    await expect(Promise.all(active)).resolves.toHaveLength(4);
  });

  it('holds each read permit until every started parallel code check settles', async () => {
    const siblingGate = deferred<void>();
    const allSiblingsStarted = deferred<void>();
    let siblingsStarted = 0;
    const baseHandler = successfulHandler();
    const server = await startRpcServer(async (call, response, request) => {
      if (call.method !== 'eth_getCode') {
        await baseHandler(call, response, request);
        return;
      }
      if (call.params[0] === TO) {
        sendResult(response, call, '0x');
        return;
      }
      siblingsStarted += 1;
      if (siblingsStarted === CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1) {
        allSiblingsStarted.resolve(undefined);
      }
      await siblingGate.promise;
      sendResult(response, call, '0x6000');
    });
    const read = createStrictCurrentFinalizedEvmReadV1({
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });
    const request = () => ({
      chainId: CHAIN_ID,
      calls: [
        { to: TO, data: FIRST_READ_DATA, maxReturnBytes: 32 },
        { to: OTHER_TO, data: SECOND_READ_DATA, maxReturnBytes: 32 },
      ],
      signal: new AbortController().signal,
    });
    const active = Array.from(
      { length: CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1 },
      () => read(request()),
    );

    await allSiblingsStarted.promise;
    await expect(read(request())).rejects.toMatchObject({ code: 'concurrency-saturated' });
    siblingGate.resolve(undefined);
    await Promise.all(active.map(async (operation) => {
      await expect(operation).rejects.toMatchObject({ code: 'no-code' });
    }));
    await expect(read(request())).rejects.toMatchObject({ code: 'no-code' });
  });

  it('preserves a terminal failure that precedes a slower sibling attempt timeout', async () => {
    const siblingClosed = deferred<void>();
    const first = await startRpcServer(async (call, response) => {
      switch (call.method) {
        case 'eth_chainId':
          sendResult(response, call, CHAIN_QUANTITY);
          return;
        case 'eth_getBlockByNumber':
          sendResult(response, call, { number: '0x7b', hash: BLOCK_HASH });
          return;
        case 'eth_getCode':
          if (call.params[0] === TO) {
            sendResult(response, call, '0x');
            return;
          }
          response.on('close', () => siblingClosed.resolve(undefined));
          return;
        default:
          sendError(response, call, -32601, 'method not found');
      }
    });
    const second = await startRpcServer(successfulHandler());
    const read = createStrictCurrentFinalizedEvmReadV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });

    await expect(read({
      chainId: CHAIN_ID,
      calls: [
        { to: TO, data: FIRST_READ_DATA, maxReturnBytes: 32 },
        { to: OTHER_TO, data: SECOND_READ_DATA, maxReturnBytes: 32 },
      ],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'no-code' });
    await siblingClosed.promise;
    expect(second.calls).toHaveLength(0);
  }, CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1 + 4_000);

  it('uses the configured endpoint once, in exact EIP-1898 request order and shape', async () => {
    const server = await startRpcServer(successfulHandler());
    const configuredEndpoints = [server.url];
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: configuredEndpoints,
    });
    configuredEndpoints[0] = 'http://peer-controlled.invalid';

    await expect(adapter(fixedRequest())).resolves.toEqual({
      chainId: CHAIN_ID,
      blockNumber: '123',
      blockHash: BLOCK_HASH,
      returnData: MAGIC_RETURN,
    });
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(server.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
    ]);
    expect(server.calls.map(({ id }) => id)).toEqual([1, 2, 3, 4]);
    expect(server.calls[0]!.params).toEqual([]);
    expect(server.calls[1]!.params).toEqual(['finalized', false]);
    const hashReference = { blockHash: BLOCK_HASH, requireCanonical: true };
    expect(server.calls[2]!.params).toEqual([TO, hashReference]);
    expect(server.calls[3]!.params).toEqual([{
      from: CONTROL_EIP1271_CALL_FROM_V1,
      to: TO,
      data: CANONICAL_CALL_DATA,
      gas: '0xf4240',
    }, hashReference]);
  });

  it('uses the explicit trusted number profile with a same-endpoint post-hash sandwich', async () => {
    const server = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [server.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(adapter(fixedRequest())).resolves.toMatchObject({
      blockNumber: '123',
      blockHash: BLOCK_HASH,
    });
    expect(server.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getBlockByNumber',
    ]);
    expect(server.calls[2]!.params).toEqual([TO, '0x7b']);
    expect(server.calls[3]!.params[1]).toBe('0x7b');
    expect(server.calls[4]!.params).toEqual(['0x7b', false]);
  });

  it('fails over in canonical order after wrong-chain evidence without endpoint stickiness', async () => {
    const first = await startRpcServer((call, response) => {
      sendResult(response, call, '0x1');
    });
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, `${second.url}/`],
    });

    await expect(adapter(fixedRequest())).resolves.toMatchObject({ chainId: CHAIN_ID });
    await expect(adapter(fixedRequest())).resolves.toMatchObject({ chainId: CHAIN_ID });
    expect(first.calls.map(({ method }) => method)).toEqual(['eth_chainId', 'eth_chainId']);
    expect(second.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
    ]);
  });

  it('deduplicates normalized endpoints and performs no hidden same-endpoint retry', async () => {
    const server = await startRpcServer((call, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: call.id,
        error: { code: -32000, message: 'temporarily unavailable' },
      }));
    });
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [server.url, `${server.url}/`],
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'rpc-unavailable' });
    expect(server.calls).toHaveLength(1);
  });

  it('applies the two-endpoint ceiling after normalized endpoint deduplication', async () => {
    const primary = await startRpcServer((call, response) => {
      sendResult(response, call, '0x1');
    });
    const backup = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [primary.url, `${primary.url}/`, backup.url],
    });

    await expect(adapter(fixedRequest())).resolves.toMatchObject({ chainId: CHAIN_ID });
    expect(primary.calls.map(({ method }) => method)).toEqual(['eth_chainId']);
    expect(backup.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
    ]);
  });

  it('never follows a redirect to an endpoint outside trusted local configuration', async () => {
    const unconfigured = await startRpcServer(successfulHandler());
    const configured = await startRpcServer((_call, response) => {
      response.writeHead(307, { location: unconfigured.url });
      response.end();
    });
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [configured.url],
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'rpc-unavailable' });
    expect(configured.calls).toHaveLength(1);
    expect(unconfigured.calls).toHaveLength(0);
  });

  it('advances after a fallback hash mismatch and never accepts mixed-anchor evidence', async () => {
    let finalizedReads = 0;
    const first = await startRpcServer(successfulHandler({
      blockHash: () => (++finalizedReads === 1 ? BLOCK_HASH : OTHER_BLOCK_HASH),
    }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(adapter(fixedRequest())).resolves.toMatchObject({ blockHash: BLOCK_HASH });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getBlockByNumber',
    ]);
    expect(second.calls).toHaveLength(5);
  });

  it('does not turn reorg-produced fallback no-code into deterministic invalidity', async () => {
    let finalizedReads = 0;
    const first = await startRpcServer(successfulHandler({
      blockHash: () => (++finalizedReads === 1 ? BLOCK_HASH : OTHER_BLOCK_HASH),
      code: '0x',
    }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(adapter(fixedRequest())).resolves.toMatchObject({ blockHash: BLOCK_HASH });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_getBlockByNumber',
    ]);
    expect(second.calls).toHaveLength(5);
  });

  it('does not turn reorg-produced fallback out-of-gas into a terminal resource limit', async () => {
    let finalizedReads = 0;
    const first = await startRpcServer(successfulHandler({
      blockHash: () => (++finalizedReads === 1 ? BLOCK_HASH : OTHER_BLOCK_HASH),
      outOfGas: true,
    }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(adapter(fixedRequest())).resolves.toMatchObject({ blockHash: BLOCK_HASH });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getBlockByNumber',
    ]);
    expect(second.calls).toHaveLength(5);
  });

  it('keeps fallback out-of-gas terminal after the same-anchor post-read succeeds', async () => {
    const first = await startRpcServer(successfulHandler({ outOfGas: true }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'resource-limit' });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getBlockByNumber',
    ]);
    expect(second.calls).toHaveLength(0);
  });

  it('stops on terminal no-code evidence without contacting a later endpoint', async () => {
    const first = await startRpcServer(successfulHandler({ code: '0x' }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'no-code' });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
    ]);
    expect(second.calls).toHaveLength(0);
  });

  it('stops on a deterministic contract revert without contacting a later endpoint', async () => {
    const revertData = `0x7e273289${'0'.repeat(63)}1`;
    const first = await startRpcServer(successfulHandler({
      callError: { code: 3, message: 'execution reverted', data: revertData },
    }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });

    let caught: unknown;
    try {
      await adapter(fixedRequest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'revert' });
    expect(caught).not.toHaveProperty('revertData');
    expect(Object.isFrozen(caught)).toBe(true);
    expect(readStrictCurrentFinalizedEvmRevertDataV1(caught)).toBe(revertData);
    expect(readStrictCurrentFinalizedEvmRevertDataV1(
      new CurrentFinalizedEvmCallErrorV1('revert', 'forged'),
    )).toBeUndefined();
    expect(second.calls).toHaveLength(0);
  });

  it('treats explicit revert evidence as terminal when its message also mentions gas', async () => {
    const first = await startRpcServer(successfulHandler({
      callError: { code: 3, message: 'execution reverted: out of gas' },
    }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'revert' });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
    ]);
    expect(second.calls).toHaveLength(0);
  });

  it('keeps mixed revert-and-gas evidence terminal after a stable fallback post-read', async () => {
    const first = await startRpcServer(successfulHandler({
      callError: { code: 3, message: 'execution reverted: gas required exceeds allowance' },
    }));
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'revert' });
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getBlockByNumber',
    ]);
    expect(second.calls).toHaveLength(0);
  });

  it('preserves bounded ABI returns, including EIP-1271 short and wrong magic, for the verifier', async () => {
    const short = await startRpcServer(successfulHandler({ returnData: '0x1626ba7e' }));
    const shortAdapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [short.url],
    });
    await expect(shortAdapter(fixedRequest())).resolves.toMatchObject({
      returnData: '0x1626ba7e',
    });

    const wrong = await startRpcServer(successfulHandler({ returnData: WRONG_MAGIC_RETURN }));
    const wrongAdapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [wrong.url],
    });
    await expect(wrongAdapter(fixedRequest())).resolves.toMatchObject({
      returnData: WRONG_MAGIC_RETURN,
    });
  });

  it('enforces the 65,536-byte cap while streaming, before JSON parsing or failover', async () => {
    const first = await startRpcServer((_call, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      });
      response.write(' '.repeat(40_000));
      response.end(' '.repeat(30_000));
    });
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });

    await expect(adapter(fixedRequest())).rejects.toMatchObject({ code: 'resource-limit' });
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
  });

  it('cancels the actual loopback HTTP operation and does not fail over', async () => {
    const received = deferred<void>();
    const connectionClosed = deferred<void>();
    const first = await startRpcServer((_call, response) => {
      response.on('close', () => connectionClosed.resolve());
      received.resolve();
      // Deliberately leave the response open until AbortSignal cancels fetch.
    });
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });
    const controller = new AbortController();
    const operation = adapter(fixedRequest({ signal: controller.signal }));

    await received.promise;
    controller.abort(new Error('caller stopped'));
    // The transport closes as rpc-unavailable; the verifier-owned caller
    // signal maps this path to the public `cancelled` disposition.
    await expect(operation).rejects.toMatchObject({ code: 'rpc-unavailable' });
    await connectionClosed.promise;
    expect(second.calls).toHaveLength(0);
  });

  it('enforces one four-second whole-attempt budget, cancels it, then advances', async () => {
    const firstClosed = deferred<void>();
    const delayedSuccess = successfulHandler();
    const first = await startRpcServer(async (call, response, request) => {
      if (call.method === 'eth_call') response.on('close', () => firstClosed.resolve());
      // Each RPC is individually under four seconds, but the chain/header/code
      // work consumes most of the one shared attempt budget. The call is then
      // cancelled by that original timer (a per-RPC timer would wrongly pass).
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      if (!response.destroyed) await delayedSuccess(call, response, request);
    });
    const second = await startRpcServer(successfulHandler());
    const adapter = createStrictCurrentFinalizedEvmChainAdapterV1({
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });
    const started = Date.now();

    await expect(adapter(fixedRequest())).resolves.toMatchObject({ chainId: CHAIN_ID });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1 - 200);
    expect(elapsed).toBeLessThan(CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1);
    await firstClosed.promise;
    expect(first.calls).toHaveLength(4);
    expect(second.calls).toHaveLength(4);
  }, 12_000);

  it('rejects unsafe configuration and more than two distinct normalized endpoints', () => {
    const third = 'http://127.0.0.1:3';
    for (const config of [
      { chainId: '020430', endpoints: ['http://127.0.0.1:1'] },
      { chainId: CHAIN_ID, endpoints: [] },
      { chainId: CHAIN_ID, endpoints: ['ftp://127.0.0.1/a'] },
      { chainId: CHAIN_ID, endpoints: ['http://127.0.0.1/a#fragment'] },
      { chainId: CHAIN_ID, endpoints: [
        'http://127.0.0.1:1',
        'http://127.0.0.1:2',
        third,
      ] },
      { chainId: CHAIN_ID, endpoints: ['http://127.0.0.1:1'], peerEndpoint: third },
    ]) {
      expect(() => createStrictCurrentFinalizedEvmChainAdapterV1(
        config as StrictCurrentFinalizedEvmRpcConfigV1,
      )).toThrow(TypeError);
    }
  });
});

interface SuccessfulHandlerOptions {
  readonly blockHash?: string | (() => string);
  readonly callError?: {
    readonly code: number;
    readonly message: string;
    readonly data?: string;
  };
  readonly code?: string;
  readonly outOfGas?: boolean;
  readonly returnData?: string;
  readonly revert?: boolean;
}

function successfulHandler(options: SuccessfulHandlerOptions = {}): LoopbackHandler {
  return (call, response) => {
    switch (call.method) {
      case 'eth_chainId':
        sendResult(response, call, CHAIN_QUANTITY);
        return;
      case 'eth_getBlockByNumber': {
        const selectedHash = typeof options.blockHash === 'function'
          ? options.blockHash()
          : (options.blockHash ?? BLOCK_HASH);
        sendResult(response, call, { number: '0x7b', hash: selectedHash });
        return;
      }
      case 'eth_getCode':
        sendResult(response, call, options.code ?? '0x6000');
        return;
      case 'eth_call':
        if (options.callError) {
          sendError(
            response,
            call,
            options.callError.code,
            options.callError.message,
            options.callError.data,
          );
        } else if (options.outOfGas) {
          sendError(response, call, -32000, 'out of gas');
        } else if (options.revert) {
          sendError(response, call, 3, 'execution reverted');
        } else {
          sendResult(response, call, options.returnData ?? MAGIC_RETURN);
        }
        return;
      default:
        sendError(response, call, -32601, 'method not found');
    }
  };
}

function fixedRequest(
  overrides: Partial<CurrentFinalizedEvmCallRequestV1> = {},
): CurrentFinalizedEvmCallRequestV1 {
  return {
    chainId: CHAIN_ID,
    to: TO,
    from: CONTROL_EIP1271_CALL_FROM_V1,
    data: CANONICAL_CALL_DATA,
    gasLimit: CONTROL_EIP1271_GAS_LIMIT_V1,
    maxReturnBytes: CONTROL_EIP1271_MAX_RETURN_BYTES_V1,
    maxRpcResponseBytes: CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1,
    attemptTimeoutMs: CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1,
    maxAttempts: CONTROL_EIP1271_MAX_ATTEMPTS_V1,
    endpointAttemptPolicy: CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1,
    maxConcurrentCallsPerChain: CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1,
    totalDeadlineMs: CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1,
    ccipReadEnabled: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
