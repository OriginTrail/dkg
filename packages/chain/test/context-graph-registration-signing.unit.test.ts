/**
 * A context graph registration whose transaction was never sent leaves the
 * graph unregistered: the external signer refusing to sign the create
 * transaction, or the deposit approval before it, is a definitive
 * registration failure. A failure after the broadcast keeps the outcome open,
 * and so does an error another write could share, which is never marked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { connectRemoteSigners } from '../src/remote-signer-connect.js';
import { classifyContextGraphRegistrationFailure } from '../src/context-graph-registration-error.js';
import { createRpcTimeoutError } from '../src/chain-rpc-transport-error.js';
import { isTransactionNotSubmitted } from '../src/transaction-submission.js';
import { startFakeRemoteSigner } from './helpers/fake-remote-signer.js';

// Well-known Hardhat development account.
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TOKEN = 'payer-token-3c4d5e6f7a8b9c0d1e2f3a4b';
const FACADE = '0x00000000000000000000000000000000000000c6';
const APPROVE = '0x095ea7b3';
const CREATE = '0x5a17c0de';
const DEPOSIT = 100n;
const PARAMS = { accessPolicy: 1, publishPolicy: 0 } as const;
const TX = {
  type: 2,
  to: FACADE,
  value: 0n,
  nonce: 3,
  gasLimit: 300_000n,
  maxFeePerGas: 3_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  chainId: 31337n,
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/**
 * An adapter whose payer is an external signer refusing what `refuse` says.
 * Preparation is stubbed (the create's gas estimation reverts TooLowAllowance
 * first when `tooLowFirst`); signing is real; the broadcast and receipt are
 * the `sent` stub.
 */
async function registration(options: { refuse: (data: string) => boolean; tooLowFirst?: boolean }) {
  const fake = await startFakeRemoteSigner({
    credentials: [{ token: TOKEN, keys: [PAYER_KEY] }],
    reject: (method, request) => (
      method === 'eth_signTransaction' && options.refuse(String((request.params[0] as { data?: unknown }).data))
        ? { code: -32000, message: 'policy refused the transaction' }
        : undefined
    ),
  });
  cleanups.push(() => fake.close());
  const { operational } = await connectRemoteSigners({ url: fake.url, authToken: TOKEN });
  const adapter: any = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:1',
    hubAddress: '0x00000000000000000000000000000000000000d4',
    chainId: 'evm:31337',
    staticNetwork: false,
    signers: operational,
    allowNoAdminSigner: true,
  });
  cleanups.push(() => adapter.destroy());
  adapter.initialized = true;
  adapter.init = async () => {};
  adapter.providers = [{}];
  adapter.ensureConfiguredStaticChainIdValidated = async () => {};
  adapter.confirmAllowanceVisible = async () => {};
  const token = { connect: () => token, allowance: async () => 0n };
  adapter.contracts = {
    token,
    contextGraphs: { getAddress: async () => FACADE },
    contextGraphStorage: {
      interface: { parseLog: () => ({ name: 'ContextGraphCreated', args: { contextGraphId: 7n } }) },
    },
    parametersStorage: { connect: () => ({ contextGraphRegistrationDeposit: async () => DEPOSIT }) },
  };
  let creates = 0;
  adapter.prepareAcrossProviders = vi.fn(async (_contract: unknown, method: string, _args: unknown, signer: unknown) => {
    if (method === 'createContextGraph') {
      creates += 1;
      if (options.tooLowFirst && creates === 1) {
        throw Object.assign(new Error('execution reverted: TooLowAllowance(0xTRAC, 0, 1)'), { code: 'CALL_EXCEPTION' });
      }
    }
    return { transaction: { ...TX, data: method === 'approve' ? APPROVE : CREATE }, signer };
  });
  const sent = vi.fn(async (_signedTx: string, txHash: string) => (
    { hash: txHash, blockNumber: 1, index: 0, status: 1, logs: [{ topics: [], data: '0x' }] }
  ));
  adapter.sendSignedTransactionAndWait = sent;
  const signed = () => fake.calls('eth_signTransaction').map((call) => (call.params[0] as { data: string }).data);
  return { adapter, sent, signed, creates: () => creates };
}

describe('a context graph registration whose transaction was never sent', () => {
  it('fails definitively when the signer refuses the create, and registers once the signer signs it', async () => {
    let refuse = true;
    const { adapter, sent, signed } = await registration({ refuse: () => refuse });

    const error = await adapter.createOnChainContextGraph(PARAMS).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'REMOTE_SIGNER_REJECTED' });
    expect(classifyContextGraphRegistrationFailure(error)).toBe('definitive-failure');
    expect(signed()).toEqual([CREATE]);
    expect(sent).not.toHaveBeenCalled();
    // The refusal is reported as it was: marked, not wrapped, nothing enumerable added.
    expect(Object.keys(error as object)).not.toContain('transactionSubmitted');

    refuse = false;
    await expect(adapter.createOnChainContextGraph(PARAMS)).resolves.toMatchObject({ success: true, contextGraphId: 7n });
    expect(signed()).toEqual([CREATE, CREATE]);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('fails definitively when the signer refuses the create retried after the deposit approval', async () => {
    const { adapter, sent, signed, creates } = await registration({ refuse: (data) => data === CREATE, tooLowFirst: true });

    const error = await adapter.createOnChainContextGraph(PARAMS).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'REMOTE_SIGNER_REJECTED' });
    expect(classifyContextGraphRegistrationFailure(error)).toBe('definitive-failure');
    expect(creates()).toBe(2);
    // The approval was signed and sent; the create never was.
    expect(signed()).toEqual([APPROVE, CREATE]);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('fails definitively when the signer refuses the deposit approval', async () => {
    const { adapter, sent, signed, creates } = await registration({ refuse: (data) => data === APPROVE, tooLowFirst: true });

    const error = await adapter.createOnChainContextGraph(PARAMS).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'REMOTE_SIGNER_REJECTED' });
    expect(classifyContextGraphRegistrationFailure(error)).toBe('definitive-failure');
    expect(creates()).toBe(1);
    expect(signed()).toEqual([APPROVE]);
    expect(sent).not.toHaveBeenCalled();
  });

  it('marks only the signing step, so an error several writes can share never carries the mark', async () => {
    // A rejection more than one write can receive, like a shared endpoint validation or an abort reason.
    const shared = new Error('configured chain id does not match the endpoint');
    const { adapter, sent } = await registration({ refuse: () => false });
    adapter.prepareAcrossProviders.mockRejectedValueOnce(shared);
    await expect(adapter.createOnChainContextGraph(PARAMS)).rejects.toBe(shared);
    expect(isTransactionNotSubmitted(shared)).toBe(false);

    // The same error surfacing after another registration's broadcast keeps that outcome open.
    sent.mockRejectedValueOnce(shared);
    const error = await adapter.createOnChainContextGraph(PARAMS).catch((err: unknown) => err);
    expect(error).toBe(shared);
    expect(classifyContextGraphRegistrationFailure(error)).toBe('outcome-ambiguous');
  });

  it('keeps the outcome open when the create was sent and its receipt is lost', async () => {
    const { adapter, sent } = await registration({ refuse: () => false });
    sent.mockImplementationOnce(async (_signedTx: string, txHash: string) => {
      throw createRpcTimeoutError(`create on-chain context graph tx ${txHash} timed out waiting for a receipt`, { txHash });
    });

    const error = await adapter.createOnChainContextGraph(PARAMS).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'RPC_TIMEOUT' });
    expect(classifyContextGraphRegistrationFailure(error)).toBe('outcome-ambiguous');
    expect(sent).toHaveBeenCalledTimes(1);
  });
});
