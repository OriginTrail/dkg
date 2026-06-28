// Unit tests for the parameterized wallet-signed PCA write module. No chain:
// fake walletClient/publicClient assert the tx SHAPE (address/functionName/args),
// revert handling, and the approve-then-action allowance logic. The live on-chain
// path is proven separately against the devnet.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hardhat } from 'viem/chains';
import {
  walletRegisterAgent,
  walletDeregisterAgent,
  walletSetPrimaryNode,
  walletTopUp,
  walletCreatePca,
  type WalletCtx,
} from '../src/ui/wallet/pcaWrites.js';

const NFT = '0x00000000000000000000000000000000000000Ad' as const;
const TOKEN = '0x00000000000000000000000000000000000000C0' as const;
const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const AGENT = '0x2222222222222222222222222222222222222222' as const;

function makeCtx(over: { allowance?: bigint; reverted?: boolean; logs?: unknown[] } = {}): {
  ctx: WalletCtx;
  writeContract: ReturnType<typeof vi.fn>;
  readContract: ReturnType<typeof vi.fn>;
} {
  const writeContract = vi.fn(async () => '0xhash' as `0x${string}`);
  const readContract = vi.fn(async () => over.allowance ?? 0n);
  const waitForTransactionReceipt = vi.fn(async () => ({
    status: over.reverted ? 'reverted' : 'success',
    blockNumber: 7n,
    logs: over.logs ?? [],
  }));
  const ctx = {
    walletClient: { writeContract } as never,
    publicClient: { readContract, waitForTransactionReceipt } as never,
    account: ACCOUNT,
    chain: hardhat,
    nftAddress: NFT,
    tokenAddress: TOKEN,
  };
  return { ctx, writeContract, readContract };
}

describe('pcaWrites — owner-gated actions (no TRAC)', () => {
  it('walletRegisterAgent calls NFT.registerAgent with [accountId, agent]', async () => {
    const { ctx, writeContract } = makeCtx();
    const r = await walletRegisterAgent(ctx, 5n, AGENT);
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: NFT, functionName: 'registerAgent', args: [5n, AGENT], account: ACCOUNT, chain: hardhat }),
    );
    expect(r).toEqual({ hash: '0xhash', blockNumber: 7n });
  });

  it('walletDeregisterAgent calls NFT.deregisterAgent', async () => {
    const { ctx, writeContract } = makeCtx();
    await walletDeregisterAgent(ctx, 5n, AGENT);
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'deregisterAgent', args: [5n, AGENT] }));
  });

  it('walletSetPrimaryNode calls NFT.setPrimaryNode with the node id', async () => {
    const { ctx, writeContract } = makeCtx();
    await walletSetPrimaryNode(ctx, 5n, 42n);
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'setPrimaryNode', args: [5n, 42n] }));
  });

  it('throws when the action tx reverts on-chain', async () => {
    const { ctx } = makeCtx({ reverted: true });
    await expect(walletRegisterAgent(ctx, 5n, AGENT)).rejects.toThrow(/reverted/i);
  });
});

describe('pcaWrites — TRAC-spending actions (approve-then-action)', () => {
  it('walletTopUp SKIPS approve when allowance already suffices', async () => {
    const { ctx, writeContract, readContract } = makeCtx({ allowance: 10_000n });
    await walletTopUp(ctx, 5n, 500n);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'allowance', args: [ACCOUNT, NFT] }));
    // Only the topUp write — no approve.
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'topUp', args: [5n, 500n] }));
  });

  it('walletTopUp APPROVES the exact amount when allowance is short, then tops up', async () => {
    const { ctx, writeContract } = makeCtx({ allowance: 0n });
    await walletTopUp(ctx, 5n, 500n);
    expect(writeContract).toHaveBeenCalledTimes(2);
    // 1st = approve on the TOKEN for exactly `amount` to the NFT spender.
    expect(writeContract).toHaveBeenNthCalledWith(1, expect.objectContaining({ address: TOKEN, functionName: 'approve', args: [NFT, 500n] }));
    // 2nd = topUp on the NFT.
    expect(writeContract).toHaveBeenNthCalledWith(2, expect.objectContaining({ address: NFT, functionName: 'topUp', args: [5n, 500n] }));
  });

  it('walletCreatePca throws when no AccountCreated event is in the receipt', async () => {
    const { ctx } = makeCtx({ allowance: 10n ** 30n, logs: [] });
    await expect(walletCreatePca(ctx, 100n, 1n)).rejects.toThrow(/AccountCreated/);
  });
});
