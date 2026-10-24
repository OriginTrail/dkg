/**
 * GH#2945 - the KA-number floor reconciliation keeps the typed cause of an RPC failure.
 *
 * `ensureReservedKaId` runs on the FIRST use per author per process of a raw lift that carries no seal, and it
 * asks the chain for the author's highest minted number. A failed oracle used to be rewrapped into a plain
 * `Error`, so a typed transient transport failure raised there could never qualify for the same-job retry lane
 * (#2944) that every other pre-send RPC read already uses. It is now thrown as the publisher's existing
 * `RpcPreconditionError` - which the failure writer already unwraps by exactly one level - with the original
 * error as `cause`.
 */
import { describe, expect, it } from 'vitest';
import { NoChainAdapter, RpcEndpointsExhaustedError, isTransientRpcTransportFailureWithoutTransaction } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher, isRpcPreconditionError } from '../src/index.js';
import { makeTestKaAllocator } from './_helpers/ka-allocator.js';

const AUTHOR = '0x00000000000000000000000000000000000000a1';

async function publisherWithOracle(oracle: () => Promise<bigint>) {
  const chain = Object.assign(new NoChainAdapter(), { getMaxKaNumberForAuthor: oracle });
  return new DKGPublisher({
    store: new OxigraphStore(),
    chain,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    kaAllocator: makeTestKaAllocator(),
  });
}

async function ensureReservedKaId(publisher: DKGPublisher): Promise<unknown> {
  return await (publisher as unknown as { ensureReservedKaId(author: string): Promise<unknown> })
    .ensureReservedKaId(AUTHOR).then(() => undefined, (error: unknown) => error);
}

describe('GH#2945 ensureReservedKaId keeps the typed cause of a failed floor reconciliation', () => {
  it('throws the existing RpcPreconditionError carrying the typed transport failure as its cause', async () => {
    const cause = new RpcEndpointsExhaustedError('every endpoint failed', { rpcUrls: [] });
    const publisher = await publisherWithOracle(async () => { throw cause; });

    const error = await ensureReservedKaId(publisher);

    expect(isRpcPreconditionError(error)).toBe(true);
    expect((error as Error).cause).toBe(cause);
    expect(isTransientRpcTransportFailureWithoutTransaction((error as Error).cause)).toBe(true);
    // The text callers match on survives the wrap.
    expect((error as Error).message).toContain('failed to reconcile KA-number floor');
    expect((error as Error).message).toContain(AUTHOR);
  });

  it('wraps a deterministic oracle failure the same way, without pretending it is transient', async () => {
    const cause = new Error('contract call reverted');
    const publisher = await publisherWithOracle(async () => { throw cause; });

    const error = await ensureReservedKaId(publisher);

    expect(isRpcPreconditionError(error)).toBe(true);
    expect((error as Error).cause).toBe(cause);
    expect(isTransientRpcTransportFailureWithoutTransaction((error as Error).cause)).toBe(false);
  });
});
