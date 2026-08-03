import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ChainIdV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';

import {
  CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1,
} from '../src/current-finalized-evm-read-profile.js';
import {
  CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1,
  CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CALLS_V1,
  CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_DECLARED_RETURN_BYTES_V1,
  CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1,
  createCurrentFinalizedEvmSnapshotBudgetV1,
  type StrictCurrentFinalizedEvmSnapshotSessionV1,
} from '../src/current-finalized-evm-snapshot.js';
import {
  type StrictCurrentFinalizedEvmReadCallV1,
} from '../src/strict-current-finalized-evm-rpc.js';
import { createStrictCurrentFinalizedEvmSnapshotScopeV1 } from '../src/index.js';
import { resetFinalizedChainReadRegistryForTests } from '../src/finalized-chain-read-admission.js';
import {
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcError,
  sendJsonRpcResult,
  type LoopbackJsonRpcHandler,
} from './loopback-rpc-harness.js';

const CHAIN_ID = '20430' as ChainIdV1;
const CHAIN_QUANTITY = '0x4fce';
const TO = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const OTHER_TO = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const PREFLIGHT_PROBE_TO = '0x0000000000000000000000000000000000000000';
const BLOCK_HASH = `0x${'22'.repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${'23'.repeat(32)}`;
const FIRST_DATA = '0x11111111';
const SECOND_DATA = '0x22222222';
const HASH_REFERENCE = Object.freeze({ blockHash: BLOCK_HASH, requireCanonical: true });
const rpcHarness = createLoopbackJsonRpcTestHarness();

afterEach(async () => {
  await rpcHarness.stopAll();
});

// The snapshot permit now lives in a PROCESS-WIDE registry, so a test that
// leaves one held would fail the next test for a reason it never caused.
beforeEach(() => {
  resetFinalizedChainReadRegistryForTests();
});

describe('RFC-64 scoped current-finalized EVM snapshot', () => {
  it('pins dynamic batches to one endpoint and EIP-1898 anchor with one code check', async () => {
    const server = await rpcHarness.start(successfulHandler());
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });

    const result = await withSnapshot(request(), async (session) => {
      expect(Object.isFrozen(session)).toBe(true);
      expect(Object.isFrozen(session.read)).toBe(true);
      expect(session).toMatchObject({
        chainId: CHAIN_ID,
        blockNumber: '123',
        blockHash: BLOCK_HASH,
      });
      return [
        ...(await session.read([call(FIRST_DATA)])),
        ...(await session.read([call(SECOND_DATA)])),
      ];
    });

    expect(Object.isFrozen(withSnapshot)).toBe(true);
    expect(result).toEqual(['0xaaaa', '0xbbbb']);
    expect(server.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getCode',
      'eth_call',
      'eth_call',
    ]);
    const anchored = server.calls.filter(({ method }) => (
      method === 'eth_getCode' || method === 'eth_call'
    ));
    expect(anchored.map(({ params }) => params[1])).toEqual([
      HASH_REFERENCE,
      HASH_REFERENCE,
      HASH_REFERENCE,
      HASH_REFERENCE,
      HASH_REFERENCE,
    ]);
  });

  it('fails over during preflight but invokes the scoped consumer exactly once', async () => {
    const first = await rpcHarness.start((_call, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('unavailable');
    });
    const second = await rpcHarness.start(successfulHandler());
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });
    let consumers = 0;

    await expect(withSnapshot(request(), async (session) => {
      consumers += 1;
      return session.read([call(FIRST_DATA)]);
    })).resolves.toEqual(['0xaaaa']);

    expect(consumers).toBe(1);
    expect(first.calls.map(({ method }) => method)).toEqual(['eth_chainId']);
    expect(second.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getCode',
      'eth_call',
    ]);
  });

  it('fails over before consumer execution when an endpoint rejects the EIP-1898 read profile', async () => {
    const baseHandler = successfulHandler();
    const first = await rpcHarness.start((rpcCall, response, rawRequest) => {
      if (rpcCall.method === 'eth_call' && isPreflightProbe(rpcCall)) {
        sendJsonRpcError(response, rpcCall, -32602, 'EIP-1898 block reference unsupported');
        return;
      }
      return baseHandler(rpcCall, response, rawRequest);
    });
    const second = await rpcHarness.start(successfulHandler());
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });
    let consumers = 0;

    await expect(withSnapshot(request(), async (session) => {
      consumers += 1;
      return session.read([call(FIRST_DATA)]);
    })).resolves.toEqual(['0xaaaa']);

    expect(consumers).toBe(1);
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
    ]);
    expect(second.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getCode',
      'eth_call',
    ]);
  });

  it('fails over before consumer execution when the capability code probe is malformed', async () => {
    const baseHandler = successfulHandler();
    const malformed = await rpcHarness.start((rpcCall, response, rawRequest) => {
      if (rpcCall.method === 'eth_getCode') {
        sendJsonRpcResult(response, rpcCall, '0x0');
        return;
      }
      return baseHandler(rpcCall, response, rawRequest);
    });
    const backup = await rpcHarness.start(successfulHandler());
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [malformed.url, backup.url],
    });
    let consumers = 0;

    await expect(withSnapshot(request(), async (session) => {
      consumers += 1;
      return session.read([call(FIRST_DATA)]);
    })).resolves.toEqual(['0xaaaa']);

    expect(consumers).toBe(1);
    expect(malformed.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
    ]);
    expect(backup.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getCode',
      'eth_call',
    ]);
  });

  it('classifies malformed deployed-code bytes inside a snapshot as RPC failure', async () => {
    const baseHandler = successfulHandler();
    const server = await rpcHarness.start((rpcCall, response, rawRequest) => {
      if (rpcCall.method === 'eth_getCode' && rpcCall.params[0] === TO) {
        sendJsonRpcResult(response, rpcCall, '0xABC0');
        return;
      }
      return baseHandler(rpcCall, response, rawRequest);
    });
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });

    await expect(withSnapshot(request(), async (session) => (
      session.read([call(FIRST_DATA)])
    ))).rejects.toMatchObject({ code: 'rpc-unavailable' });
    expect(server.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getCode',
    ]);
  });

  it('never retries or replays the consumer after callback execution begins', async () => {
    const baseHandler = successfulHandler();
    const first = await rpcHarness.start((rpcCall, response, rawRequest) => {
      if (rpcCall.method !== 'eth_call' || isPreflightProbe(rpcCall)) {
        return baseHandler(rpcCall, response, rawRequest);
      }
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('unavailable');
    });
    const second = await rpcHarness.start(successfulHandler());
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [first.url, second.url],
    });
    let consumers = 0;

    await expect(withSnapshot(request(), async (session) => {
      consumers += 1;
      return session.read([call(FIRST_DATA)]);
    })).rejects.toMatchObject({ code: 'rpc-unavailable' });

    expect(consumers).toBe(1);
    expect(first.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
      'eth_getCode',
      'eth_call',
    ]);
    expect(second.calls).toHaveLength(0);
  });

  it('rejects a numbered fallback batch when its same-endpoint hash changes', async () => {
    const server = await rpcHarness.start((rpcCall, response) => {
      switch (rpcCall.method) {
        case 'eth_chainId':
          sendJsonRpcResult(response, rpcCall, CHAIN_QUANTITY);
          return;
        case 'eth_getBlockByNumber':
          sendJsonRpcResult(response, rpcCall, {
            number: '0x7b',
            hash: rpcCall.params[0] === 'finalized' ? BLOCK_HASH : OTHER_BLOCK_HASH,
          });
          return;
        case 'eth_getCode':
          sendJsonRpcResult(response, rpcCall, '0x6000');
          return;
        case 'eth_call':
          sendJsonRpcResult(response, rpcCall, '0xaaaa');
          return;
        default:
          sendJsonRpcError(response, rpcCall, -32601, 'method not found');
      }
    });
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(withSnapshot(request(), async (session) => (
      session.read([call(FIRST_DATA)])
    ))).rejects.toMatchObject({ code: 'finalized-state-unavailable' });
    expect(server.calls.find(({ method }) => method === 'eth_call')?.params[1]).toBe('0x7b');
  });

  it('does not cache deployment evidence from a failed numbered-anchor proof', async () => {
    let numberedHeaderReads = 0;
    let codeReads = 0;
    const server = await rpcHarness.start((rpcCall, response) => {
      switch (rpcCall.method) {
        case 'eth_chainId':
          sendJsonRpcResult(response, rpcCall, CHAIN_QUANTITY);
          return;
        case 'eth_getBlockByNumber': {
          const finalizedLookup = rpcCall.params[0] === 'finalized';
          if (!finalizedLookup) numberedHeaderReads += 1;
          sendJsonRpcResult(response, rpcCall, {
            number: '0x7b',
            hash: finalizedLookup || numberedHeaderReads !== 2 ? BLOCK_HASH : OTHER_BLOCK_HASH,
          });
          return;
        }
        case 'eth_getCode': {
          const isProbe = rpcCall.params[0] === PREFLIGHT_PROBE_TO;
          if (!isProbe) codeReads += 1;
          sendJsonRpcResult(
            response,
            rpcCall,
            isProbe || codeReads === 1 ? '0x6000' : '0x',
          );
          return;
        }
        case 'eth_call':
          sendJsonRpcResult(response, rpcCall, '0xaaaa');
          return;
        default:
          sendJsonRpcError(response, rpcCall, -32601, 'method not found');
      }
    });
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(withSnapshot(request(), async (session) => {
      await expect(session.read([call(FIRST_DATA)]))
        .rejects.toMatchObject({ code: 'finalized-state-unavailable' });
      await expect(session.read([call(FIRST_DATA)]))
        .rejects.toMatchObject({ code: 'no-code' });
      return 'cache-remained-authenticated';
    })).resolves.toBe('cache-remained-authenticated');
    expect(codeReads).toBe(2);
  });

  it('authenticates every numbered-anchor-dependent failure before exposing it', async () => {
    const failureCases = [
      { kind: 'no-code', stableCode: 'no-code', maxReturnBytes: 2 },
      { kind: 'revert', stableCode: 'revert', maxReturnBytes: 2 },
      { kind: 'malformed-return', stableCode: 'malformed-return', maxReturnBytes: 1 },
      { kind: 'resource-limit', stableCode: 'resource-limit', maxReturnBytes: 2 },
    ] as const;
    for (const failure of failureCases) {
      for (const [postHash, expectedCode] of [
        [OTHER_BLOCK_HASH, 'finalized-state-unavailable'],
        [BLOCK_HASH, failure.stableCode],
      ] as const) {
        let numberedHeaderReads = 0;
        const server = await rpcHarness.start((rpcCall, response) => {
          switch (rpcCall.method) {
            case 'eth_chainId':
              sendJsonRpcResult(response, rpcCall, CHAIN_QUANTITY);
              return;
            case 'eth_getBlockByNumber': {
              const finalizedLookup = rpcCall.params[0] === 'finalized';
              if (!finalizedLookup) numberedHeaderReads += 1;
              sendJsonRpcResult(response, rpcCall, {
                number: '0x7b',
                hash: finalizedLookup || numberedHeaderReads === 1 ? BLOCK_HASH : postHash,
              });
              return;
            }
            case 'eth_getCode':
              sendJsonRpcResult(
                response,
                rpcCall,
                rpcCall.params[0] === PREFLIGHT_PROBE_TO || failure.kind !== 'no-code'
                  ? '0x6000'
                  : '0x',
              );
              return;
            case 'eth_call':
              if (isPreflightProbe(rpcCall)) {
                sendJsonRpcResult(response, rpcCall, '0x');
              } else if (failure.kind === 'revert') {
                sendJsonRpcError(response, rpcCall, 3, 'execution reverted');
              } else if (failure.kind === 'resource-limit') {
                sendJsonRpcError(response, rpcCall, -32000, 'out of gas');
              } else {
                sendJsonRpcResult(response, rpcCall, '0xaaaa');
              }
              return;
            default:
              sendJsonRpcError(response, rpcCall, -32601, 'method not found');
          }
        });
        const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
          owner: 'rfc64',
          chainId: CHAIN_ID,
          endpoints: [server.url],
          blockReferenceProfile: 'trusted-block-number-hash-sandwich',
        });

        await expect(withSnapshot(request(), async (session) => (
          session.read([call(FIRST_DATA, failure.maxReturnBytes)])
        ))).rejects.toMatchObject({ code: expectedCode });
        const expectedCalls = failure.kind === 'no-code' ? 0 : 1;
        expect(server.calls.filter((rpcCall) => (
          rpcCall.method === 'eth_call' && !isPreflightProbe(rpcCall)
        )))
          .toHaveLength(expectedCalls);
        expect(server.calls.filter(({ method }) => method === 'eth_chainId'))
          .toHaveLength(1);
      }
    }
  });

  it('rechecks the numbered fallback anchor after the scoped consumer completes', async () => {
    let numberedHeaderReads = 0;
    const server = await rpcHarness.start((rpcCall, response) => {
      switch (rpcCall.method) {
        case 'eth_chainId':
          sendJsonRpcResult(response, rpcCall, CHAIN_QUANTITY);
          return;
        case 'eth_getBlockByNumber': {
          const finalizedLookup = rpcCall.params[0] === 'finalized';
          if (!finalizedLookup) numberedHeaderReads += 1;
          sendJsonRpcResult(response, rpcCall, {
            number: '0x7b',
            hash: finalizedLookup || numberedHeaderReads <= 2
              ? BLOCK_HASH
              : OTHER_BLOCK_HASH,
          });
          return;
        }
        case 'eth_getCode':
          sendJsonRpcResult(response, rpcCall, '0x6000');
          return;
        case 'eth_call':
          sendJsonRpcResult(response, rpcCall, '0xaaaa');
          return;
        default:
          sendJsonRpcError(response, rpcCall, -32601, 'method not found');
      }
    });
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
      blockReferenceProfile: 'trusted-block-number-hash-sandwich',
    });

    await expect(withSnapshot(request(), async (session) => {
      await session.read([call(FIRST_DATA)]);
      return 'must-not-escape';
    })).rejects.toMatchObject({ code: 'finalized-state-unavailable' });
    expect(numberedHeaderReads).toBe(3);
  });

  it('closes an escaped session and cannot mix it into a later adapter scope', async () => {
    const first = await rpcHarness.start(successfulHandler());
    const second = await rpcHarness.start(successfulHandler());
    const firstScope = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [first.url],
    });
    const secondScope = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [second.url],
    });
    let escaped: StrictCurrentFinalizedEvmSnapshotSessionV1 | undefined;
    await firstScope(request(), async (session) => {
      escaped = session;
      return session.read([call(FIRST_DATA)]);
    });
    const firstCalls = first.calls.length;

    await expect(escaped!.read([call(SECOND_DATA)]))
      .rejects.toMatchObject({ code: 'rpc-unavailable' });
    await secondScope(request(), async () => {
      await expect(escaped!.read([call(SECOND_DATA)]))
        .rejects.toMatchObject({ code: 'rpc-unavailable' });
    });
    expect(first.calls).toHaveLength(firstCalls);
    expect(second.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
    ]);
  });

  it('contends across INDEPENDENTLY constructed scopes on one chain', async () => {
    // The two saturation tests below both reuse a single `withSnapshot`
    // handle, so they pass identically whether the permit is per-instance or
    // per-chain — they cannot discriminate the thing that actually matters.
    // Production builds a fresh scope per RFC64 precommit invocation
    // (`finalized-vm-agent-precommit-v1.ts`), so THIS is the real shape: two
    // handles, one chain, one permit.
    const callStarted = deferred<void>();
    const releaseCall = deferred<void>();
    const baseHandler = successfulHandler();
    const server = await rpcHarness.start(async (rpcCall, response, rawRequest) => {
      if (rpcCall.method === 'eth_call' && !isPreflightProbe(rpcCall)) {
        callStarted.resolve(undefined);
        await releaseCall.promise;
      }
      await baseHandler(rpcCall, response, rawRequest);
    });
    const holder = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });
    const contender = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'w2-page',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });
    expect(holder).not.toBe(contender);

    const first = holder(request(), async (session) => {
      await session.read([call(FIRST_DATA)]);
      return 'first';
    });
    await callStarted.promise;

    await expect(contender(request(), async () => 'second')).rejects.toMatchObject({
      code: 'concurrency-saturated',
      // The refusal names the owner holding the lane, so an operator can tell
      // which path to look at.
      message: expect.stringContaining('held by rfc64'),
    });

    releaseCall.resolve(undefined);
    await expect(first).resolves.toBe('first');

    // The lane is genuinely reusable by the other owner once released.
    await expect(contender(request(), async () => 'third')).resolves.toBe('third');
  });

  it('drains an unawaited batch before releasing its single snapshot permit', async () => {
    const callStarted = deferred<void>();
    const releaseCall = deferred<void>();
    const baseHandler = successfulHandler();
    const server = await rpcHarness.start(async (rpcCall, response, rawRequest) => {
      if (rpcCall.method === 'eth_call' && !isPreflightProbe(rpcCall)) {
        callStarted.resolve(undefined);
        await releaseCall.promise;
      }
      await baseHandler(rpcCall, response, rawRequest);
    });
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });
    const first = withSnapshot(request(), async (session) => {
      void session.read([call(FIRST_DATA)]);
      return 'must-not-escape';
    });
    await callStarted.promise;

    await expect(withSnapshot(request(), async () => 'second'))
      .rejects.toMatchObject({ code: 'concurrency-saturated' });
    releaseCall.resolve(undefined);
    await expect(first).rejects.toMatchObject({
      code: 'rpc-unavailable',
      message: expect.stringContaining('unawaited read'),
    });
  });

  it('owns the exact rejected promise returned by an unawaited snapshot read', async () => {
    const callStarted = deferred<void>();
    const releaseCall = deferred<void>();
    const baseHandler = successfulHandler();
    const server = await rpcHarness.start(async (rpcCall, response, rawRequest) => {
      if (rpcCall.method !== 'eth_call' || isPreflightProbe(rpcCall)) {
        await baseHandler(rpcCall, response, rawRequest);
        return;
      }
      callStarted.resolve(undefined);
      await releaseCall.promise;
      sendJsonRpcError(response, rpcCall, -32000, 'forced rejection');
    });
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (cause: unknown) => unhandled.push(cause);
    process.on('unhandledRejection', onUnhandled);
    try {
      const scope = withSnapshot(request(), async (session) => {
        void session.read([call(FIRST_DATA)]);
        return 'must-not-escape';
      });
      await callStarted.promise;
      releaseCall.resolve(undefined);
      await expect(scope).rejects.toMatchObject({
        code: 'rpc-unavailable',
        message: expect.stringContaining('unawaited read'),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects concurrent dynamic batches and more than four calls before extra I/O', async () => {
    const callStarted = deferred<void>();
    const releaseCall = deferred<void>();
    const baseHandler = successfulHandler();
    const server = await rpcHarness.start(async (rpcCall, response, rawRequest) => {
      if (rpcCall.method === 'eth_call' && !isPreflightProbe(rpcCall)) {
        callStarted.resolve(undefined);
        await releaseCall.promise;
      }
      await baseHandler(rpcCall, response, rawRequest);
    });
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });

    await withSnapshot(request(), async (session) => {
      const first = session.read([call(FIRST_DATA)]);
      await callStarted.promise;
      await expect(session.read([call(SECOND_DATA)]))
        .rejects.toMatchObject({ code: 'concurrency-saturated' });
      releaseCall.resolve(undefined);
      await expect(first).resolves.toEqual(['0xaaaa']);

      const callsBeforeOversizedBatch = server.calls.length;
      await expect(session.read(Array.from(
        { length: CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1 + 1 },
        () => call(FIRST_DATA),
      ))).rejects.toMatchObject({ code: 'rpc-unavailable' });
      expect(server.calls).toHaveLength(callsBeforeOversizedBatch);
    });
  });

  it('cancels the actual in-flight RPC from the scope-owned signal', async () => {
    const started = deferred<void>();
    const closed = deferred<void>();
    const baseHandler = successfulHandler();
    const server = await rpcHarness.start(async (rpcCall, response, rawRequest) => {
      if (rpcCall.method !== 'eth_call' || isPreflightProbe(rpcCall)) {
        return baseHandler(rpcCall, response, rawRequest);
      }
      response.on('close', () => closed.resolve(undefined));
      started.resolve(undefined);
    });
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });
    const controller = new AbortController();
    const operation = withSnapshot(
      { chainId: CHAIN_ID, signal: controller.signal },
      async (session) => session.read([call(FIRST_DATA)]),
    );
    await started.promise;
    controller.abort(new Error('caller stopped'));

    await expect(Promise.race([
      operation.then(() => 'settled', () => 'settled'),
      delay(500).then(() => 'still-pending'),
    ])).resolves.toBe('settled');
    await expect(operation).rejects.toMatchObject({ code: 'rpc-unavailable' });
    await closed.promise;
  });

  it('aborts an in-flight RPC when the total snapshot deadline expires', async () => {
    const consumerEntered = deferred<void>();
    const started = deferred<void>();
    const closed = deferred<void>();
    const baseHandler = successfulHandler();
    const server = await rpcHarness.start(async (rpcCall, response, rawRequest) => {
      if (rpcCall.method !== 'eth_call' || isPreflightProbe(rpcCall)) {
        return baseHandler(rpcCall, response, rawRequest);
      }
      response.on('close', () => closed.resolve(undefined));
      started.resolve(undefined);
    });
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const operation = withSnapshot(
        request(),
        async (session) => {
          consumerEntered.resolve(undefined);
          await delay(CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1 - 1_000);
          return session.read([call(FIRST_DATA)]);
        },
      );
      const outcome = operation.then(
        () => undefined,
        (cause: unknown) => cause,
      );
      await consumerEntered.promise;
      await vi.advanceTimersByTimeAsync(
        CURRENT_FINALIZED_EVM_SNAPSHOT_TOTAL_DEADLINE_MS_V1 - 1_000,
      );
      await started.promise;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await outcome).toMatchObject({ code: 'rpc-timeout' });
      await closed.promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a hung dynamic RPC at its per-request deadline', async () => {
    const started = deferred<void>();
    const closed = deferred<void>();
    const baseHandler = successfulHandler();
    const server = await rpcHarness.start(async (rpcCall, response, rawRequest) => {
      if (rpcCall.method !== 'eth_call' || isPreflightProbe(rpcCall)) {
        return baseHandler(rpcCall, response, rawRequest);
      }
      response.on('close', () => closed.resolve(undefined));
      started.resolve(undefined);
    });
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const operation = withSnapshot(
        request(),
        async (session) => session.read([call(FIRST_DATA)]),
      );
      const outcome = operation.then(
        () => undefined,
        (cause: unknown) => cause,
      );
      await started.promise;
      await vi.advanceTimersByTimeAsync(CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1);

      expect(await outcome).toMatchObject({ code: 'rpc-timeout' });
      await closed.promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a successful dynamic RPC result delivered after its deadline', async () => {
    const dynamicCallStarted = deferred<void>();
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        readonly id: number;
        readonly method: string;
        readonly params: readonly unknown[];
      };
      let result: unknown;
      switch (body.method) {
        case 'eth_chainId':
          result = CHAIN_QUANTITY;
          break;
        case 'eth_getBlockByNumber':
          result = { number: '0x7b', hash: BLOCK_HASH };
          break;
        case 'eth_getCode':
          result = '0x6000';
          break;
        case 'eth_call':
          if (isPreflightProbe({ params: body.params })) {
            result = '0x';
          } else {
            dynamicCallStarted.resolve(undefined);
            await delay(CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1 + 500);
            result = '0xaaaa';
          }
          break;
        default:
          throw new Error(`Unexpected JSON-RPC method ${body.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: ['https://snapshot-rpc.test'],
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const operation = withSnapshot(
        request(),
        async (session) => session.read([call(FIRST_DATA)]),
      );
      const outcome = operation.then(
        () => undefined,
        (cause: unknown) => cause,
      );
      await dynamicCallStarted.promise;
      await vi.advanceTimersByTimeAsync(CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1 + 500);

      expect(await outcome).toMatchObject({ code: 'rpc-timeout' });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('preserves a terminal batch failure that precedes a sibling RPC deadline', async () => {
    const siblingStarted = deferred<void>();
    const siblingClosed = deferred<void>();
    const baseHandler = successfulHandler();
    const server = await rpcHarness.start(async (rpcCall, response, rawRequest) => {
      if (rpcCall.method !== 'eth_getCode' || rpcCall.params[0] === PREFLIGHT_PROBE_TO) {
        return baseHandler(rpcCall, response, rawRequest);
      }
      if (rpcCall.params[0] === TO) {
        sendJsonRpcResult(response, rpcCall, '0x');
        return;
      }
      response.on('close', () => siblingClosed.resolve(undefined));
      siblingStarted.resolve(undefined);
    });
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const operation = withSnapshot(request(), async (session) => session.read([
        call(FIRST_DATA),
        Object.freeze({ to: OTHER_TO, data: SECOND_DATA, maxReturnBytes: 2 }),
      ]));
      const rejection = expect(operation).rejects.toMatchObject({ code: 'no-code' });
      await siblingStarted.promise;
      await vi.advanceTimersByTimeAsync(CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1);

      await rejection;
      await siblingClosed.promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects forged block selectors, hostile batches, and non-callable consumers pre-I/O', async () => {
    const server = await rpcHarness.start(successfulHandler());
    const withSnapshot = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });
    await expect(withSnapshot(
      { ...request(), blockTag: 'latest' } as never,
      async () => undefined,
    )).rejects.toMatchObject({ code: 'rpc-unavailable' });
    await expect(withSnapshot(request(), null as never))
      .rejects.toMatchObject({ code: 'rpc-unavailable' });
    expect(server.calls).toHaveLength(0);

    await expect(withSnapshot(request(), async (session) => session.read([
      { ...call(FIRST_DATA), blockHash: OTHER_BLOCK_HASH } as never,
    ]))).rejects.toMatchObject({ code: 'rpc-unavailable' });
    expect(server.calls.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_call',
    ]);
  });

  it('enforces pure aggregate batch and declared-return budgets before transport', () => {
    const oneCall = [call(FIRST_DATA, 1)];
    const batchBudget = createCurrentFinalizedEvmSnapshotBudgetV1();
    for (let index = 0; index < CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1; index += 1) {
      batchBudget.consume(oneCall);
    }
    expect(batchBudget.snapshot()).toEqual({
      batches: CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1,
      calls: CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1,
      declaredReturnBytes: CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1,
    });
    expect(() => batchBudget.consume(oneCall)).toThrow(RangeError);

    const returnBudget = createCurrentFinalizedEvmSnapshotBudgetV1();
    const maximalBatch = Array.from(
      { length: CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1 },
      () => call(FIRST_DATA, CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1),
    );
    const batchesToReturnCap = CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_DECLARED_RETURN_BYTES_V1
      / (CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1
        * CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1);
    for (let index = 0; index < batchesToReturnCap; index += 1) {
      returnBudget.consume(maximalBatch);
    }
    expect(returnBudget.snapshot()).toMatchObject({
      calls: batchesToReturnCap * CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1,
      declaredReturnBytes: CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_DECLARED_RETURN_BYTES_V1,
    });
    expect(() => returnBudget.consume(oneCall)).toThrow(RangeError);
    expect(CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CALLS_V1).toBe(
      CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1
      * CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1,
    );
  });

  it('enforces aggregate budgets through the public snapshot session before extra I/O', async () => {
    const batchServer = await rpcHarness.start(successfulHandler());
    const batchScope = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [batchServer.url],
    });
    await batchScope(request(), async (session) => {
      for (let index = 0; index < CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_BATCHES_V1; index += 1) {
        await session.read([call(FIRST_DATA)]);
      }
      const callsAtLimit = batchServer.calls.length;
      await expect(session.read([call(FIRST_DATA)]))
        .rejects.toMatchObject({ code: 'resource-limit' });
      expect(batchServer.calls).toHaveLength(callsAtLimit);
    });

    const returnServer = await rpcHarness.start(successfulHandler());
    const returnScope = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'rfc64',
      chainId: CHAIN_ID,
      endpoints: [returnServer.url],
    });
    const maximalBatch = Array.from(
      { length: CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1 },
      () => call(FIRST_DATA, CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1),
    );
    const batchesToReturnCap = CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_DECLARED_RETURN_BYTES_V1
      / (CURRENT_FINALIZED_EVM_READ_MAX_CALLS_V1
        * CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1);
    await returnScope(request(), async (session) => {
      for (let index = 0; index < batchesToReturnCap; index += 1) {
        await session.read(maximalBatch);
      }
      const callsAtLimit = returnServer.calls.length;
      await expect(session.read([call(FIRST_DATA)]))
        .rejects.toMatchObject({ code: 'resource-limit' });
      expect(returnServer.calls).toHaveLength(callsAtLimit);
    });
  });
});

function request(): { readonly chainId: ChainIdV1; readonly signal: AbortSignal } {
  return { chainId: CHAIN_ID, signal: new AbortController().signal };
}

function call(data: string, maxReturnBytes = 2): StrictCurrentFinalizedEvmReadCallV1 {
  return Object.freeze({ to: TO, data, maxReturnBytes });
}

function successfulHandler(): LoopbackJsonRpcHandler {
  return (rpcCall, response) => {
    switch (rpcCall.method) {
      case 'eth_chainId':
        sendJsonRpcResult(response, rpcCall, CHAIN_QUANTITY);
        return;
      case 'eth_getBlockByNumber':
        sendJsonRpcResult(response, rpcCall, { number: '0x7b', hash: BLOCK_HASH });
        return;
      case 'eth_getCode':
        sendJsonRpcResult(response, rpcCall, '0x6000');
        return;
      case 'eth_call': {
        const callObject = rpcCall.params[0] as { readonly data?: unknown };
        if (callObject.data === '0x') sendJsonRpcResult(response, rpcCall, '0x');
        else if (callObject.data === FIRST_DATA) sendJsonRpcResult(response, rpcCall, '0xaaaa');
        else if (callObject.data === SECOND_DATA) sendJsonRpcResult(response, rpcCall, '0xbbbb');
        else sendJsonRpcError(response, rpcCall, -32602, 'unexpected calldata');
        return;
      }
      default:
        sendJsonRpcError(response, rpcCall, -32601, 'method not found');
    }
  };
}

function isPreflightProbe(rpcCall: { readonly params: readonly unknown[] }): boolean {
  const callObject = rpcCall.params[0] as { readonly to?: unknown; readonly data?: unknown };
  return callObject.to === PREFLIGHT_PROBE_TO && callObject.data === '0x';
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
