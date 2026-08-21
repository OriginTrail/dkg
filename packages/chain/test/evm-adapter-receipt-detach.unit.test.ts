import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

function config(): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: PRIVATE_KEY,
    adminPrivateKey: ADMIN_KEY,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
  };
}

const receipt = (hash: string) => ({
  hash,
  blockNumber: 1,
  index: 0,
  status: 1,
  logs: [],
}) as unknown as ethers.TransactionReceipt;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('V10 receipt reconciliation detaches from the nonce serializer', () => {
  it('starts the next same-wallet write after accepted broadcast while the prior receipt is pending', async () => {
    const adapter = new EVMChainAdapter(config());
    const signer = new ethers.Wallet(PRIVATE_KEY);
    const events: string[] = [];
    let nextNonce = 0;

    (adapter as any).broadcastSignedTransactionWithRetries = async (
      signedTx: string,
      txHash: string,
    ) => {
      events.push(`accepted:${signedTx}:${txHash}`);
      nextNonce += 1;
    };
    (adapter as any).waitForReceiptWithFailover = async (txHash: string) => {
      events.push(`wait:${txHash}`);
      await delay(40);
      events.push(`receipt:${txHash}`);
      return receipt(txHash);
    };

    const build = (id: string) => async () => {
      const nonce = nextNonce;
      events.push(`build:${id}:${nonce}`);
      return { signedTx: `${id}-${nonce}`, txHash: `0x${id}${nonce}`, nonce };
    };

    const writes = Promise.all([
      (adapter as any).dispatchSerializedV10Write(
        signer, 'publish', undefined, build('a'), () => { throw new Error('null'); },
      ),
      (adapter as any).dispatchSerializedV10Write(
        signer, 'publish', undefined, build('b'), () => { throw new Error('null'); },
      ),
    ]);

    await delay(10);
    expect(events).toContain('build:a:0');
    expect(events).toContain('accepted:a-0:0xa0');
    expect(events).toContain('build:b:1');
    expect(events).toContain('accepted:b-1:0xb1');
    expect(events).not.toContain('receipt:0xa0');

    const results = await writes;
    expect(results.map((item) => item.hash)).toEqual(['0xa0', '0xb1']);
  });
});
