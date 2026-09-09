import { describe, it, expect, vi } from 'vitest';
import { RpcFailoverClient, type RpcEndpoint } from '../src/rpc-failover-client.js';

describe('write transport endpoint validation (#1455)', () => {
  it.each(['populate', 'broadcast', 'receipt'] as const)('rejects an invalid endpoint before %s I/O', async (phase) => {
    const error = Object.assign(new Error('endpoint chain mismatch'), { code: 'RPC_CHAIN_ID_MISMATCH' });
    const validateEndpoint = vi.fn(async () => { throw error; });
    const populateTransaction = vi.fn(async () => ({}));
    const signPopulated = vi.fn(async () => ({ signedTx: '0xsigned', txHash: '0xhash' }));
    const provider = { broadcastTransaction: vi.fn(), getTransactionReceipt: vi.fn() };
    const client = new RpcFailoverClient(
      () => [{ provider, rpcUrl: 'https://invalid-chain.example' }] as unknown as RpcEndpoint[],
      signPopulated, () => 'evm:31337', { validateEndpoint },
    );
    const contract = { connect: () => ({ write: { populateTransaction } }) };
    const signer = { connect: () => ({}) };
    const result = phase === 'populate' ? client.populateAndSign(contract as never, 'write', [], signer as never, 'test')
      : phase === 'broadcast' ? client.broadcast('0xsigned', '0xhash', 'test')
      : client.getReceipt('0xhash');
    await expect(result).rejects.toBe(error);
    expect(validateEndpoint).toHaveBeenCalledOnce();
    expect(populateTransaction).not.toHaveBeenCalled();
    expect(signPopulated).not.toHaveBeenCalled();
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    expect(provider.getTransactionReceipt).not.toHaveBeenCalled();
  });
});
