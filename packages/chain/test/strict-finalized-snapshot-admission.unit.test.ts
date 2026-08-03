import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStrictCurrentFinalizedEvmSnapshotScopeV1 } from '../src/index.js';
import {
  finalizedChainReadRegistryDepth,
  resetFinalizedChainReadRegistryForTests,
} from '../src/finalized-chain-read-admission.js';
import { createLoopbackJsonRpcTestHarness } from './loopback-rpc-harness.js';
import {
  CHAIN_ID,
  FIRST_DATA,
  call,
  deferred,
  isPreflightProbe,
  request,
  successfulHandler,
} from './snapshot-test-fixtures.js';

/**
 * Process-wide snapshot admission.
 *
 * This is deliberately NOT in the snapshot behaviour matrix. The two saturation
 * cases that live there both reuse a single `withSnapshot` handle, so they pass
 * identically whether the permit is per-instance or per-chain — they cannot
 * discriminate the property this file exists to pin. Production builds a fresh
 * scope per RFC64 precommit invocation
 * (`packages/agent/src/rfc64/finalized-vm-agent-precommit-v1.ts`), so the real
 * shape is two handles, one chain, one permit.
 */
const rpcHarness = createLoopbackJsonRpcTestHarness();

afterEach(async () => {
  await rpcHarness.stopAll();
});

beforeEach(() => {
  // Module-scoped permit state is shared by every test in the worker; a leaked
  // permit would fail the NEXT test for a reason it never caused.
  resetFinalizedChainReadRegistryForTests();
});

/** Start a server that parks inside the first non-preflight `eth_call`. */
async function parkedServer() {
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
  return { server, callStarted, releaseCall };
}

describe('process-wide finalized snapshot admission', () => {
  it('contends across INDEPENDENTLY constructed scopes on one chain', async () => {
    const { server, callStarted, releaseCall } = await parkedServer();
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

  it('keeps the pre-existing ownerless public call shape working', async () => {
    // `@origintrail-official/dkg-chain` is published, and this factory is part
    // of its public surface. `{ chainId, endpoints }` must keep constructing a
    // scope — a required `owner` would break every external caller.
    const server = await rpcHarness.start(successfulHandler());
    const legacyShape = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });
    await expect(legacyShape(request(), async () => 'ok')).resolves.toBe('ok');
  });

  it('does NOT let the default owner bypass the shared lane', async () => {
    // The whole point of defaulting rather than requiring is that `foreground`
    // is a real owner, not an escape hatch. If an omitted owner took a private
    // gate, the default would silently reintroduce the defect this work fixes.
    const { server, callStarted, releaseCall } = await parkedServer();
    const ownerless = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });
    const w2 = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'w2-page',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });

    const first = ownerless(request(), async (session) => {
      await session.read([call(FIRST_DATA)]);
      return 'first';
    });
    await callStarted.promise;

    await expect(w2(request(), async () => 'second')).rejects.toMatchObject({
      code: 'concurrency-saturated',
      message: expect.stringContaining('held by foreground'),
    });

    releaseCall.resolve(undefined);
    await expect(first).resolves.toBe('first');
    expect(finalizedChainReadRegistryDepth(CHAIN_ID)).toBe(0);
  });

  it('rejects an unknown explicit owner instead of falling back to the default', async () => {
    const server = await rpcHarness.start(successfulHandler());
    expect(() =>
      createStrictCurrentFinalizedEvmSnapshotScopeV1({
        owner: 'not-an-owner' as never,
        chainId: CHAIN_ID,
        endpoints: [server.url],
      }),
    ).toThrow(/unknown owner/i);
  });

  it('releases the permit when the consumer throws', async () => {
    const server = await rpcHarness.start(successfulHandler());
    const scope = createStrictCurrentFinalizedEvmSnapshotScopeV1({
      owner: 'w2-page',
      chainId: CHAIN_ID,
      endpoints: [server.url],
    });
    await expect(
      scope(request(), async () => {
        throw new Error('consumer exploded');
      }),
    ).rejects.toThrow('consumer exploded');
    expect(finalizedChainReadRegistryDepth(CHAIN_ID)).toBe(0);
    await expect(scope(request(), async () => 'after')).resolves.toBe('after');
  });
});
