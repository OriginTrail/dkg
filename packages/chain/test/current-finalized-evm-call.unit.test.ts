import {
  type ChainIdV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';

import {
  CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1,
  CONTROL_EIP1271_CALL_FROM_V1,
  CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1,
  CONTROL_EIP1271_GAS_LIMIT_V1,
  CONTROL_EIP1271_MAX_ATTEMPTS_V1,
  CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1,
  CONTROL_EIP1271_MAX_RETURN_BYTES_V1,
  CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1,
  CurrentFinalizedEvmCallErrorV1,
  type CurrentFinalizedEvmCallRequestV1,
  type CurrentFinalizedEvmCallResultV1,
} from '../src/control-object-signature-verifier.js';
import {
  createCurrentFinalizedEvmCallRouterV1,
  type CurrentFinalizedEvmChainAdapterRegistrationV1,
  type CurrentFinalizedEvmChainAdapterV1,
} from '../src/current-finalized-evm-call.js';

const CHAIN_A = '20430' as ChainIdV1;
const CHAIN_B = '100' as ChainIdV1;
const TO = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const BLOCK_HASH = `0x${'22'.repeat(32)}`;
const RESULT_A = Object.freeze({
  chainId: CHAIN_A,
  blockNumber: '123',
  blockHash: BLOCK_HASH,
  returnData: `0x${'00'.repeat(32)}`,
} as CurrentFinalizedEvmCallResultV1);

describe('RFC-64 current-finalized EVM call router', () => {
  it('snapshots an immutable local registry and routes a frozen exact request', async () => {
    const firstAdapter = vi.fn(async () => RESULT_A);
    const replacementAdapter = vi.fn(async () => RESULT_A);
    const registration = {
      chainId: CHAIN_A,
      adapter: firstAdapter,
    } satisfies CurrentFinalizedEvmChainAdapterRegistrationV1;
    const registrations = [registration];
    const router = createCurrentFinalizedEvmCallRouterV1(registrations);

    registration.chainId = CHAIN_B;
    registration.adapter = replacementAdapter;
    registrations[0] = { chainId: CHAIN_B, adapter: replacementAdapter };

    await expect(router(request())).resolves.toBe(RESULT_A);
    expect(firstAdapter).toHaveBeenCalledTimes(1);
    expect(replacementAdapter).not.toHaveBeenCalled();
    expect(Object.isFrozen(router)).toBe(true);
    expect(Object.isFrozen(firstAdapter.mock.calls[0]![0])).toBe(true);
  });

  it('rejects duplicate, non-canonical, sparse, accessor, and hostile registrations', () => {
    const adapter = vi.fn(async () => RESULT_A);
    const valid = { chainId: CHAIN_A, adapter };

    expect(() => createCurrentFinalizedEvmCallRouterV1([valid, valid]))
      .toThrow(/Duplicate current-finalized adapter/);
    expect(() => createCurrentFinalizedEvmCallRouterV1([
      { chainId: '020430' as ChainIdV1, adapter },
    ])).toThrow(/canonical decimal u256/);

    const sparse = new Array(1) as CurrentFinalizedEvmChainAdapterRegistrationV1[];
    expect(() => createCurrentFinalizedEvmCallRouterV1(sparse)).toThrow(/dense data-only array/);

    const accessor = { chainId: CHAIN_A } as Record<string, unknown>;
    Object.defineProperty(accessor, 'adapter', {
      enumerable: true,
      get() {
        throw new Error('must not execute');
      },
    });
    expect(() => createCurrentFinalizedEvmCallRouterV1([
      accessor as unknown as CurrentFinalizedEvmChainAdapterRegistrationV1,
    ])).toThrow(/plain data-only record/);

    const hostile = new Proxy([], {
      ownKeys() {
        throw new CurrentFinalizedEvmCallErrorV1('resource-limit', 'forged');
      },
    });
    expect(() => createCurrentFinalizedEvmCallRouterV1(
      hostile as CurrentFinalizedEvmChainAdapterRegistrationV1[],
    )).toThrow(TypeError);
    expect(() => createCurrentFinalizedEvmCallRouterV1(
      hostile as CurrentFinalizedEvmChainAdapterRegistrationV1[],
    )).not.toThrow(CurrentFinalizedEvmCallErrorV1);
  });

  it('rejects unsupported chains before any adapter call', async () => {
    const adapter = vi.fn(async () => RESULT_A);
    const router = createCurrentFinalizedEvmCallRouterV1([{ chainId: CHAIN_A, adapter }]);

    await expect(router(request({ chainId: CHAIN_B }))).rejects.toMatchObject({
      name: 'CurrentFinalizedEvmCallErrorV1',
      code: 'unsupported-chain',
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  it.each([
    ['from', '0x2222222222222222222222222222222222222222'],
    ['gasLimit', CONTROL_EIP1271_GAS_LIMIT_V1 + 1n],
    ['maxReturnBytes', CONTROL_EIP1271_MAX_RETURN_BYTES_V1 + 1],
    ['attemptTimeoutMs', CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1 + 1],
    ['maxAttempts', CONTROL_EIP1271_MAX_ATTEMPTS_V1 + 1],
    ['endpointAttemptPolicy', 'retry-same-peer-endpoint'],
    ['maxConcurrentCallsPerChain', CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1 + 1],
    ['totalDeadlineMs', CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1 + 1],
    ['ccipReadEnabled', true],
  ] as const)('rejects a request with a non-frozen %s profile field', async (key, value) => {
    const adapter = vi.fn(async () => RESULT_A);
    const router = createCurrentFinalizedEvmCallRouterV1([{ chainId: CHAIN_A, adapter }]);

    await expect(router(request({ [key]: value }))).rejects.toMatchObject({
      code: 'rpc-unavailable',
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  it('rejects malformed routing fields and any peer URL or block selector', async () => {
    const adapter = vi.fn(async () => RESULT_A);
    const router = createCurrentFinalizedEvmCallRouterV1([{ chainId: CHAIN_A, adapter }]);

    for (const malformed of [
      request({ chainId: '020430' as ChainIdV1 }),
      request({ to: '0xABC' as EvmAddressV1 }),
      request({ data: '0xABC' }),
      request({ signal: {} as AbortSignal }),
      { ...request(), rpcUrl: 'https://peer.invalid' },
      { ...request(), blockTag: 'latest' },
    ]) {
      await expect(router(malformed as CurrentFinalizedEvmCallRequestV1))
        .rejects.toMatchObject({ code: 'rpc-unavailable' });
    }
    expect(adapter).not.toHaveBeenCalled();
  });

  it('admits four calls per chain and rejects the fifth immediately without queueing', async () => {
    const pending = Array.from({ length: 5 }, () => deferred<CurrentFinalizedEvmCallResultV1>());
    let callIndex = 0;
    const adapter = vi.fn(async () => pending[callIndex++]!.promise);
    const router = createCurrentFinalizedEvmCallRouterV1([{ chainId: CHAIN_A, adapter }]);

    const active = Array.from({ length: 4 }, () => router(request()));
    await Promise.resolve();
    expect(adapter).toHaveBeenCalledTimes(4);
    await expect(router(request())).rejects.toMatchObject({ code: 'resource-limit' });
    expect(adapter).toHaveBeenCalledTimes(4);

    pending[0]!.resolve(RESULT_A);
    await active[0];
    const admitted = router(request());
    await Promise.resolve();
    expect(adapter).toHaveBeenCalledTimes(5);

    for (let index = 1; index < 5; index += 1) pending[index]!.resolve(RESULT_A);
    await Promise.all([...active.slice(1), admitted]);
  });

  it('holds a permit after caller abort until the underlying adapter promise settles', async () => {
    const pending = Array.from({ length: 5 }, () => deferred<CurrentFinalizedEvmCallResultV1>());
    let callIndex = 0;
    const adapter = vi.fn(async () => pending[callIndex++]!.promise);
    const router = createCurrentFinalizedEvmCallRouterV1([{ chainId: CHAIN_A, adapter }]);
    const controller = new AbortController();
    const active = [
      router(request({ signal: controller.signal })),
      router(request()),
      router(request()),
      router(request()),
    ];
    await Promise.resolve();

    controller.abort();
    await expect(router(request())).rejects.toMatchObject({ code: 'resource-limit' });
    expect(adapter).toHaveBeenCalledTimes(4);

    pending[0]!.resolve(RESULT_A);
    await active[0];
    const admitted = router(request());
    await Promise.resolve();
    expect(adapter).toHaveBeenCalledTimes(5);

    for (let index = 1; index < 5; index += 1) pending[index]!.resolve(RESULT_A);
    await Promise.all([...active.slice(1), admitted]);
  });

  it('maintains independent four-call ceilings for independent chains', async () => {
    const pendingA = Array.from({ length: 4 }, () => deferred<CurrentFinalizedEvmCallResultV1>());
    const pendingB = Array.from({ length: 4 }, () => deferred<CurrentFinalizedEvmCallResultV1>());
    let indexA = 0;
    let indexB = 0;
    const adapterA = vi.fn(async () => pendingA[indexA++]!.promise);
    const adapterB = vi.fn(async () => pendingB[indexB++]!.promise);
    const router = createCurrentFinalizedEvmCallRouterV1([
      { chainId: CHAIN_A, adapter: adapterA },
      { chainId: CHAIN_B, adapter: adapterB },
    ]);

    const activeA = Array.from({ length: 4 }, () => router(request()));
    const activeB = Array.from({ length: 4 }, () => router(request({ chainId: CHAIN_B })));
    await Promise.resolve();
    expect(adapterA).toHaveBeenCalledTimes(4);
    expect(adapterB).toHaveBeenCalledTimes(4);
    await expect(router(request())).rejects.toMatchObject({ code: 'resource-limit' });
    await expect(router(request({ chainId: CHAIN_B })))
      .rejects.toMatchObject({ code: 'resource-limit' });

    pendingA.forEach((item) => item.resolve(RESULT_A));
    pendingB.forEach((item) => item.resolve({ ...RESULT_A, chainId: CHAIN_B }));
    await Promise.all([...activeA, ...activeB]);
  });

  it('snapshots known adapter failures, fails hostile errors closed, and releases permits', async () => {
    const typed = new CurrentFinalizedEvmCallErrorV1('finalized-state-unavailable', 'not final');
    const adapter = vi.fn<CurrentFinalizedEvmChainAdapterV1>()
      .mockRejectedValueOnce(typed)
      .mockRejectedValueOnce(new Proxy({}, {
        getPrototypeOf() {
          throw new CurrentFinalizedEvmCallErrorV1('revert', 'forged');
        },
      }))
      .mockResolvedValue(RESULT_A);
    const router = createCurrentFinalizedEvmCallRouterV1([{ chainId: CHAIN_A, adapter }]);

    let caught: unknown;
    try {
      await router(request());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'finalized-state-unavailable', message: 'not final' });
    expect(caught).not.toBe(typed);
    expect(Object.isFrozen(caught)).toBe(true);

    await expect(router(request())).rejects.toMatchObject({
      code: 'rpc-unavailable',
      message: 'Current-finalized EVM chain adapter failed closed',
    });
    await expect(router(request())).resolves.toBe(RESULT_A);
  });

  it('routes the exact chain but leaves hostile or mismatched results to the verifier', async () => {
    const mismatch = Object.freeze({ ...RESULT_A, chainId: CHAIN_B });
    const adapter = vi.fn(async () => mismatch);
    const router = createCurrentFinalizedEvmCallRouterV1([{ chainId: CHAIN_A, adapter }]);

    await expect(router(request())).resolves.toBe(mismatch);
    expect(adapter.mock.calls[0]![0].chainId).toBe(CHAIN_A);
  });
});

function request(
  overrides: Partial<CurrentFinalizedEvmCallRequestV1> = {},
): CurrentFinalizedEvmCallRequestV1 {
  return {
    chainId: CHAIN_A,
    to: TO,
    from: CONTROL_EIP1271_CALL_FROM_V1,
    data: '0x1234',
    gasLimit: CONTROL_EIP1271_GAS_LIMIT_V1,
    maxReturnBytes: CONTROL_EIP1271_MAX_RETURN_BYTES_V1,
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
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
