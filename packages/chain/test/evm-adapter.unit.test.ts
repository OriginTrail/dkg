/**
 * Unit tests for evm-adapter pure helpers and constructor-only surface (07 EVM_MODULE —
 * revert decoding used across chain operations). No live RPC / Hardhat.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Interface, ethers } from 'ethers';
import {
  computeApprovalAction,
  decodeEvmError,
  effectivePublishAllowance,
  enrichEvmError,
  EVMChainAdapter,
  isTooLowAllowanceError,
  resolveRpcUrls,
  V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE,
  type EVMAdapterConfig,
} from '../src/evm-adapter.js';
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_REPLENISH_TARGET_ALLOWANCE,
  DEFAULT_REFILL_BELOW_FRACTION,
  type ApprovalPolicy,
} from '../src/chain-adapter.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OTHER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b63b91100';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    ...overrides,
  };
}

describe('decodeEvmError / enrichEvmError (07 EVM_MODULE — custom errors)', () => {
  it('returns null for too-short hex', () => {
    expect(decodeEvmError('0x')).toBeNull();
    expect(decodeEvmError('0x1234')).toBeNull();
  });

  it('decodes BatchNotFound from merged Hub ABI errors', () => {
    const iface = new Interface(['error BatchNotFound(uint256 batchId)']);
    const data = iface.encodeErrorResult('BatchNotFound', [42n]);
    const d = decodeEvmError(data);
    expect(d).not.toBeNull();
    expect(d!.name).toBe('BatchNotFound');
    expect(d!.args[0]).toBe(42n);
  });

  it('accepts Uint8Array input', () => {
    const iface = new Interface(['error BatchNotFound(uint256 batchId)']);
    const hex = iface.encodeErrorResult('BatchNotFound', [7n]);
    const bytes = ethers.getBytes(hex);
    const d = decodeEvmError(bytes);
    expect(d?.name).toBe('BatchNotFound');
  });

  it('enrichEvmError replaces unknown custom error substring when data is decodable', () => {
    const iface = new Interface(['error InvalidKARange(uint64 startKAId, uint64 endKAId)']);
    const data = iface.encodeErrorResult('InvalidKARange', [1n, 2n]);
    const err = new Error(
      `execution reverted (unknown custom error data="${data}")`,
    );
    const name = enrichEvmError(err);
    expect(name).toBe('InvalidKARange');
    expect(err.message).not.toContain('unknown custom error');
    expect(err.message).toContain('InvalidKARange');
  });

  it('enrichEvmError returns null when message has no data=', () => {
    expect(enrichEvmError(new Error('rpc failed'))).toBeNull();
  });

  it('decodes NotBatchPublisher from V10 contract errors', () => {
    const iface = new Interface(['error NotBatchPublisher(uint256 batchId, address caller)']);
    const data = iface.encodeErrorResult('NotBatchPublisher', [5n, '0x0000000000000000000000000000000000000001']);
    const d = decodeEvmError(data);
    expect(d).not.toBeNull();
    expect(d!.name).toBe('NotBatchPublisher');
    expect(d!.args[0]).toBe(5n);
  });

  it('decodes KnowledgeAssetExpired', () => {
    const iface = new Interface(['error KnowledgeAssetExpired(uint256 id, uint256 currentEpoch, uint256 endEpoch)']);
    const data = iface.encodeErrorResult('KnowledgeAssetExpired', [1n, 100n, 50n]);
    const d = decodeEvmError(data);
    expect(d).not.toBeNull();
    expect(d!.name).toBe('KnowledgeAssetExpired');
  });

  it('decodes CannotUpdateImmutableKnowledgeAsset', () => {
    const iface = new Interface(['error CannotUpdateImmutableKnowledgeAsset(uint256 id)']);
    const data = iface.encodeErrorResult('CannotUpdateImmutableKnowledgeAsset', [7n]);
    const d = decodeEvmError(data);
    expect(d).not.toBeNull();
    expect(d!.name).toBe('CannotUpdateImmutableKnowledgeAsset');
  });

  it('enrichEvmError returns decoded name for V10 errors', () => {
    const iface = new Interface(['error NotBatchPublisher(uint256 batchId, address caller)']);
    const data = iface.encodeErrorResult('NotBatchPublisher', [3n, '0x0000000000000000000000000000000000000001']);
    const err = new Error(`execution reverted (unknown custom error data="${data}")`);
    const name = enrichEvmError(err);
    expect(name).toBe('NotBatchPublisher');
    expect(err.message).toContain('NotBatchPublisher');
    expect(err.message).not.toContain('unknown custom error');
  });

  it('returns null for unrecognized error selector', () => {
    expect(decodeEvmError('0xdeadbeef')).toBeNull();
  });
});

describe('EVMChainAdapter constructor / getters (no init)', () => {
  it('sets chainType, chainId default, and signer pool', () => {
    const a = new EVMChainAdapter(minimalConfig({ chainId: 'evm:84532' }));
    expect(a.chainType).toBe('evm');
    expect(a.chainId).toBe('evm:84532');
    expect(a.getSignerAddress()).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(a.getSignerAddresses()).toHaveLength(1);
    expect(a.getSignerAddresses()[0]).toBe(a.getSignerAddress());
  });

  it('includes additionalKeys in signer pool (round-robin for publish)', () => {
    const a = new EVMChainAdapter(minimalConfig({ additionalKeys: [OTHER_PK] }));
    const addrs = a.getSignerAddresses();
    expect(addrs).toHaveLength(2);
    expect(addrs[0]).not.toBe(addrs[1]);
  });

  it('rejects adminPrivateKey when it duplicates an operational key', () => {
    expect(() => new EVMChainAdapter(minimalConfig({ adminPrivateKey: DEPLOYER_PK })))
      .toThrow('EVM adminPrivateKey must be distinct from operational keys');
  });

  it('rejects invalid tokenAddress overrides', () => {
    expect(() => new EVMChainAdapter(minimalConfig({ tokenAddress: 'not-an-address' })))
      .toThrow('Invalid tokenAddress');
  });

  it('allows missing adminPrivateKey for backwards-compatible publish/read-only adapters', () => {
    expect(() => new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:59998',
      privateKey: DEPLOYER_PK,
      hubAddress: '0x0000000000000000000000000000000000000001',
      chainId: 'evm:31337',
    })).not.toThrow();

    expect(() => new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:59998',
      privateKey: DEPLOYER_PK,
      hubAddress: '0x0000000000000000000000000000000000000001',
      chainId: 'evm:31337',
      allowNoAdminSigner: true,
    })).not.toThrow();
  });

  it('getProvider returns JsonRpcProvider', () => {
    const a = new EVMChainAdapter(minimalConfig());
    expect(a.getProvider()).toBeDefined();
    expect(typeof a.getProvider().getBlockNumber).toBe('function');
    expect(a.getReadProvider()).toBeDefined();
  });

  it('issues un-batched JSON-RPC requests (batchMaxCount=1) so a rate-limited read rejects on its own awaited promise — issue #939', async () => {
    // With ethers' default batching, several concurrent reads coalesce into a
    // single ARRAY-bodied HTTP request; a whole-batch rate-limit error then
    // rejects on the un-awaited batch-drain promise → unhandled "could not
    // coalesce error" rejection (~30k observed live). batchMaxCount:1 sends
    // each read as its own single-object request, so the error attaches to the
    // awaited promise and is caught by the gossip/finalization verifyOnChain
    // try/catch. We assert the observable contract: no request body is an array.
    const bodies: unknown[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(raw) as unknown;
        bodies.push(parsed);
        const reqs = Array.isArray(parsed) ? parsed : [parsed];
        const results = reqs.map((r) => ({ jsonrpc: '2.0', id: (r as { id: number }).id, result: '0x1' }));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(Array.isArray(parsed) ? results : results[0]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const port = (server.address() as AddressInfo).port;
      const a = new EVMChainAdapter(minimalConfig({ rpcUrl: `http://127.0.0.1:${port}` }));
      const provider = a.getProvider();
      // Three DIFFERENT concurrent read methods so ethers cannot in-flight-dedupe
      // them; default batching would still fold them into one array request.
      await Promise.all([
        provider.getBlockNumber(),
        provider.getBalance(ethers.ZeroAddress),
        provider.getTransactionCount(ethers.ZeroAddress),
      ]);
      expect(bodies.length).toBeGreaterThanOrEqual(2);
      expect(bodies.every((b) => !Array.isArray(b))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('falls back to getContextGraph when ContextGraphStorage lacks getAccessPolicy', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const getAccessPolicy = vi.fn(async () => {
      const err = new Error('missing revert data');
      (err as any).code = 'CALL_EXCEPTION';
      throw err;
    });
    const getContextGraph = vi.fn(async () => ({
      owner_: ethers.ZeroAddress,
      participantAgents: [],
      metadataBatchId: 0n,
      active: true,
      createdAt: 1n,
      accessPolicy: 1n,
      publishPolicy: 0n,
      publishAuthority: ethers.ZeroAddress,
      publishAuthorityAccountId: 0n,
    }));
    (a as any).init = async () => undefined;
    (a as any).contracts.contextGraphStorage = {
      getAccessPolicy,
      getContextGraph,
    };

    await expect(a.getContextGraphAccessPolicy(6n)).resolves.toBe(1);
    expect(getAccessPolicy).toHaveBeenCalledWith(6n);
    expect(getContextGraph).toHaveBeenCalledWith(6n);
  });

  it('parses accessPolicy from tuple fallback results', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    (a as any).init = async () => undefined;
    (a as any).contracts.contextGraphStorage = {
      getAccessPolicy: vi.fn(async () => {
        throw new Error('selector unavailable');
      }),
      getContextGraph: vi.fn(async () => [
        ethers.ZeroAddress,
        [],
        0n,
        true,
        1n,
        0n,
        1n,
        ethers.ZeroAddress,
        0n,
      ]),
    };

    await expect(a.getContextGraphAccessPolicy(7n)).resolves.toBe(0);
  });

  it('uses configured tokenAddress without resolving Hub.Token during init', async () => {
    const tokenAddress = ethers.getAddress(`0x${'22'.repeat(20)}`);
    const contractAddress = ethers.getAddress(`0x${'11'.repeat(20)}`);
    const assetStorageAddress = ethers.getAddress(`0x${'33'.repeat(20)}`);
    const a = new EVMChainAdapter(minimalConfig({ tokenAddress }));
    const getContractAddress = vi.fn(async (name: string) => {
      if (name === 'Token') throw new Error('Hub.Token should not be resolved when tokenAddress is configured');
      return contractAddress;
    });
    (a as any).contracts.hub = {
      getContractAddress,
      getAssetStorageAddress: vi.fn(async () => assetStorageAddress),
      on: vi.fn(async () => undefined),
    };

    await (a as any).init();

    expect(getContractAddress).not.toHaveBeenCalledWith('Token');
    await expect((a as any).contracts.token.getAddress()).resolves.toBe(tokenAddress);
  });

  it('dedupes configured RPC URLs in priority order', () => {
    expect(resolveRpcUrls('https://primary.example', [
      'https://primary.example',
      ' https://backup-a.example ',
      'https://backup-b.example',
      'https://backup-a.example',
    ])).toEqual([
      'https://primary.example',
      'https://backup-a.example',
      'https://backup-b.example',
    ]);

    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://primary.example', 'https://backup.example'],
    }));
    expect(a.getRpcUrls()).toEqual(['https://primary.example', 'https://backup.example']);
  });

  it('receipt lookup succeeds on backup when primary throws retryable provider error', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const receipt = { hash: '0xabc', blockNumber: 12, status: 1, logs: [] };
    const primary = {
      getTransactionReceipt: vi.fn(async () => {
        const err = new Error('socket hang up');
        (err as any).code = 'ECONNRESET';
        throw err;
      }),
    };
    const backup = { getTransactionReceipt: vi.fn(async () => receipt) };
    (a as any).providers = [primary, backup];

    await expect((a as any).getTransactionReceiptWithFailover('0xabc')).resolves.toBe(receipt);
    expect(primary.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(backup.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it('fails receipt lookup immediately when every RPC endpoint errors', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const primary = {
      getTransactionReceipt: vi.fn(async () => {
        const err = new Error('socket hang up');
        (err as any).code = 'ECONNRESET';
        throw err;
      }),
    };
    const backup = {
      getTransactionReceipt: vi.fn(async () => {
        const err = new Error('502 bad gateway');
        (err as any).status = 502;
        throw err;
      }),
    };
    (a as any).providers = [primary, backup];

    await expect((a as any).getTransactionReceiptWithFailover('0xabc')).rejects.toMatchObject({
      code: 'RPC_RECEIPT_LOOKUP_FAILED',
    });
    expect(primary.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(backup.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it('does not fail over deterministic CALL_EXCEPTION errors', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const err = new Error('execution reverted');
    (err as any).code = 'CALL_EXCEPTION';
    const primary = { getTransactionReceipt: vi.fn(async () => { throw err; }) };
    const backup = { getTransactionReceipt: vi.fn(async () => null) };
    (a as any).providers = [primary, backup];

    await expect((a as any).getTransactionReceiptWithFailover('0xabc')).rejects.toBe(err);
    expect(backup.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('tries backup RPC when contract transaction population is rate-limited', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const primaryProvider = { name: 'primary' } as any;
    const backupProvider = { name: 'backup' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, primaryProvider);
    const receipt = { hash: '0xabc', blockNumber: 12, status: 1, logs: [] };
    const populated = { to: '0x0000000000000000000000000000000000000001', data: '0x1234' };
    const populateTransaction = vi.fn()
      .mockImplementationOnce(async () => {
        const err = new Error('429 too many requests');
        (err as any).status = 429;
        throw err;
      })
      .mockResolvedValueOnce(populated);
    const runners: any[] = [];
    const contract = {
      connect: vi.fn((runner: any) => {
        runners.push(runner);
        return { createContextGraph: { populateTransaction } };
      }),
    };
    (a as any).providers = [primaryProvider, backupProvider];
    (a as any).signPopulatedTransaction = vi.fn(async () => ({
      signedTx: '0xdeadbeef',
      txHash: receipt.hash,
    }));
    (a as any).sendSignedTransactionAndWait = vi.fn(async () => receipt);

    await expect((a as any).sendContractTransaction(
      contract,
      'createContextGraph',
      [],
      signer,
      'create on-chain context graph',
    )).resolves.toBe(receipt);

    expect(populateTransaction).toHaveBeenCalledTimes(2);
    expect(runners.map((runner) => runner.provider)).toEqual([primaryProvider, backupProvider]);
    expect((a as any).signPopulatedTransaction).toHaveBeenCalledWith(
      runners[1],
      populated,
    );
  });

  it('inflates gasLimit by gasLimitBufferBps when populate leaves it unset (OOG headroom)', async () => {
    // createChallenge's gas depends on per-block randomness, so the adapter
    // estimates once and inflates the limit. Verify the buffered branch
    // actually mutates the populated tx that gets signed (Codex review:
    // previously only covered indirectly through flaky Hardhat e2e).
    const a = new EVMChainAdapter(minimalConfig({ rpcUrl: 'https://only.example' }));
    const provider = { name: 'only' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, provider);
    const receipt = { hash: '0xabc', blockNumber: 7, status: 1, logs: [] };
    // No gasLimit from populate → buffered-estimate path runs.
    const populated: any = { to: '0x0000000000000000000000000000000000000001', data: '0x1234' };
    const populateTransaction = vi.fn(async () => populated);
    const estimateGas = vi.fn(async () => 1_000_000n);
    const contract = {
      connect: vi.fn(() => ({ createChallenge: { populateTransaction, estimateGas } })),
    };
    (a as any).providers = [provider];
    const signSpy = vi.fn(async () => ({ signedTx: '0xdead', txHash: receipt.hash }));
    (a as any).signPopulatedTransaction = signSpy;
    (a as any).sendSignedTransactionAndWait = vi.fn(async () => receipt);

    await expect((a as any).sendContractTransaction(
      contract,
      'createChallenge',
      [],
      signer,
      'create random-sampling challenge',
      { gasLimitBufferBps: 5_000 },
    )).resolves.toBe(receipt);

    expect(estimateGas).toHaveBeenCalledTimes(1);
    // 1_000_000 * (10_000 + 5_000) / 10_000 = 1_500_000
    expect(signSpy.mock.calls[0][1].gasLimit).toBe(1_500_000n);
  });

  it('falls back to the unbuffered signing flow and warns when buffered estimateGas throws', async () => {
    const a = new EVMChainAdapter(minimalConfig({ rpcUrl: 'https://only.example' }));
    const provider = { name: 'only' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, provider);
    const receipt = { hash: '0xabc', blockNumber: 9, status: 1, logs: [] };
    const populated: any = { to: '0x0000000000000000000000000000000000000001', data: '0x1234' };
    const populateTransaction = vi.fn(async () => populated);
    const estimateGas = vi.fn(async () => { throw new Error('estimate boom'); });
    const contract = {
      connect: vi.fn(() => ({ createChallenge: { populateTransaction, estimateGas } })),
    };
    (a as any).providers = [provider];
    const signSpy = vi.fn(async () => ({ signedTx: '0xdead', txHash: receipt.hash }));
    (a as any).signPopulatedTransaction = signSpy;
    (a as any).sendSignedTransactionAndWait = vi.fn(async () => receipt);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect((a as any).sendContractTransaction(
      contract,
      'createChallenge',
      [],
      signer,
      'create random-sampling challenge',
      { gasLimitBufferBps: 5_000 },
    )).resolves.toBe(receipt);

    // No headroom applied — gasLimit stays unset so ethers estimates during
    // signing (unbuffered, but no worse than before the buffer existed).
    expect(signSpy.mock.calls[0][1].gasLimit).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('buffered gas estimation failed');
    warnSpy.mockRestore();
  });

  it('skips gas estimation when populate already set gasLimit (buffer is a no-op)', async () => {
    const a = new EVMChainAdapter(minimalConfig({ rpcUrl: 'https://only.example' }));
    const provider = { name: 'only' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, provider);
    const receipt = { hash: '0xabc', blockNumber: 11, status: 1, logs: [] };
    const populated: any = { to: '0x0000000000000000000000000000000000000001', data: '0x1234', gasLimit: 800_000n };
    const populateTransaction = vi.fn(async () => populated);
    const estimateGas = vi.fn(async () => 1_000_000n);
    const contract = {
      connect: vi.fn(() => ({ createChallenge: { populateTransaction, estimateGas } })),
    };
    (a as any).providers = [provider];
    const signSpy = vi.fn(async () => ({ signedTx: '0xdead', txHash: receipt.hash }));
    (a as any).signPopulatedTransaction = signSpy;
    (a as any).sendSignedTransactionAndWait = vi.fn(async () => receipt);

    await expect((a as any).sendContractTransaction(
      contract,
      'createChallenge',
      [],
      signer,
      'create random-sampling challenge',
      { gasLimitBufferBps: 5_000 },
    )).resolves.toBe(receipt);

    expect(estimateGas).not.toHaveBeenCalled();
    expect(signSpy.mock.calls[0][1].gasLimit).toBe(800_000n);
  });

  it('fails over to the next RPC when buffered estimateGas is rate-limited (keeps the OOG headroom)', async () => {
    // A retryable estimate failure must NOT silently drop the gas headroom
    // by signing unbuffered against the failing provider — that reintroduces
    // the OOG this guards against. Instead the outer loop should fail over to
    // a healthy RPC that can estimate, and the buffer is still applied
    // (Codex review).
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const primaryProvider = { name: 'primary' } as any;
    const backupProvider = { name: 'backup' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, primaryProvider);
    const receipt = { hash: '0xabc', blockNumber: 13, status: 1, logs: [] };
    // Fresh populated per provider so provider #1's discarded attempt can't
    // leak a gasLimit onto provider #2.
    const populateTransaction = vi.fn(async () => (
      { to: '0x0000000000000000000000000000000000000001', data: '0x1234' } as any
    ));
    const estimateGas = vi.fn()
      .mockImplementationOnce(async () => {
        const err = new Error('429 too many requests');
        (err as any).status = 429;
        throw err;
      })
      .mockResolvedValueOnce(1_000_000n);
    const runners: any[] = [];
    const contract = {
      connect: vi.fn((runner: any) => {
        runners.push(runner);
        return { createChallenge: { populateTransaction, estimateGas } };
      }),
    };
    (a as any).providers = [primaryProvider, backupProvider];
    const signSpy = vi.fn(async () => ({ signedTx: '0xdead', txHash: receipt.hash }));
    (a as any).signPopulatedTransaction = signSpy;
    (a as any).sendSignedTransactionAndWait = vi.fn(async () => receipt);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect((a as any).sendContractTransaction(
      contract,
      'createChallenge',
      [],
      signer,
      'create random-sampling challenge',
      { gasLimitBufferBps: 5_000 },
    )).resolves.toBe(receipt);

    expect(estimateGas).toHaveBeenCalledTimes(2);
    expect(populateTransaction).toHaveBeenCalledTimes(2);
    // Buffer still applied on the healthy provider.
    expect(signSpy.mock.calls[0][1].gasLimit).toBe(1_500_000n);
    // Signed against the BACKUP runner, not the rate-limited primary.
    expect(signSpy.mock.calls[0][0].provider).toBe(backupProvider);
    // Failover, not silent fallback — no "headroom not applied" warning.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('names exhausted RPC endpoints when transaction population fails everywhere', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const primaryProvider = { name: 'primary' } as any;
    const backupProvider = { name: 'backup' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, primaryProvider);
    const populateTransaction = vi.fn(async () => {
      const err = new Error('429 too many requests');
      (err as any).status = 429;
      throw err;
    });
    const contract = {
      connect: vi.fn(() => ({ createContextGraph: { populateTransaction } })),
    };
    (a as any).providers = [primaryProvider, backupProvider];
    (a as any).signPopulatedTransaction = vi.fn(async () => ({
      signedTx: '0xdeadbeef',
      txHash: '0xabc',
    }));
    (a as any).sendSignedTransactionAndWait = vi.fn(async () => ({}));

    let thrown: any;
    try {
      await (a as any).sendContractTransaction(
        contract,
        'createContextGraph',
        [],
        signer,
        'create on-chain context graph',
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toMatchObject({
      code: 'RPC_ENDPOINTS_EXHAUSTED',
      rpcUrls: ['https://primary.example', 'https://backup.example'],
    });
    expect(thrown.message).toContain('https://primary.example');
    expect(thrown.message).toContain('https://backup.example');
    expect(populateTransaction).toHaveBeenCalledTimes(2);
    expect((a as any).signPopulatedTransaction).not.toHaveBeenCalled();
    expect((a as any).sendSignedTransactionAndWait).not.toHaveBeenCalled();
  });

  it('single-provider exhaustion keeps the RPC_ENDPOINTS_EXHAUSTED code but preserves the original message verbatim (#895 / Codex PR #901)', async () => {
    // One configured RPC → no failover, but downstream classifiers
    // (`/api/context-graph/register`) still key the transient-outage 503 off
    // the RPC_ENDPOINTS_EXHAUSTED code, so the code MUST survive. The
    // single-endpoint case must NOT, however, rewrite the message into the
    // multi-endpoint "failed on all configured RPC endpoints (…)" aggregate —
    // there is no second endpoint, so the original message reads cleaner and
    // message-inspecting callers keep seeing it unchanged.
    const a = new EVMChainAdapter(minimalConfig({ rpcUrl: 'https://only.example' }));
    const onlyProvider = { name: 'only' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, onlyProvider);
    const populateTransaction = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8545');
    });
    const contract = {
      connect: vi.fn(() => ({ createContextGraph: { populateTransaction } })),
    };
    (a as any).providers = [onlyProvider];
    (a as any).signPopulatedTransaction = vi.fn();
    (a as any).sendSignedTransactionAndWait = vi.fn();

    let thrown: any;
    try {
      await (a as any).sendContractTransaction(
        contract,
        'createContextGraph',
        [],
        signer,
        'create on-chain context graph',
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toMatchObject({
      code: 'RPC_ENDPOINTS_EXHAUSTED',
      rpcUrls: ['https://only.example'],
    });
    // Message stays byte-identical — no "failed on all configured RPC
    // endpoints (…)" aggregate, and the label is not prepended.
    expect(thrown.message).toBe('connect ECONNREFUSED 127.0.0.1:8545');
    expect(thrown.message).not.toContain('all configured RPC endpoints');
    // The original error is preserved as the cause.
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect((thrown as { cause: Error }).cause.message).toBe('connect ECONNREFUSED 127.0.0.1:8545');
    expect(populateTransaction).toHaveBeenCalledTimes(1);
    expect((a as any).signPopulatedTransaction).not.toHaveBeenCalled();
    expect((a as any).sendSignedTransactionAndWait).not.toHaveBeenCalled();
  });

  it('broadcasts the exact same signed raw transaction to backup after primary send failure', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const signedTx = '0x02f86c0180843b9aca0084773594008252089400000000000000000000000000000000000000018080c001a0' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const txHash = '0x' + '11'.repeat(32);
    const receipt = { hash: txHash, blockNumber: 45, status: 1, logs: [] };
    const primary = {
      broadcastTransaction: vi.fn(async (_raw: string) => {
        const err = new Error('429 too many requests');
        (err as any).status = 429;
        throw err;
      }),
      getTransactionReceipt: vi.fn(async () => null),
    };
    const backup = {
      broadcastTransaction: vi.fn(async () => ({ hash: txHash })),
      getTransactionReceipt: vi.fn(async () => receipt),
    };
    (a as any).providers = [primary, backup];

    await expect((a as any).sendSignedTransactionAndWait(signedTx, txHash, 'unit write')).resolves.toBe(receipt);
    expect(primary.broadcastTransaction).toHaveBeenCalledWith(signedTx);
    expect(backup.broadcastTransaction).toHaveBeenCalledWith(signedTx);
  });

  it('preserves the transaction hash when post-broadcast receipt lookup exhausts RPC endpoints', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const signedTx = '0xdeadbeef';
    const txHash = '0x' + '55'.repeat(32);
    const primaryProvider = {
      name: 'primary',
      broadcastTransaction: vi.fn(async () => ({ hash: txHash })),
      getTransactionReceipt: vi.fn(async () => {
        const err = new Error('429 too many requests');
        (err as any).status = 429;
        throw err;
      }),
    };
    const backupProvider = {
      name: 'backup',
      broadcastTransaction: vi.fn(async () => ({ hash: txHash })),
      getTransactionReceipt: vi.fn(async () => {
        const err = new Error('502 bad gateway');
        (err as any).status = 502;
        throw err;
      }),
    };
    const signer = new ethers.Wallet(DEPLOYER_PK, primaryProvider as any);
    const populated = { to: '0x0000000000000000000000000000000000000001', data: '0x1234' };
    const populateTransaction = vi.fn(async () => populated);
    const contract = {
      connect: vi.fn(() => ({ createContextGraph: { populateTransaction } })),
    };
    (a as any).providers = [primaryProvider, backupProvider];
    (a as any).signPopulatedTransaction = vi.fn(async () => ({ signedTx, txHash }));

    await expect((a as any).sendContractTransaction(
      contract,
      'createContextGraph',
      [],
      signer,
      'create on-chain context graph',
    )).rejects.toMatchObject({
      code: 'RPC_RECEIPT_LOOKUP_FAILED',
      txHash,
    });
    expect(populateTransaction).toHaveBeenCalledTimes(1);
    expect((a as any).signPopulatedTransaction).toHaveBeenCalledTimes(1);
    expect(primaryProvider.broadcastTransaction).toHaveBeenCalledWith(signedTx);
    expect(backupProvider.broadcastTransaction).not.toHaveBeenCalled();
    expect(primaryProvider.getTransactionReceipt).toHaveBeenCalledWith(txHash);
    expect(backupProvider.getTransactionReceipt).toHaveBeenCalledWith(txHash);
  });

  it('classifies receipt wait expiry as a timeout and preserves the transaction hash', async () => {
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const signedTx = '0xdeadbeef';
      const txHash = '0x' + '66'.repeat(32);
      const provider = {
        name: 'primary',
        broadcastTransaction: vi.fn(async () => ({ hash: txHash })),
        getTransactionReceipt: vi.fn(async () => null),
      };
      const signer = new ethers.Wallet(DEPLOYER_PK, provider as any);
      const populated = { to: '0x0000000000000000000000000000000000000001', data: '0x1234' };
      const populateTransaction = vi.fn(async () => populated);
      const contract = {
        connect: vi.fn(() => ({ createContextGraph: { populateTransaction } })),
      };
      (a as any).providers = [provider];
      (a as any).signPopulatedTransaction = vi.fn(async () => ({ signedTx, txHash }));

      const thrown = (async () => {
        try {
          await (a as any).sendContractTransaction(
            contract,
            'createContextGraph',
            [],
            signer,
            'create on-chain context graph',
          );
          return undefined;
        } catch (err) {
          return err;
        }
      })();
      await vi.advanceTimersByTimeAsync(180_001);

      await expect(thrown).resolves.toMatchObject({
        code: 'TIMEOUT',
        txHash,
      });
      expect(populateTransaction).toHaveBeenCalledTimes(1);
      expect((a as any).signPopulatedTransaction).toHaveBeenCalledTimes(1);
      expect(provider.broadcastTransaction).toHaveBeenCalledWith(signedTx);
      expect(provider.getTransactionReceipt).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats already-known transaction responses as accepted and polls receipts', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const signedTx = '0xdeadbeef';
    const txHash = '0x' + '22'.repeat(32);
    const receipt = { hash: txHash, blockNumber: 46, status: 1, logs: [] };
    const primary = {
      broadcastTransaction: vi.fn(async () => {
        throw new Error('already known');
      }),
      getTransactionReceipt: vi.fn(async () => receipt),
    };
    const backup = {
      broadcastTransaction: vi.fn(async () => ({ hash: txHash })),
      getTransactionReceipt: vi.fn(async () => receipt),
    };
    (a as any).providers = [primary, backup];

    await expect((a as any).sendSignedTransactionAndWait(signedTx, txHash, 'unit write')).resolves.toBe(receipt);
    expect(primary.broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(backup.broadcastTransaction).not.toHaveBeenCalled();
    expect(primary.getTransactionReceipt).toHaveBeenCalledWith(txHash);
  });

  it('treats nonce-too-low transaction responses as accepted and polls receipts', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const signedTx = '0xdeadbeef';
    const txHash = '0x' + '44'.repeat(32);
    const receipt = { hash: txHash, blockNumber: 48, status: 1, logs: [] };
    const primary = {
      broadcastTransaction: vi.fn(async () => {
        const err = new Error('nonce too low');
        (err as any).code = 'NONCE_EXPIRED';
        throw err;
      }),
      getTransactionReceipt: vi.fn(async () => receipt),
    };
    const backup = {
      broadcastTransaction: vi.fn(async () => ({ hash: txHash })),
      getTransactionReceipt: vi.fn(async () => receipt),
    };
    (a as any).providers = [primary, backup];

    await expect((a as any).sendSignedTransactionAndWait(signedTx, txHash, 'unit write')).resolves.toBe(receipt);
    expect(primary.broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(backup.broadcastTransaction).not.toHaveBeenCalled();
    expect(primary.getTransactionReceipt).toHaveBeenCalledWith(txHash);
  });

  it('throws CALL_EXCEPTION when a mined write receipt reverted', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const signedTx = '0xdeadbeef';
    const txHash = '0x' + '33'.repeat(32);
    const receipt = { hash: txHash, blockNumber: 47, status: 0, logs: [] };
    const primary = {
      broadcastTransaction: vi.fn(async () => ({ hash: txHash })),
      getTransactionReceipt: vi.fn(async () => receipt),
    };
    const backup = {
      broadcastTransaction: vi.fn(async () => ({ hash: txHash })),
      getTransactionReceipt: vi.fn(async () => receipt),
    };
    (a as any).providers = [primary, backup];

    await expect((a as any).sendSignedTransactionAndWait(signedTx, txHash, 'unit write')).rejects.toMatchObject({
      code: 'CALL_EXCEPTION',
      receipt,
    });
    expect(backup.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('signMessage returns 32-byte r and vs (no contract init)', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const digest = ethers.randomBytes(32);
    const sig = await a.signMessage(digest);
    expect(sig.r).toHaveLength(32);
    expect(sig.vs).toHaveLength(32);
  });

  it('reserves distinct authorized publisher signers across concurrent address probes', async () => {
    const a = new EVMChainAdapter(minimalConfig({ additionalKeys: [OTHER_PK] }));
    const [firstAddress, secondAddress] = a.getSignerAddresses();
    (a as any).init = async () => undefined;
    (a as any).contracts.contextGraphs = {
      isAuthorizedPublisher: vi.fn(async () => {
        await Promise.resolve();
        return true;
      }),
    };

    const [firstReserved, secondReserved] = await Promise.all([
      a.getAuthorizedPublisherAddress(1n),
      a.getAuthorizedPublisherAddress(1n),
    ]);

    expect(firstReserved).toBe(firstAddress);
    expect(secondReserved).toBe(secondAddress);
  });

  it('accepts randomSamplingHubRefreshMs override without RPC contact', () => {
    const a = new EVMChainAdapter(minimalConfig({ randomSamplingHubRefreshMs: 60_000 }));
    expect(a.chainType).toBe('evm');
  });

  it('startHubRotationListener swallows async provider rejections without unhandled-rejection or throw (Codex N15)', async () => {
    // ethers v6 `Contract.on(...)` is async — providers that reject
    // filter installation (e.g. HTTP-only endpoints, mocked providers)
    // must NOT bubble as unhandled rejections, and the listener-started
    // flag must NOT be flipped if subscription failed (so a future
    // retry remains possible).
    const a = new EVMChainAdapter(minimalConfig());
    const fakeHub = {
      on: async (_event: string, _cb: (...args: unknown[]) => void) => {
        throw new Error('provider does not support filter subscriptions');
      },
    };
    (a as any).contracts.hub = fakeHub;
    (a as any).hubRotationListenerStarted = false;
    let unhandled: unknown = null;
    const onRejection = (reason: unknown) => { unhandled = reason; };
    process.on('unhandledRejection', onRejection);
    try {
      await expect((a as any).startHubRotationListener()).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toBeNull();
      expect((a as any).hubRotationListenerStarted).toBe(false);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('invalidateRandomSamplingPair drops both the cache AND the side-channel contract handles (Codex N15)', () => {
    const a = new EVMChainAdapter(minimalConfig());
    (a as any).contracts.randomSampling = { dummy: 'rs' };
    (a as any).contracts.randomSamplingStorage = { dummy: 'rss' };
    (a as any).randomSamplingPairCache.cached = { rs: 'x', rss: 'y' };
    (a as any).randomSamplingPairCache.resolvedAt = Date.now();

    expect(a.isRandomSamplingReady()).toBe(true);
    (a as any).invalidateRandomSamplingPair();
    expect(a.isRandomSamplingReady()).toBe(false);
    expect((a as any).randomSamplingPairCache.peek()).toBeNull();
  });

  it('resolveAndAssignRandomSamplingPair refuses to write stale handles back when invalidate() raced the await (Codex N16)', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    let releaseResolve: ((v: { rs: any; rss: any }) => void) = () => {};
    const stalePair = { rs: { stale: 'rs' }, rss: { stale: 'rss' } };

    (a as any).randomSamplingPairCache = {
      _gen: 0,
      currentGeneration() { return this._gen; },
      get() {
        return new Promise((resolve) => { releaseResolve = resolve; });
      },
    };

    const pending = (a as any).resolveAndAssignRandomSamplingPair() as Promise<unknown>;
    (a as any).randomSamplingPairCache._gen += 1;
    releaseResolve(stalePair);
    const returned = await pending;

    expect(returned).toBe(stalePair);
    expect((a as any).contracts.randomSampling).toBeUndefined();
    expect((a as any).contracts.randomSamplingStorage).toBeUndefined();
    expect(a.isRandomSamplingReady()).toBe(false);
  });

  it('resolveAndAssignRandomSamplingPair writes handles when no invalidate() raced (happy path)', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const freshPair = { rs: { fresh: 'rs' }, rss: { fresh: 'rss' } };

    (a as any).randomSamplingPairCache = {
      _gen: 5,
      currentGeneration() { return this._gen; },
      get: async () => freshPair,
    };

    const returned = await (a as any).resolveAndAssignRandomSamplingPair();
    expect(returned).toBe(freshPair);
    expect((a as any).contracts.randomSampling).toBe(freshPair.rs);
    expect((a as any).contracts.randomSamplingStorage).toBe(freshPair.rss);
  });

  it('isContractMissingRevert recognises both the legacy (ZeroAddress→string) shape and ContractDoesNotExist revert (Codex N16)', () => {
    const a = new EVMChainAdapter(minimalConfig());
    expect((a as any).isContractMissingRevert(new Error('reverted with custom error ContractDoesNotExist("RandomSampling")'))).toBe(true);
    expect((a as any).isContractMissingRevert(new Error('AddressDoesNotExist(0x123)'))).toBe(true);
    expect((a as any).isContractMissingRevert(new Error('Contract "X" not found in Hub at 0xabc'))).toBe(false);
    expect((a as any).isContractMissingRevert(new Error('execution reverted: ProfileDoesntExist(0)'))).toBe(false);
    expect((a as any).isContractMissingRevert('not an error')).toBe(false);
  });

  it('getActiveProofPeriodStatus stays best-effort when getActiveProofingPeriodDurationInBlocks rejects (Codex round 3)', async () => {
    // Codex round 3 on PR #369 — pulling the live duration alongside
    // status must NOT promote the duration RPC to a hard prerequisite.
    // If a transient RPC error hits only the second leg, the status
    // read should still succeed with `proofingPeriodDurationInBlocks:
    // undefined` and the prover falls back to the cached challenge
    // duration.
    const a = new EVMChainAdapter(minimalConfig());
    const fakeRs = {
      getActiveProofPeriodStatus: async () => ({
        activeProofPeriodStartBlock: 1234n,
        isValid: true,
      }),
      getActiveProofingPeriodDurationInBlocks: async () => {
        throw new Error('TransientRpc502BadGateway');
      },
    };
    (a as any).init = async () => undefined;
    (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
    const status = await a.getActiveProofPeriodStatus();
    expect(status.activeProofPeriodStartBlock).toBe(1234n);
    expect(status.isValid).toBe(true);
    expect(status.proofingPeriodDurationInBlocks).toBeUndefined();
  });

  it('getActiveProofPeriodStatus stays best-effort when getActiveProofingPeriodDurationInBlocks is missing entirely (Codex round 4)', async () => {
    // Codex round 4 on PR #369 — `Promise.allSettled([..., rs.getX()])`
    // is NOT enough. If older RS deployments omit the method from their
    // ABI entirely, `rs.getActiveProofingPeriodDurationInBlocks()`
    // throws SYNCHRONOUSLY (TypeError: ... is not a function) while
    // building the allSettled input array, before allSettled can wrap
    // the rejection. Verify the wrapper handles "method literally
    // doesn't exist" cleanly.
    const a = new EVMChainAdapter(minimalConfig());
    // Note: getActiveProofingPeriodDurationInBlocks is NOT defined.
    const fakeRs = {
      getActiveProofPeriodStatus: async () => ({
        activeProofPeriodStartBlock: 7n,
        isValid: true,
      }),
    };
    (a as any).init = async () => undefined;
    (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
    const status = await a.getActiveProofPeriodStatus();
    expect(status.activeProofPeriodStartBlock).toBe(7n);
    expect(status.isValid).toBe(true);
    expect(status.proofingPeriodDurationInBlocks).toBeUndefined();
  });

  it('getActiveProofPeriodStatus stays best-effort when getActiveProofingPeriodDurationInBlocks throws synchronously (Codex round 4)', async () => {
    // Defence-in-depth for ethers Contract proxies that resolve the
    // missing-fn into a throw at call-time rather than returning a
    // rejected promise.
    const a = new EVMChainAdapter(minimalConfig());
    const fakeRs = {
      getActiveProofPeriodStatus: async () => ({
        activeProofPeriodStartBlock: 42n,
        isValid: false,
      }),
      getActiveProofingPeriodDurationInBlocks: () => {
        throw new TypeError('this.constructor.getFunction is not a function');
      },
    };
    (a as any).init = async () => undefined;
    (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
    const status = await a.getActiveProofPeriodStatus();
    expect(status.activeProofPeriodStartBlock).toBe(42n);
    expect(status.isValid).toBe(false);
    expect(status.proofingPeriodDurationInBlocks).toBeUndefined();
  });

  it('getActiveProofPeriodStatus surfaces the real status read failure (does not swallow the primary leg)', async () => {
    // The best-effort behaviour from the previous test must NOT extend
    // to the primary status read — if `getActiveProofPeriodStatus` itself
    // fails, the prover MUST hear about it (otherwise we'd silently
    // pin to a fabricated default and the prover's wall-clock check
    // would compare against a nonsense activeProofPeriodStartBlock).
    const a = new EVMChainAdapter(minimalConfig());
    const fakeRs = {
      getActiveProofPeriodStatus: async () => {
        throw new Error('UpstreamRPCBadGateway');
      },
      getActiveProofingPeriodDurationInBlocks: async () => 600n,
    };
    (a as any).init = async () => undefined;
    (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
    await expect(a.getActiveProofPeriodStatus()).rejects.toThrow('UpstreamRPCBadGateway');
  });

  it('getActiveProofPeriodStatus populates proofingPeriodDurationInBlocks when both reads succeed', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const fakeRs = {
      getActiveProofPeriodStatus: async () => ({
        activeProofPeriodStartBlock: 9000n,
        isValid: false,
      }),
      getActiveProofingPeriodDurationInBlocks: async () => 50n,
    };
    (a as any).init = async () => undefined;
    (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
    const status = await a.getActiveProofPeriodStatus();
    expect(status.activeProofPeriodStartBlock).toBe(9000n);
    expect(status.isValid).toBe(false);
    expect(status.proofingPeriodDurationInBlocks).toBe(50n);
  });

  it('getActiveProofPeriodStatus does not stall when the duration probe hangs (Codex round 5, fake-timers)', async () => {
    // A provider that accepts the request but never resolves — e.g.
    // RPC slow path, half-broken websocket — would otherwise pin
    // every status read until the underlying timeout (often >30s)
    // and silently freeze the prover loop. The 2s race must kick
    // in long before the primary status leg comes back, returning
    // `undefined` so the prover falls back to the cached duration.
    //
    // Codex round 6 on PR #369: drive setTimeout via fake timers
    // instead of waiting on real wall clock. Real-time assertions
    // are flaky under loaded CI / long GC pauses.
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const fakeRs = {
        getActiveProofPeriodStatus: async () => ({
          activeProofPeriodStartBlock: 1234n,
          isValid: true,
        }),
        getActiveProofingPeriodDurationInBlocks: () =>
          new Promise(() => {/* never resolves */}),
      };
      (a as any).init = async () => undefined;
      (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
      const inflight = a.getActiveProofPeriodStatus();
      // Advance past DURATION_PROBE_TIMEOUT_MS (2000) to fire the
      // fallback resolve and let the awaited Promise.all settle.
      await vi.advanceTimersByTimeAsync(2001);
      const status = await inflight;
      expect(status.activeProofPeriodStartBlock).toBe(1234n);
      expect(status.isValid).toBe(true);
      expect(status.proofingPeriodDurationInBlocks).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('getActiveProofPeriodStatus single-flights the duration probe (Codex round 6)', async () => {
    // A hung probe must NOT cause one stuck `eth_call` per tick —
    // the adapter has to reuse the in-flight promise across
    // overlapping calls so cardinality stays at 1. Without this
    // guard, a long-lived node in a hung-RPC state would leak one
    // stuck request per tick and eventually exhaust handles.
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const probeCalls = vi.fn();
      const fakeRs = {
        getActiveProofPeriodStatus: async () => ({
          activeProofPeriodStartBlock: 7n,
          isValid: false,
        }),
        getActiveProofingPeriodDurationInBlocks: () => {
          probeCalls();
          return new Promise(() => {/* never resolves */});
        },
      };
      (a as any).init = async () => undefined;
      (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
      // Three back-to-back tick calls; each times out at 2s with
      // fallback `undefined`. The duration probe MUST be issued
      // exactly once across all three because the in-flight
      // promise from tick #1 is still pending.
      const calls = [
        a.getActiveProofPeriodStatus(),
        a.getActiveProofPeriodStatus(),
        a.getActiveProofPeriodStatus(),
      ];
      await vi.advanceTimersByTimeAsync(2001);
      const results = await Promise.all(calls);
      for (const r of results) {
        expect(r.activeProofPeriodStartBlock).toBe(7n);
        expect(r.isValid).toBe(false);
        expect(r.proofingPeriodDurationInBlocks).toBeUndefined();
      }
      expect(probeCalls).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the duration probe slot when the resolved RS Contract instance changes (TTL refresh, Codex round 8)', async () => {
    // The TTL-refresh path of HubResolutionCache re-resolves the
    // contract to a freshly constructed Contract instance WITHOUT
    // calling invalidateRandomSamplingPair() and WITHOUT bumping
    // the (invalidate-only) generation counter. A probe started
    // against the old contract must NOT be paired with the new
    // contract's status. The guard compares the resolved Contract
    // by reference identity — a refresh always hands back a new
    // instance, so this fires on both same-address and changed-
    // address refreshes.
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const probeCalls = vi.fn();
      const oldRs = {
        getActiveProofPeriodStatus: async () => ({
          activeProofPeriodStartBlock: 1n,
          isValid: true,
        }),
        getActiveProofingPeriodDurationInBlocks: () => {
          probeCalls();
          return new Promise(() => {/* hang */});
        },
      };
      // Distinct Contract instance with the same shape — simulates
      // the post-refresh Contract a TTL re-resolve would produce
      // even when the underlying address is unchanged.
      const refreshedRs = { ...oldRs };
      (a as any).init = async () => undefined;
      (a as any).getRandomSampling = async () => ({ rs: oldRs, rss: {} });
      const first = a.getActiveProofPeriodStatus();
      await vi.advanceTimersByTimeAsync(2001);
      await first;
      expect(probeCalls).toHaveBeenCalledTimes(1);
      // TTL refresh: re-resolve hands back a fresh Contract instance.
      (a as any).getRandomSampling = async () => ({ rs: refreshedRs, rss: {} });
      const second = a.getActiveProofPeriodStatus();
      await vi.advanceTimersByTimeAsync(2001);
      await second;
      // Contract identity changed → slot was dropped → fresh probe issued.
      expect(probeCalls).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the duration probe slot when it exceeds MAX_PROBE_AGE_MS (Codex round 8)', async () => {
    // A truly hung probe (underlying eth_call never settles) must
    // not suppress every fresh probe forever. The age guard kicks
    // in after 30s and abandons the slot so the next call can
    // issue a new one — capping leaked-handle growth to one per
    // 30s window instead of one per tick.
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const probeCalls = vi.fn();
      const fakeRs = {
        getActiveProofPeriodStatus: async () => ({
          activeProofPeriodStartBlock: 1n,
          isValid: true,
        }),
        getActiveProofingPeriodDurationInBlocks: () => {
          probeCalls();
          return new Promise(() => {/* hang */});
        },
      };
      (a as any).init = async () => undefined;
      (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
      const first = a.getActiveProofPeriodStatus();
      await vi.advanceTimersByTimeAsync(2001);
      await first;
      expect(probeCalls).toHaveBeenCalledTimes(1);
      // Fast-forward past MAX_PROBE_AGE_MS (30s).
      await vi.advanceTimersByTimeAsync(30_001);
      const second = a.getActiveProofPeriodStatus();
      await vi.advanceTimersByTimeAsync(2001);
      await second;
      // Slot was abandoned by the age guard, fresh probe was started.
      expect(probeCalls).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidateRandomSamplingPair drops the in-flight duration probe so a Hub rotation forces a fresh one (Codex round 7)', async () => {
    // If a probe was started against the OLD RandomSampling contract
    // and Hub rotates before it settles:
    //   - Without this fix: the next status call would pair the new
    //     contract's status with the old contract's stale duration,
    //     OR (if the old probe hangs) suppress every fresh probe
    //     forever via the single-flight guard.
    //   - With this fix: invalidate() drops the slot; the next call
    //     issues a fresh probe against the new contract.
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const probeCalls = vi.fn();
      const oldRs = {
        getActiveProofPeriodStatus: async () => ({
          activeProofPeriodStartBlock: 1n,
          isValid: true,
        }),
        getActiveProofingPeriodDurationInBlocks: () => {
          probeCalls();
          return new Promise(() => {/* old contract probe hangs */});
        },
      };
      const newRs = {
        getActiveProofPeriodStatus: async () => ({
          activeProofPeriodStartBlock: 2n,
          isValid: true,
        }),
        getActiveProofingPeriodDurationInBlocks: async () => {
          probeCalls();
          return 555n;
        },
      };
      (a as any).init = async () => undefined;
      (a as any).getRandomSampling = async () => ({ rs: oldRs, rss: {} });
      const stale = a.getActiveProofPeriodStatus();
      await vi.advanceTimersByTimeAsync(2001);
      await stale;
      expect(probeCalls).toHaveBeenCalledTimes(1);
      // Simulate Hub rotation: invalidate the RS pair cache.
      (a as any).invalidateRandomSamplingPair();
      // Swap in the NEW contract for the next call.
      (a as any).getRandomSampling = async () => ({ rs: newRs, rss: {} });
      vi.useRealTimers();
      const fresh = await a.getActiveProofPeriodStatus();
      expect(fresh.activeProofPeriodStartBlock).toBe(2n);
      expect(fresh.proofingPeriodDurationInBlocks).toBe(555n);
      // Probe must have run against the NEW contract — total
      // probeCalls is now 2 (old hung + new succeeded).
      expect(probeCalls).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getActiveProofPeriodStatus issues a fresh probe after the previous one settles (Codex round 6)', async () => {
    // Once the in-flight probe rejects/resolves, the next call MUST
    // be allowed to issue a new one — otherwise a single transient
    // failure would permanently disable the live duration read.
    const a = new EVMChainAdapter(minimalConfig());
    const probeCalls = vi.fn();
    let attempt = 0;
    const fakeRs = {
      getActiveProofPeriodStatus: async () => ({
        activeProofPeriodStartBlock: 99n,
        isValid: true,
      }),
      getActiveProofingPeriodDurationInBlocks: async () => {
        probeCalls();
        attempt += 1;
        if (attempt === 1) throw new Error('first attempt fails');
        return 77n;
      },
    };
    (a as any).init = async () => undefined;
    (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
    const first = await a.getActiveProofPeriodStatus();
    expect(first.proofingPeriodDurationInBlocks).toBeUndefined();
    // Wait a microtask so the .finally that clears the slot runs.
    await Promise.resolve();
    const second = await a.getActiveProofPeriodStatus();
    expect(second.proofingPeriodDurationInBlocks).toBe(77n);
    expect(probeCalls).toHaveBeenCalledTimes(2);
  });

  it('coerces randomSamplingHubRefreshMs<=0 to the default TTL (no "disable refresh" mode)', () => {
    // The "disable refresh entirely" mode is intentionally not
    // supported — without a TTL backstop, a missed Hub event on a
    // read-only path (e.g. getActiveProofPeriodStatus) would leave
    // the adapter pinned to a stale RandomSampling address until
    // restart. The constructor coerces values <=0 (and undefined) to
    // the same 5-minute default. We verify by peeking the underlying
    // cache's ttlMs option.
    const DEFAULT_TTL_MS = 5 * 60 * 1000;
    const aZero = new EVMChainAdapter(minimalConfig({ randomSamplingHubRefreshMs: 0 }));
    const aNeg = new EVMChainAdapter(minimalConfig({ randomSamplingHubRefreshMs: -42 }));
    const aDefault = new EVMChainAdapter(minimalConfig());
    const ttlOf = (a: EVMChainAdapter) =>
      ((a as any).randomSamplingPairCache.opts as { ttlMs: number }).ttlMs;
    expect(ttlOf(aZero)).toBe(DEFAULT_TTL_MS);
    expect(ttlOf(aNeg)).toBe(DEFAULT_TTL_MS);
    expect(ttlOf(aDefault)).toBe(DEFAULT_TTL_MS);
  });
});

// #894 round-2 / Codex PR #901: register-503-under-RPC-outage. Uses a real
// loopback HTTP server (not Hardhat) that returns HTTP 429 for every JSON-RPC
// call, mirroring `daemon-http-behavior-extra.test.ts`'s `startRateLimitedRpc`.
// ethers v6's default FetchRequest retries 429 with backoff far longer than any
// caller timeout, so a chain read (`init()`'s Hub lookups, on the critical path
// of `createOnChainContextGraph`) would hang for minutes. The bounded
// `retryFunc` must make the read surface `RPC_ENDPOINTS_EXHAUSTED` in seconds so
// `/api/context-graph/register` returns 503 (not hang / 500).
describe('init() RPC-exhaustion bounding (perpetual 429)', () => {
  let server: Server | null = null;
  let url = '';
  // Track every adapter the tests build so teardown can `destroy()` them. Under
  // a perpetual 429 the provider keeps retrying with backoff on a keep-alive
  // socket AFTER the call rejects; if we don't tear it down, that live
  // connection keeps `server.close()` from ever invoking its callback, and the
  // afterEach hook blows past vitest's 10s hook-timeout (the flaky CI failure).
  const adapters: EVMChainAdapter[] = [];
  function track(a: EVMChainAdapter): EVMChainAdapter {
    adapters.push(a);
    return a;
  }

  async function startRateLimited429(): Promise<string> {
    server = createServer((_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'rate limited' } }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('mock RPC failed to bind');
    return `http://127.0.0.1:${addr.port}`;
  }

  afterEach(async () => {
    // Stop ethers' background retry loop / idle sockets FIRST, then force-close
    // any still-open connections, so `server.close()` resolves promptly instead
    // of hanging on the provider's in-flight 429 retry.
    for (const a of adapters.splice(0)) {
      try { a.destroy(); } catch { /* destroy() is idempotent */ }
    }
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('surfaces RPC_ENDPOINTS_EXHAUSTED from createOnChainContextGraph within a bounded time under a perpetually rate-limited RPC', async () => {
    url = await startRateLimited429();
    const a = track(new EVMChainAdapter(minimalConfig({ rpcUrl: url, rpcUrls: [] })));

    const start = Date.now();
    let thrown: any;
    try {
      await a.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 0 });
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - start;

    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    // The classifier (`classifyRegisterContextGraphError`) maps the code → 503
    // and surfaces `.message`; it must read as an RPC-endpoint exhaustion so the
    // register test's `/RPC|endpoint|rate/i` body assertion holds.
    expect(thrown.message).toMatch(/RPC|endpoint|rate/i);
    expect(thrown.rpcUrls).toEqual([url]);
    // Bounded: well under the daemon route / test 120s ceiling. The budget is
    // ~6s of retry; allow generous slack for the in-flight network bootstrap.
    expect(elapsed).toBeLessThan(45_000);
  }, 60_000);

  it('keeps the retry budget PER-REQUEST — a later request still retries (Codex PR #901 round-3 :125)', async () => {
    // Regression guard: the budget was once a `Date.now()` deadline captured at
    // provider construction, so after the budget elapsed (node uptime) EVERY
    // later request lost all retries. Two sequential reads, spaced past the
    // backoff budget, must BOTH retry the RPC multiple times.
    let hits = 0;
    server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'rate limited' } }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('mock RPC failed to bind');
    url = `http://127.0.0.1:${addr.port}`;
    const a = track(new EVMChainAdapter(minimalConfig({ rpcUrl: url, rpcUrls: [] })));

    // First read: exhaust + count its retries. >1 hit ⇒ it retried.
    hits = 0;
    await a.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 0 }).catch(() => {});
    const firstRequestHits = hits;
    expect(firstRequestHits).toBeGreaterThan(1);

    // Second read (provider already "aged" past the old construction-time
    // deadline by the first request's ~7.5s of backoff): must ALSO retry. Under
    // the construction-time-deadline bug this would have made exactly 1 hit.
    hits = 0;
    await a.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 0 }).catch(() => {});
    expect(hits).toBeGreaterThan(1);
  }, 60_000);
});

describe('PR3 / RC11 — publish-preflight TTL cache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('getEvmChainId issues exactly one provider.getNetwork call across repeat reads', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const getNetwork = vi.fn(async () => ({ chainId: 31337n }));
    (a as unknown as { provider: { getNetwork: () => Promise<{ chainId: bigint }> } }).provider = {
      getNetwork: getNetwork as unknown as () => Promise<{ chainId: bigint }>,
    };

    expect(await a.getEvmChainId()).toBe(31337n);
    expect(await a.getEvmChainId()).toBe(31337n);
    expect(await a.getEvmChainId()).toBe(31337n);
    expect(getNetwork).toHaveBeenCalledTimes(1);
  });

  it('getKnowledgeAssetsLifecycleAddress caches the contract address across repeat reads', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const getAddress = vi.fn(async () => '0xCONTRACT');
    (a as unknown as { init: () => Promise<void> }).init = async () => undefined;
    (a as unknown as { contracts: { knowledgeAssetsLifecycle: { getAddress: () => Promise<string> } } }).contracts = {
      knowledgeAssetsLifecycle: { getAddress: getAddress as unknown as () => Promise<string> },
    };

    expect(await a.getKnowledgeAssetsLifecycleAddress()).toBe('0xCONTRACT');
    expect(await a.getKnowledgeAssetsLifecycleAddress()).toBe('0xCONTRACT');
    expect(getAddress).toHaveBeenCalledTimes(1);
  });

  it('getMinimumRequiredSignatures caches across repeat reads', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const minimumRequiredSignatures = vi.fn(async () => 3n);
    (a as unknown as { init: () => Promise<void> }).init = async () => undefined;
    (a as unknown as { contracts: { parametersStorage: { minimumRequiredSignatures: () => Promise<bigint> } } }).contracts = {
      parametersStorage: {
        minimumRequiredSignatures: minimumRequiredSignatures as unknown as () => Promise<bigint>,
      },
    };

    expect(await a.getMinimumRequiredSignatures()).toBe(3);
    expect(await a.getMinimumRequiredSignatures()).toBe(3);
    expect(await a.getMinimumRequiredSignatures()).toBe(3);
    expect(minimumRequiredSignatures).toHaveBeenCalledTimes(1);
  });

  it('refreshes after the 1h TTL expires', async () => {
    vi.useFakeTimers({ now: 0 });
    const a = new EVMChainAdapter(minimalConfig());
    let returned = 31337n;
    const getNetwork = vi.fn(async () => ({ chainId: returned }));
    (a as unknown as { provider: { getNetwork: () => Promise<{ chainId: bigint }> } }).provider = {
      getNetwork: getNetwork as unknown as () => Promise<{ chainId: bigint }>,
    };

    expect(await a.getEvmChainId()).toBe(31337n);
    expect(getNetwork).toHaveBeenCalledTimes(1);

    vi.setSystemTime(60 * 60 * 1000 - 1);
    expect(await a.getEvmChainId()).toBe(31337n);
    expect(getNetwork).toHaveBeenCalledTimes(1);

    vi.setSystemTime(60 * 60 * 1000 + 1);
    returned = 84532n;
    expect(await a.getEvmChainId()).toBe(84532n);
    expect(getNetwork).toHaveBeenCalledTimes(2);
  });

  it('invalidatePublishPreflightCache forces a fresh read on next call', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const getNetwork = vi.fn(async () => ({ chainId: 31337n }));
    (a as unknown as { provider: { getNetwork: () => Promise<{ chainId: bigint }> } }).provider = {
      getNetwork: getNetwork as unknown as () => Promise<{ chainId: bigint }>,
    };

    await a.getEvmChainId();
    await a.getEvmChainId();
    expect(getNetwork).toHaveBeenCalledTimes(1);
    a.invalidatePublishPreflightCache();
    await a.getEvmChainId();
    expect(getNetwork).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache failures (next call retries the underlying read)', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    let attempts = 0;
    const getNetwork = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('rate limited');
      return { chainId: 31337n };
    });
    (a as unknown as { provider: { getNetwork: () => Promise<{ chainId: bigint }> } }).provider = {
      getNetwork: getNetwork as unknown as () => Promise<{ chainId: bigint }>,
    };

    await expect(a.getEvmChainId()).rejects.toThrow('rate limited');
    // Second call should retry — failure was not memoised.
    expect(await a.getEvmChainId()).toBe(31337n);
    expect(getNetwork).toHaveBeenCalledTimes(2);
  });
});

describe('effectivePublishAllowance (V10 approval-ceiling policy)', () => {
  // Empirical motivation, May 2026 on Base Sepolia (`miles-publish-stress-26may`):
  // a publish with JS-side `params.tokenAmount === 0n` reverted with
  // `TooLowAllowance(token, 0, 1)` because the auto-approve path skipped
  // approval entirely (`currentAllowance < 0n` is never true). The contract
  // pulls `transferFrom(..., 1n)` even for zero-value publishes. These tests
  // pin down the policy that floors approvals at the on-chain minimum.

  it('exposes the on-chain minimum constant as 1n', () => {
    expect(V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE).toBe(1n);
  });

  it('floors at 1n when tokenAmount is 0n (the bug we hit)', () => {
    expect(effectivePublishAllowance(0n)).toBe(1n);
  });

  it('floors at 1n when tokenAmount equals the minimum', () => {
    expect(effectivePublishAllowance(1n)).toBe(1n);
  });

  it('passes through tokenAmount when larger than the minimum', () => {
    expect(effectivePublishAllowance(42n)).toBe(42n);
    expect(effectivePublishAllowance(10n ** 18n)).toBe(10n ** 18n);
  });

  it('respects an injected on-chain minimum (forward-compat for contract upgrades)', () => {
    expect(effectivePublishAllowance(0n, 10n)).toBe(10n);
    expect(effectivePublishAllowance(5n, 10n)).toBe(10n);
    expect(effectivePublishAllowance(50n, 10n)).toBe(50n);
  });

  it('preserves the bounded-approval security property (never returns MaxUint256 unless asked)', () => {
    // The policy must never silently widen approval beyond what the caller
    // requested — that would defeat the per-publish ceiling that protects
    // the operational wallet against a compromised KA contract.
    const huge = 10n ** 30n;
    expect(effectivePublishAllowance(huge)).toBe(huge);
    expect(effectivePublishAllowance(huge)).not.toBe(ethers.MaxUint256);
  });
});

describe('computeApprovalAction — per-publish (default, backward-compatible)', () => {
  // Reproduces every code path the policy-less adapter took before this
  // PR. New operators inherit this default; explicit `mode: 'per-publish'`
  // produces identical behaviour.

  const policy: ApprovalPolicy = { mode: 'per-publish' };

  it('matches DEFAULT_APPROVAL_POLICY', () => {
    expect(DEFAULT_APPROVAL_POLICY.mode).toBe('per-publish');
  });

  it('approves the 1n floor when tokenAmount=0n and currentAllowance=0n', () => {
    const action = computeApprovalAction(policy, 0n, 0n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(1n);
  });

  it('skips approve when current already covers the publish floor (0n / 1n)', () => {
    expect(computeApprovalAction(policy, 0n, 1n)).toEqual({
      needsApprove: false,
      targetAllowance: 1n,
    });
  });

  it('approves exactly tokenAmount when current is short', () => {
    const action = computeApprovalAction(policy, 1000n, 500n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(1000n);
  });

  it('does not re-approve when current >= tokenAmount', () => {
    expect(computeApprovalAction(policy, 1000n, 1000n).needsApprove).toBe(false);
    expect(computeApprovalAction(policy, 1000n, 5000n).needsApprove).toBe(false);
  });

  it('never widens approval beyond tokenAmount (bounded-per-publish security property)', () => {
    const action = computeApprovalAction(policy, 10n ** 18n, 0n);
    expect(action.targetAllowance).toBe(10n ** 18n);
    expect(action.targetAllowance).not.toBe(ethers.MaxUint256);
  });
});

describe('computeApprovalAction — replenishing (recommended for mainnet)', () => {
  // Approve a configurable ceiling once; refill when current drops below
  // `target × refillBelowFraction`. Pre-mainnet stress run on Base Sepolia
  // showed this would amortise approve-gas to ~1/9 of the per-publish
  // policy at default config.

  it('exposes sane defaults', () => {
    // 1000 TRAC = 1e21 wei-TRAC
    expect(DEFAULT_REPLENISH_TARGET_ALLOWANCE).toBe(10n ** 21n);
    expect(DEFAULT_REFILL_BELOW_FRACTION).toBe(0.1);
  });

  it('approves the default 1000 TRAC ceiling on a fresh wallet', () => {
    const policy: ApprovalPolicy = { mode: 'replenishing' };
    const action = computeApprovalAction(policy, 1n, 0n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(10n ** 21n);
  });

  it('skips approve when current is comfortably above the refill threshold', () => {
    const policy: ApprovalPolicy = { mode: 'replenishing' };
    // Default target 1000 TRAC, refill at 100 TRAC. 500 TRAC current → no refill.
    const action = computeApprovalAction(policy, 1n, 500n * (10n ** 18n));
    expect(action.needsApprove).toBe(false);
    expect(action.targetAllowance).toBe(10n ** 21n);
  });

  it('triggers refill when current drops below 10% of target (default fraction)', () => {
    const policy: ApprovalPolicy = { mode: 'replenishing' };
    // 99 TRAC current, threshold is 100 TRAC → refill.
    const action = computeApprovalAction(policy, 1n, 99n * (10n ** 18n));
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(10n ** 21n);
  });

  it('respects a custom targetAllowance + refillBelowFraction', () => {
    const policy: ApprovalPolicy = {
      mode: 'replenishing',
      targetAllowance: 100n * (10n ** 18n), // 100 TRAC ceiling
      refillBelowFraction: 0.5,              // refill at 50 TRAC
    };
    // Current 60 TRAC → above threshold (50 TRAC) → no refill.
    expect(computeApprovalAction(policy, 1n, 60n * (10n ** 18n)).needsApprove).toBe(false);
    // Current 40 TRAC → below threshold → refill to 100 TRAC.
    const action = computeApprovalAction(policy, 1n, 40n * (10n ** 18n));
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(100n * (10n ** 18n));
  });

  it('raises a too-low targetAllowance to at least the publish floor', () => {
    // Operator misconfigured `targetAllowance: 100n` but this publish
    // needs 500n — should approve 500n, not let it brick the publish.
    const policy: ApprovalPolicy = { mode: 'replenishing', targetAllowance: 100n };
    const action = computeApprovalAction(policy, 500n, 0n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(500n);
  });

  it('treats targetAllowance=0n as "use publish floor"', () => {
    const policy: ApprovalPolicy = { mode: 'replenishing', targetAllowance: 0n };
    const action = computeApprovalAction(policy, 0n, 0n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(1n); // publish floor wins
  });

  it('clamps refillBelowFraction to [0, 1]', () => {
    const above: ApprovalPolicy = { mode: 'replenishing', refillBelowFraction: 2 };
    const aboveAction = computeApprovalAction(above, 1n, 10n ** 21n - 1n);
    expect(aboveAction.needsApprove).toBe(true); // fraction clamps to 1 → always refill below full target

    const below: ApprovalPolicy = { mode: 'replenishing', refillBelowFraction: -1 };
    const belowAction = computeApprovalAction(below, 1n, 0n);
    // fraction clamps to 0 → threshold = 0, but publishFloor (1n) wins
    expect(belowAction.needsApprove).toBe(true);
    expect(belowAction.targetAllowance).toBe(10n ** 21n);
  });

  it('handles NaN / non-finite refillBelowFraction by falling back to the default', () => {
    const policy: ApprovalPolicy = {
      mode: 'replenishing',
      refillBelowFraction: Number.NaN,
    };
    // Default 0.1 → threshold = 100 TRAC. 99 TRAC current → refill.
    const action = computeApprovalAction(policy, 1n, 99n * (10n ** 18n));
    expect(action.needsApprove).toBe(true);
  });

  it('refill threshold respects the publish floor even when fraction × target is below it', () => {
    // Tiny target, tiny fraction, but the immediate publish needs 1000n.
    const policy: ApprovalPolicy = {
      mode: 'replenishing',
      targetAllowance: 100n,
      refillBelowFraction: 0.01, // threshold = 1n
    };
    // Current 500n: above the 1n threshold but below the publish floor (1000n).
    const action = computeApprovalAction(policy, 1000n, 500n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(1000n); // target raised to publish floor
  });
});

describe('computeApprovalAction — unlimited (V9 pattern)', () => {
  const policy: ApprovalPolicy = { mode: 'unlimited' };

  it('approves MaxUint256 on a fresh wallet', () => {
    const action = computeApprovalAction(policy, 1n, 0n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(ethers.MaxUint256);
  });

  it('never re-approves once the wallet has any usable allowance', () => {
    // currentAllowance of 1n is enough for a 0n-floored publish — skip approve.
    expect(computeApprovalAction(policy, 0n, 1n).needsApprove).toBe(false);
    // currentAllowance of MaxUint256 — definitely skip.
    expect(computeApprovalAction(policy, 10n ** 30n, ethers.MaxUint256).needsApprove).toBe(false);
  });

  it('re-approves if external actor revoked allowance back below the publish floor', () => {
    // Defensive path: if someone called approve(KA, 0) on this wallet, the
    // next publish should refill MaxUint256, not silently revert.
    expect(computeApprovalAction(policy, 1n, 0n).needsApprove).toBe(true);
  });
});

describe('computeApprovalAction — invariants across all modes', () => {
  // Properties that must hold for every policy/tokenAmount/currentAllowance
  // combination — exercised explicitly because they're the structural
  // safety net behind the policy abstraction.

  const allModes: ApprovalPolicy[] = [
    { mode: 'per-publish' },
    { mode: 'replenishing' },
    { mode: 'unlimited' },
  ];

  it('targetAllowance is always >= effectivePublishAllowance(tokenAmount)', () => {
    for (const policy of allModes) {
      for (const tokenAmount of [0n, 1n, 1000n, 10n ** 18n]) {
        for (const currentAllowance of [0n, 1n, 10n ** 21n]) {
          const action = computeApprovalAction(policy, tokenAmount, currentAllowance);
          const floor = effectivePublishAllowance(tokenAmount);
          expect(action.targetAllowance).toBeGreaterThanOrEqual(floor);
        }
      }
    }
  });

  it('needsApprove is monotone in currentAllowance (more allowance never flips false → true)', () => {
    for (const policy of allModes) {
      for (const tokenAmount of [0n, 1n, 1000n, 10n ** 18n]) {
        let lastNeedsApprove = true;
        for (const currentAllowance of [
          0n,
          1n,
          10n ** 18n,
          10n ** 21n,
          ethers.MaxUint256,
        ]) {
          const action = computeApprovalAction(policy, tokenAmount, currentAllowance);
          // Once we've seen needsApprove=false for some currentAllowance,
          // any larger currentAllowance must also yield false.
          if (lastNeedsApprove === false) {
            expect(action.needsApprove).toBe(false);
          }
          lastNeedsApprove = action.needsApprove;
        }
      }
    }
  });

  it('unknown mode falls back to per-publish behaviour', () => {
    // Defensive — if a malformed config sneaks through, we should still
    // produce *some* sane action rather than throwing inside the publish
    // hot path.
    const action = computeApprovalAction(
      { mode: 'gibberish' as any },
      1000n,
      0n,
    );
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(1000n); // per-publish
  });
});

// -----------------------------------------------------------------------------
// Adapter-level integration tests for the V10 approval gate (#720 + Codex
// follow-up on PR #720). The pure-helper tests above prove that
// `computeApprovalAction(policy, tokenAmount, currentAllowance)` produces
// the right `(needsApprove, targetAllowance)`. The tests below exercise the
// real publish/update wiring: that `ensureV10ApproveTrac`
//   1. reads `token.allowance(signerAddr, kaV10Addr)` from the connected
//      token contract,
//   2. forwards `(policy, tokenAmount, currentAllowance)` to the helper,
//   3. issues exactly one `approve(kaV10Addr, targetAllowance)` when
//      `needsApprove === true` (with the correct label so publish vs update
//      stay distinguishable on-chain in tracing),
//   4. is a strict no-op otherwise (the metadata-only update happy path),
//   5. and is a no-op for read-only adapters (`this.contracts.token`
//      absent).
//
// `sendContractTransaction` is stubbed at the adapter so the assertions
// stay on the public call shape without dragging the broadcast / signing
// machinery into scope; that surface is covered by the
// `sendContractTransaction` / `sendSignedTransactionAndWait` tests above.
// -----------------------------------------------------------------------------

const V10_KA_ADDRESS = '0x' + 'aa'.repeat(20);

function makeMockToken(allowance: bigint) {
  const tokenWithSigner = {
    allowance: vi.fn(async () => allowance),
    // `approve` is invoked through the adapter's `sendContractTransaction`
    // (which is stubbed below), so the mock just needs to exist for any
    // future code path that probes it.
    approve: vi.fn(),
  };
  const tokenRoot = {
    connect: vi.fn(() => tokenWithSigner),
  };
  return { tokenRoot, tokenWithSigner };
}

function makeV10Adapter(approvalPolicy?: ApprovalPolicy, allowance: bigint = 0n) {
  const a = new EVMChainAdapter(minimalConfig({ approvalPolicy }));
  const { tokenRoot, tokenWithSigner } = makeMockToken(allowance);
  (a as any).contracts.token = tokenRoot;
  const sendSpy = vi.fn(async () => ({} as unknown));
  (a as any).sendContractTransaction = sendSpy;
  const signer = new ethers.Wallet(DEPLOYER_PK);
  return { a, signer, tokenRoot, tokenWithSigner, sendSpy };
}

function getApproveCallArgs(sendSpy: ReturnType<typeof vi.fn>): {
  contract: unknown;
  method: string;
  args: readonly unknown[];
  signer: unknown;
  label: string;
} {
  expect(sendSpy).toHaveBeenCalledTimes(1);
  const [contract, method, args, signerArg, label] = sendSpy.mock.calls[0];
  return { contract, method, args, signer: signerArg, label };
}

describe('ensureV10ApproveTrac — per-publish (default) approval gate', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('zero-cost publish on a fresh wallet → approves the 1n floor (#720 mainnet revert fix)', async () => {
    // The exact scenario that reverted on mainnet pre-#720: a publish with
    // `tokenAmount=0n` against a wallet that has never approved TRAC to the
    // V10 KnowledgeAssets contract. The fix is the 1n floor in
    // `effectivePublishAllowance`; the test asserts that the adapter
    // *actually* observes it on the publish call path.
    const { a, signer, tokenWithSigner, sendSpy } = makeV10Adapter(undefined, 0n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC',
    );

    expect(tokenWithSigner.allowance).toHaveBeenCalledTimes(1);
    expect(tokenWithSigner.allowance).toHaveBeenCalledWith(signer.address, V10_KA_ADDRESS);

    const call = getApproveCallArgs(sendSpy);
    expect(call.method).toBe('approve');
    expect(call.args).toEqual([V10_KA_ADDRESS, 1n]);
    expect(call.signer).toBe(signer);
    expect(call.label).toBe('approve V10 publish TRAC');
  });

  it('metadata-only update with existing 1n allowance → NO approve (idle reuse, #720)', async () => {
    // After the first publish, the wallet retains a 1n allowance. A
    // subsequent metadata-only update (`newTokenAmount=0n`) must NOT
    // re-send an approve — that would be a pointless on-chain write and
    // a Codex review concern on PR #720.
    const { a, signer, tokenWithSigner, sendSpy } = makeV10Adapter(undefined, 1n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 update TRAC',
    );

    expect(tokenWithSigner.allowance).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('zero-cost publish with comfortable leftover allowance → NO approve', async () => {
    // Operator pre-approved a large allowance (e.g. switching from
    // unlimited or replenishing on a previous run). A zero-cost publish
    // must reuse the existing allowance, not refill.
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 10n ** 18n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('positive tokenAmount with empty allowance → approve(tokenAmount)', async () => {
    // The standard per-publish path: fresh wallet, paid publish. Approve
    // exactly `tokenAmount` (bounded-per-publish security property).
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 0n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.method).toBe('approve');
    expect(call.args).toEqual([V10_KA_ADDRESS, 100n]);
  });

  it('positive tokenAmount with partial allowance → approve(tokenAmount) (top-up to exact)', async () => {
    // Per-publish never widens beyond `tokenAmount`. If the wallet has 50n
    // and we need 100n, we approve 100n — not e.g. (100n - 50n) or a
    // larger ceiling.
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 50n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.args).toEqual([V10_KA_ADDRESS, 100n]);
  });

  it('positive tokenAmount with allowance already covering it → NO approve', async () => {
    // Two paid publishes in a row from the same wallet to the same KA
    // contract: the second one must skip the approve.
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 200n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('positive tokenAmount with allowance exactly matching → NO approve (boundary case)', async () => {
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 100n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('read-only adapter (no token contract bound) → no-op, no allowance read, no approve', async () => {
    // Adapters constructed for read-only nodes don't resolve the V10 Token
    // contract. The gate must be a clean no-op there — not throw on
    // `this.contracts.token.connect(...)`.
    const a = new EVMChainAdapter(minimalConfig());
    const sendSpy = vi.fn(async () => ({} as unknown));
    (a as any).sendContractTransaction = sendSpy;
    (a as any).contracts.token = undefined;
    const signer = new ethers.Wallet(DEPLOYER_PK);

    await expect((a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC',
    )).resolves.toBeUndefined();

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('zero-cost publish (#720 floor kicked in) → emits the operator-facing warn', async () => {
    // #871 observability: when `tokenAmount === 0n` and the policy lifts
    // `targetAllowance` to the 1n floor, the adapter logs a single
    // `console.warn` so operators inspecting on-chain allowance can
    // recognise the resulting "1 wei dust" as the documented #720
    // workaround instead of mistaking it for a stuck approval.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 0n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC',
    );

    // Approve still fires (behaviour unchanged).
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(getApproveCallArgs(sendSpy).args).toEqual([V10_KA_ADDRESS, 1n]);

    // And the diagnostic warn fires exactly once with the expected wording.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('V10 per-publish auto-approve floor');
    expect(message).toContain('#720 transferFrom-minimum workaround');
    expect(message).toContain('tokenAmount=0');
  });

  it('legitimate 1-wei publish → approves 1n WITHOUT emitting the #720 warn (Codex on PR #875)', async () => {
    // Negative case for the warn guard. A `tokenAmount === 1n` publish
    // produces `targetAllowance === 1n` under per-publish too, but the
    // 1-wei is the real publish cost — NOT the #720 floor workaround.
    // The warn line would mislead operators if it fired here, so the
    // guard requires `tokenAmount === 0n` in addition to the
    // `targetAllowance === 1n` check.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 0n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      1n,
      'approve V10 publish TRAC',
    );

    // Approve still fires for the genuine 1-wei publish.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(getApproveCallArgs(sendSpy).args).toEqual([V10_KA_ADDRESS, 1n]);

    // But the floor-workaround warn must NOT fire (it would be a false
    // positive — see PR #875 review thread).
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('ensureV10ApproveTrac — replenishing policy (high-volume operator default)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('approves the default 1000 TRAC ceiling on a fresh wallet', async () => {
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'replenishing' },
      0n,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.args).toEqual([V10_KA_ADDRESS, DEFAULT_REPLENISH_TARGET_ALLOWANCE]);
  });

  it('skips approve when allowance is comfortably above the refill threshold', async () => {
    // Default refill fraction is 0.1, so the threshold is 100 TRAC. A
    // wallet with 500 TRAC should NOT trigger a refill on the next
    // publish.
    const allowance = 500n * (10n ** 18n);
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'replenishing' },
      allowance,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('refills back to target when allowance drops below the refill threshold', async () => {
    // Threshold (10% of default target) is 100 TRAC. An allowance of
    // 50 TRAC is *below* threshold → refill to the full 1000 TRAC.
    const allowance = 50n * (10n ** 18n);
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'replenishing' },
      allowance,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.args).toEqual([V10_KA_ADDRESS, DEFAULT_REPLENISH_TARGET_ALLOWANCE]);
  });

  it('honours a custom targetAllowance + refillBelowFraction from operator config', async () => {
    // Operator-configured policy: ceiling 200n, refill below 50%. Below
    // 100n → refill; at/above 100n → skip.
    const policy: ApprovalPolicy = {
      mode: 'replenishing',
      targetAllowance: 200n,
      refillBelowFraction: 0.5,
    };

    {
      const { a, signer, sendSpy } = makeV10Adapter(policy, 99n);
      await (a as any).ensureV10ApproveTrac(signer, V10_KA_ADDRESS, 0n, 'approve V10 publish TRAC');
      const call = getApproveCallArgs(sendSpy);
      expect(call.args).toEqual([V10_KA_ADDRESS, 200n]);
    }
    {
      const { a, signer, sendSpy } = makeV10Adapter(policy, 100n);
      await (a as any).ensureV10ApproveTrac(signer, V10_KA_ADDRESS, 0n, 'approve V10 publish TRAC');
      expect(sendSpy).not.toHaveBeenCalled();
    }
  });
});

describe('ensureV10ApproveTrac — unlimited policy (V9 pattern)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('approves MaxUint256 once on a fresh wallet', async () => {
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'unlimited' },
      0n,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.args).toEqual([V10_KA_ADDRESS, ethers.MaxUint256]);
  });

  it('never re-approves once the wallet has the unlimited allowance live', async () => {
    // Steady state after the first publish: the wallet has MaxUint256 in
    // allowance. Any reasonable subsequent publish must skip re-approving
    // — that's the whole point of the unlimited policy.
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'unlimited' },
      ethers.MaxUint256,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('skips re-approve once current >= publish floor (defensive — partial residual allowance from another policy)', async () => {
    // If an operator switched into unlimited mode mid-flight and the
    // wallet already has enough for the immediate publish, don't waste
    // an approve — even though the *intended* steady state is MaxUint256,
    // the immediate publish doesn't need it.
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'unlimited' },
      100n,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('still re-approves MaxUint256 if an external actor revoked allowance to 0', async () => {
    // Defensive path: someone called `approve(KA, 0)` on this wallet
    // out-of-band. The next publish must refill, not silently revert in
    // the contract's `transferFrom`.
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'unlimited' },
      0n,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC',
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.args).toEqual([V10_KA_ADDRESS, ethers.MaxUint256]);
  });
});

describe('ensureV10ApproveTrac — call-site invariants (publish vs update)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('passes the publish label through verbatim (so on-chain tracing distinguishes publish from update)', async () => {
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 0n);
    await (a as any).ensureV10ApproveTrac(signer, V10_KA_ADDRESS, 0n, 'approve V10 publish TRAC');
    expect(sendSpy.mock.calls[0][4]).toBe('approve V10 publish TRAC');
  });

  it('passes the update label through verbatim', async () => {
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 0n);
    await (a as any).ensureV10ApproveTrac(signer, V10_KA_ADDRESS, 0n, 'approve V10 update TRAC');
    expect(sendSpy.mock.calls[0][4]).toBe('approve V10 update TRAC');
  });

  it('connects the bound token contract to the operational signer (not the admin signer)', async () => {
    // The approve must go out from the same signer that the publish/
    // update tx will use, so `tokenAmount` is debited from the right
    // wallet's allowance and not from the admin EOA.
    const { a, signer, tokenRoot } = makeV10Adapter(undefined, 0n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(tokenRoot.connect).toHaveBeenCalledTimes(1);
    expect(tokenRoot.connect).toHaveBeenCalledWith(signer);
  });

  it('reads allowance against the passed-in KA address (not a globally cached one)', async () => {
    // Defensive against future refactors that try to cache `kaAddress`
    // on the adapter and forget to invalidate after a Hub rotation.
    const otherKa = '0x' + 'bb'.repeat(20);
    const { a, signer, tokenWithSigner } = makeV10Adapter(undefined, 0n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      otherKa,
      0n,
      'approve V10 publish TRAC',
    );

    expect(tokenWithSigner.allowance).toHaveBeenCalledWith(signer.address, otherKa);
  });

  it('propagates approve failures to the caller (so publish/update aborts cleanly)', async () => {
    // If the approve broadcast fails (RPC outage, insufficient gas, ...),
    // the caller must see the rejection — silently swallowing it would
    // lead to a downstream `publishV10` that reverts deep in the
    // contract's `transferFrom`.
    const a = new EVMChainAdapter(minimalConfig());
    const { tokenRoot } = makeMockToken(0n);
    (a as any).contracts.token = tokenRoot;
    (a as any).sendContractTransaction = vi.fn(async () => {
      throw new Error('approve broadcast failed');
    });
    const signer = new ethers.Wallet(DEPLOYER_PK);

    await expect((a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC',
    )).rejects.toThrow('approve broadcast failed');
  });

  it('is invariant to allowance() returning a string-encoded bigint (defensive against ABI quirks)', async () => {
    // ethers v6 returns `bigint` from contract reads, but bonus coverage:
    // the gate must not coerce-via-Number or otherwise lose precision on
    // very large allowances. Use a 2^200 allowance to make any Number
    // coercion immediately wrong.
    const huge = 2n ** 200n;
    const { a, signer, sendSpy } = makeV10Adapter(undefined, huge);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Regression tests for #870 — per-publish allowance check must target the
// actual publish signer.
//
// Reported scenario: a fresh edge node reverted with
// `TooLowAllowance(TRAC, 0, 1)` on `KnowledgeAssetsLifecycle.publish(...)`
// even though the default `per-publish` policy should have auto-approved.
// One candidate root cause was a wallet mismatch — the approval gate reading
// allowance against signer A while `publishV10` later submitted from a
// different signer B with 0 allowance.
//
// The tests below pin down the invariant end-to-end by driving
// `createKnowledgeAssets` / `updateKnowledgeCollectionV10` with a multi-wallet
// signer pool and asserting the approve sender is the wallet that goes on
// to sign the publish / update tx. They catch any future refactor that
// would reintroduce the mismatch — by reading allowance against `this.signer`
// instead of `txSigner`, by rotating signers between the two steps, etc.
// -----------------------------------------------------------------------------

describe('createKnowledgeAssets / updateKnowledgeCollectionV10 — approval signer parity (#870)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const PARITY_KA_ADDRESS = '0x' + 'cd'.repeat(20);

  function makeAllowanceByOwner(): Map<string, bigint> {
    return new Map<string, bigint>();
  }

  function makeMultiWalletV10Adapter(allowanceByOwner: Map<string, bigint>) {
    const a = new EVMChainAdapter(minimalConfig({
      privateKey: DEPLOYER_PK,
      additionalKeys: [OTHER_PK],
    }));
    const [walletA, walletB] = (a as any).signerPool as [ethers.Wallet, ethers.Wallet];

    (a as any).initialized = true;

    const tokenWithSigner = {
      allowance: vi.fn(async (owner: string, _spender: string) => {
        return allowanceByOwner.get(owner.toLowerCase()) ?? 0n;
      }),
      approve: vi.fn(),
    };
    (a as any).contracts.token = {
      connect: vi.fn(() => tokenWithSigner),
    };

    const populateSpy = vi.fn(async () => ({
      to: PARITY_KA_ADDRESS,
      data: '0xdeadbeef',
    }));
    const kavContract = {
      getAddress: vi.fn(async () => PARITY_KA_ADDRESS),
      publish: { populateTransaction: populateSpy },
      update: { populateTransaction: populateSpy },
    };
    (a as any).contracts.knowledgeAssetsLifecycle = {
      connect: vi.fn(() => kavContract),
      getAddress: vi.fn(async () => PARITY_KA_ADDRESS),
    };

    (a as any).contracts.contextGraphs = {
      isAuthorizedPublisher: vi.fn(async () => true),
    };

    const sendSpy = vi.fn(async () => ({} as unknown));
    (a as any).sendContractTransaction = sendSpy;

    // Stop the publish/update flow right after the approval gate by throwing
    // a sentinel at the signing step. We only need to observe the signer
    // arguments at `ensureV10ApproveTrac` and `signPopulatedTransaction`.
    const signSpy = vi.fn(async () => {
      throw new Error('SENTINEL_STOP_AFTER_APPROVE');
    });
    (a as any).signPopulatedTransaction = signSpy;

    return { a, walletA, walletB, tokenWithSigner, sendSpy, signSpy, populateSpy };
  }

  function makeV10PublishParams(publisherAddress?: string): any {
    const authorAddress = publisherAddress ?? ethers.ZeroAddress;
    // OT-RFC-43 Option-1 (variant 1a): the real `createKnowledgeAssets`
    // entrypoint now requires a packed reservedKaId in the author's namespace
    // and fails loud (pre-tx) otherwise. These approval-parity tests drive the
    // real method (with the rest of the adapter stubbed), so supply a valid
    // packed id = (uint160(author) << 96) | number for THIS test's author.
    const reservedKaId = (BigInt(ethers.getAddress(authorAddress)) << 96n) | 1n;
    const params: any = {
      publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
      contextGraphId: 7n,
      merkleRoot: ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('mr'))),
      knowledgeAssetsAmount: 1,
      byteSize: 100,
      epochs: 1,
      tokenAmount: 0n,
      isImmutable: false,
      merkleLeafCount: 1,
      reservedKaId,
      publisherNodeIdentityId: 0n,
      author: {
        address: authorAddress,
        signature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
        schemeVersion: 1,
      },
      ackSignatures: [],
    };
    if (publisherAddress) params.publisherAddress = publisherAddress;
    return params;
  }

  it('publish path: approve fires from the wallet matching publisherAddress, NOT a sibling pool wallet with stale allowance', async () => {
    // The exact #870 scenario:
    //   - Pool = [walletA, walletB].
    //   - walletA already has 10 TRAC allowance (e.g. left over from an
    //     earlier op or another publisher in the same daemon).
    //   - walletB has 0 allowance (fresh).
    //   - The publisher binds the tx to walletB via `publisherAddress`.
    //   - `ensureV10ApproveTrac` MUST read allowance(walletB, KA) and send
    //     `approve(KA, 1n)` from walletB — NOT from walletA. The publish tx
    //     that follows MUST also be signed by walletB.
    //
    // A regression that read allowance against `this.signer` (== walletA in
    // this pool ordering) would see 10 TRAC ≥ 1n, skip approve, then submit
    // a publish from walletB that reverts on-chain with
    // `TooLowAllowance(TRAC, 0, 1)` — exactly the symptom in #870.
    const allowanceByOwner = makeAllowanceByOwner();
    const { a, walletA, walletB, tokenWithSigner, sendSpy, signSpy } =
      makeMultiWalletV10Adapter(allowanceByOwner);
    allowanceByOwner.set(walletA.address.toLowerCase(), 10n * 10n ** 18n);
    allowanceByOwner.set(walletB.address.toLowerCase(), 0n);

    await expect(
      a.createKnowledgeAssets(makeV10PublishParams(walletB.address)),
    ).rejects.toThrow('SENTINEL_STOP_AFTER_APPROVE');

    expect(tokenWithSigner.allowance).toHaveBeenCalledWith(
      walletB.address,
      PARITY_KA_ADDRESS,
    );
    expect(tokenWithSigner.allowance).not.toHaveBeenCalledWith(
      walletA.address,
      PARITY_KA_ADDRESS,
    );

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [, approveMethod, approveArgs, approveSender] = sendSpy.mock.calls[0];
    expect(approveMethod).toBe('approve');
    expect(approveArgs).toEqual([PARITY_KA_ADDRESS, 1n]);
    expect(approveSender).toBe(walletB);

    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(signSpy.mock.calls[0][0]).toBe(walletB);
  });

  it('publish path: when publisherAddress is omitted, round-robin signer is also the approve signer (no mid-flight rotation)', async () => {
    // Without `publisherAddress`, `txSigner` is picked via
    // `nextAuthorizedSigner` (round-robin among authorized wallets). The
    // approval and the publish MUST target that same wallet — no signer swap
    // between the two steps. A regression that called
    // `nextAuthorizedSigner` again later in the flow would rotate to the
    // next wallet and reintroduce the wallet-mismatch class of bug.
    const allowanceByOwner = makeAllowanceByOwner();
    const { a, walletA, tokenWithSigner, sendSpy, signSpy } =
      makeMultiWalletV10Adapter(allowanceByOwner);

    await expect(
      a.createKnowledgeAssets(makeV10PublishParams()),
    ).rejects.toThrow('SENTINEL_STOP_AFTER_APPROVE');

    expect(tokenWithSigner.allowance).toHaveBeenCalledWith(
      walletA.address,
      PARITY_KA_ADDRESS,
    );
    const [, approveMethod, approveArgs, approveSender] = sendSpy.mock.calls[0];
    expect(approveMethod).toBe('approve');
    expect(approveArgs).toEqual([PARITY_KA_ADDRESS, 1n]);
    expect(approveSender).toBe(walletA);
    expect(signSpy.mock.calls[0][0]).toBe(walletA);
  });

  it('update path: approve fires from the on-chain publisher wallet, NOT a round-robin pick from the pool', async () => {
    // `updateKnowledgeCollectionV10` resolves the signer by looking up
    // `getLatestMerkleRootPublisher(kaId)` first; only if that wallet is not
    // in the pool does it fall back to the publisherAddress hint or
    // `nextSigner()` (round-robin). The approval gate MUST target the
    // resolved wallet — otherwise a wallet with stale allowance from any
    // other operation could falsely pass the gate while the actual update
    // tx submits from a different wallet at 0 allowance.
    const allowanceByOwner = makeAllowanceByOwner();
    const { a, walletA, walletB, tokenWithSigner, sendSpy, signSpy } =
      makeMultiWalletV10Adapter(allowanceByOwner);
    // walletA — the default round-robin pick (index 0) — has plenty of
    // allowance. walletB — the on-chain publisher of this KA — has none.
    allowanceByOwner.set(walletA.address.toLowerCase(), 10n * 10n ** 18n);
    allowanceByOwner.set(walletB.address.toLowerCase(), 0n);

    // Mocks the update path needs in addition to the publish ones.
    const kaId = 42n;
    (a as any).contracts.knowledgeAssetStorage = {
      getLatestMerkleRootPublisher: vi.fn(async () => walletB.address),
      getMerkleRoots: vi.fn(async () => []),
    };
    (a as any).contracts.contextGraphStorage = {
      kaToContextGraph: vi.fn(async () => 0n),
    };
    (a as any).resolveCurrentTokenAmount = vi.fn(async () => 0n);
    (a as any).computeUpdateNewTokenAmount = vi.fn(async () => 0n);
    (a as any).getIdentityId = vi.fn(async () => 0n);
    // `provider.getNetwork()` is called for chainId; stub it so the update
    // path doesn't try to hit the placeholder RPC.
    (a as any).provider = {
      getNetwork: vi.fn(async () => ({ chainId: 31337n })),
    };

    const updateParams: any = {
      kaId,
      newMerkleRoot: ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('umr'))),
      newByteSize: 100,
      newMerkleLeafCount: 1,
      newTokenAmount: 0n,
      authorAddress: walletB.address,
      authorR: new Uint8Array(32),
      authorVS: new Uint8Array(32),
      authorSchemeVersion: 1,
      // Provide pre-signed ACKs so the update path skips the in-line
      // `signer.signMessage(ackDigest)` step that would otherwise trip on
      // our minimal mocking surface.
      ackSignatures: [{
        identityId: 1n,
        r: new Uint8Array(32),
        vs: new Uint8Array(32),
      }],
    };

    await expect(
      a.updateKnowledgeCollectionV10(updateParams),
    ).rejects.toThrow('SENTINEL_STOP_AFTER_APPROVE');

    expect(tokenWithSigner.allowance).toHaveBeenCalledWith(
      walletB.address,
      PARITY_KA_ADDRESS,
    );
    expect(tokenWithSigner.allowance).not.toHaveBeenCalledWith(
      walletA.address,
      PARITY_KA_ADDRESS,
    );

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [, approveMethod, approveArgs, approveSender, approveLabel] =
      sendSpy.mock.calls[0];
    expect(approveMethod).toBe('approve');
    expect(approveArgs).toEqual([PARITY_KA_ADDRESS, 1n]);
    expect(approveSender).toBe(walletB);
    expect(approveLabel).toBe('approve V10 update TRAC');

    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(signSpy.mock.calls[0][0]).toBe(walletB);
  });
});

// -----------------------------------------------------------------------------
// #888 — intermittent `TooLowAllowance(TRAC, 0, 1)` on consecutive zero-cost
// publishes. The on-chain allowance read that gates the auto-approve and the
// `estimateGas` ethers runs while populating the publish tx can observe a
// STALE allowance on an internally load-balanced RPC: either a just-consumed
// per-publish 1-wei floor still reads as `1` (so the re-approve is skipped) or
// a freshly-sent approve hasn't propagated to the read replica yet. The fix:
//   1. `isTooLowAllowanceError` classifies the revert,
//   2. `createKnowledgeAssets` retries populate+sign once on that revert with a
//      forced re-approve (the revert is strictly pre-broadcast, so it's safe),
//   3. the forced re-approve approves up to the publish floor regardless of the
//      gating read and confirms the new allowance is visible before returning.
// -----------------------------------------------------------------------------

describe('isTooLowAllowanceError (#888)', () => {
  it('matches the ethers v6 decoded custom-error shape (revert.name)', () => {
    expect(isTooLowAllowanceError({ revert: { name: 'TooLowAllowance' }, message: 'execution reverted' })).toBe(true);
  });

  it('matches a stringified revert in message / shortMessage / reason', () => {
    expect(isTooLowAllowanceError(new Error('execution reverted: TooLowAllowance(0xTRAC, 0, 1)'))).toBe(true);
    expect(isTooLowAllowanceError({ shortMessage: 'execution reverted (TooLowAllowance)' })).toBe(true);
    expect(isTooLowAllowanceError({ reason: 'TooLowAllowance' })).toBe(true);
  });

  it('matches a nested cause.message', () => {
    expect(isTooLowAllowanceError({ message: 'wrapped', cause: new Error('inner: TooLowAllowance(...)') })).toBe(true);
  });

  it('does not match unrelated reverts / errors', () => {
    expect(isTooLowAllowanceError(new Error('TooLowStake(node, 0, 50000)'))).toBe(false);
    expect(isTooLowAllowanceError({ revert: { name: 'NotBatchPublisher' }, message: 'execution reverted' })).toBe(false);
    expect(isTooLowAllowanceError(new Error('insufficient funds for gas'))).toBe(false);
  });

  it('handles non-object / null / numeric / string inputs safely', () => {
    expect(isTooLowAllowanceError(null)).toBe(false);
    expect(isTooLowAllowanceError(undefined)).toBe(false);
    expect(isTooLowAllowanceError('TooLowAllowance')).toBe(false);
    expect(isTooLowAllowanceError(42)).toBe(false);
  });
});

function makeV10AdapterWithAllowanceSequence(values: bigint[]) {
  const a = new EVMChainAdapter(minimalConfig());
  let i = 0;
  const tokenWithSigner = {
    allowance: vi.fn(async () => values[Math.min(i++, values.length - 1)]),
    approve: vi.fn(),
  };
  const tokenRoot = { connect: vi.fn(() => tokenWithSigner) };
  (a as any).contracts.token = tokenRoot;
  const sendSpy = vi.fn(async () => ({} as unknown));
  (a as any).sendContractTransaction = sendSpy;
  const signer = new ethers.Wallet(DEPLOYER_PK);
  return { a, signer, tokenWithSigner, sendSpy };
}

describe('ensureV10ApproveTrac — forced re-approve + visibility poll (#888)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('force=true re-approves even when the gating read says the allowance is already sufficient (stale-high skip)', async () => {
    // The "stale-high" sub-race: the per-publish 1-wei floor consumed by
    // the previous publish still reads as `1`, so `needsApprove` is false
    // and the un-forced path would skip the approve — but the real
    // on-chain allowance is 0 and the publish would revert. Forcing the
    // re-approve corrects this.
    const { a, signer, tokenWithSigner, sendSpy } = makeV10Adapter(undefined, 1n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC (forced re-approve, #888)',
      true,
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.method).toBe('approve');
    expect(call.args).toEqual([V10_KA_ADDRESS, 1n]);
    // gating read (1n) + one visibility-poll read (1n ≥ target → confirmed).
    expect(tokenWithSigner.allowance).toHaveBeenCalledTimes(2);
  });

  it('force=false with a sufficient allowance issues NO approve and NO visibility poll (steady-state unchanged)', async () => {
    const { a, signer, tokenWithSigner, sendSpy } = makeV10Adapter(undefined, 1n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy).not.toHaveBeenCalled();
    // Only the single gating read — the poll is gated on `force`.
    expect(tokenWithSigner.allowance).toHaveBeenCalledTimes(1);
  });

  it('forced re-approve polls until the fresh approve becomes visible on the RPC read path', async () => {
    const { a, signer, tokenWithSigner, sendSpy } = makeV10AdapterWithAllowanceSequence([
      0n, // gating read → needsApprove
      0n, // poll read 1 → approve not yet propagated to the read replica
      1n, // poll read 2 → now visible
    ]);

    await (a as any).ensureV10ApproveTrac(signer, V10_KA_ADDRESS, 0n, 'forced', true);

    expect(sendSpy).toHaveBeenCalledTimes(1); // exactly one approve
    expect(tokenWithSigner.allowance).toHaveBeenCalledTimes(3); // gating + 2 polls
  });

  it('forced re-approve is best-effort: gives up after the bounded poll budget without throwing', async () => {
    const { a, signer, tokenWithSigner, sendSpy } = makeV10AdapterWithAllowanceSequence([0n]); // never visible

    await expect(
      (a as any).ensureV10ApproveTrac(signer, V10_KA_ADDRESS, 0n, 'forced', true),
    ).resolves.toBeUndefined();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    // gating read + 6 bounded poll attempts. Proves the poll is bounded
    // (no hang); the caller's gas-estimation then surfaces a definitive
    // revert if the allowance genuinely never propagates.
    expect(tokenWithSigner.allowance).toHaveBeenCalledTimes(7);
  }, 15_000);

  // PR #896 review (🔴): each visibility-poll read must be bounded by a
  // timeout. A raw `token.allowance()` on a hung / read-stalled RPC never
  // rejects, so without `withTimeout` the supposedly-bounded recovery poll
  // could block publish/update indefinitely. Drive the whole loop under fake
  // timers and assert it resolves (does not hang) even when every read stalls
  // forever.
  it('bounds each visibility poll with a timeout so a hung RPC read cannot block the recovery (#896)', async () => {
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      // allowance() returns a promise that never settles — a hung RPC read.
      const token = { allowance: vi.fn(() => new Promise<bigint>(() => {})) };
      const done = vi.fn();
      const poll = (a as any)
        .confirmAllowanceVisible(token, '0xowner', V10_KA_ADDRESS, 1n)
        .then(done);
      // Advance past 6 × (4s read timeout) + the capped backoff sleeps.
      await vi.advanceTimersByTimeAsync(60_000);
      await poll;
      // Resolved rather than hanging, and each of the 6 bounded reads was
      // attempted (and timed out) instead of blocking on the first one.
      expect(done).toHaveBeenCalledTimes(1);
      expect(token.allowance).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

// PR #896 review (🔴): the forced-re-approve recovery was inlined in the
// publish path only, leaving `updateV10` exposed to the same stale-allowance
// race on metadata-only updates. The recovery now lives in a shared helper
// (`populateAndSignV10WithAllowanceRecovery`) used by BOTH V10 write paths.
// These tests pin that shared behaviour directly.
function makeRecoveryAdapter() {
  const a = new EVMChainAdapter(minimalConfig());
  const ensureSpy = vi.fn(async () => {});
  const signSpy = vi.fn(async () => ({ signedTx: '0xsigned', txHash: '0xhash' }));
  (a as any).ensureV10ApproveTrac = ensureSpy;
  (a as any).signPopulatedTransaction = signSpy;
  return { a, ensureSpy, signSpy, signer: new ethers.Wallet(DEPLOYER_PK) };
}

const tooLowAllowanceRevert = () =>
  new Error('execution reverted: TooLowAllowance(0xTRAC, 0, 1)');

describe('populateAndSignV10WithAllowanceRecovery — shared publish/update recovery (#888/#896)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // The 🔴 fix: BOTH write paths recover from a pre-broadcast
  // `TooLowAllowance` revert, not just publish.
  it.each(['publish', 'update'] as const)(
    'forces a fresh approve and retries populate+sign exactly once on a stale TooLowAllowance (%s)',
    async (method) => {
      const { a, ensureSpy, signSpy, signer } = makeRecoveryAdapter();
      const populate = vi.fn()
        .mockRejectedValueOnce(tooLowAllowanceRevert())
        .mockResolvedValueOnce({ to: V10_KA_ADDRESS, data: '0xabcd' });
      const kaContract = { [method]: { populateTransaction: populate } };

      const result = await (a as any).populateAndSignV10WithAllowanceRecovery(
        signer,
        kaContract,
        method,
        { some: 'params' },
        V10_KA_ADDRESS,
        0n,
        `approve V10 ${method} TRAC (forced re-approve, #888)`,
      );

      expect(result).toEqual({ signedTx: '0xsigned', txHash: '0xhash' });
      expect(populate).toHaveBeenCalledTimes(2); // initial revert + one retry
      expect(signSpy).toHaveBeenCalledTimes(1);  // signed only after the retry
      // forced re-approve fired once, against the right KA + with force=true.
      expect(ensureSpy).toHaveBeenCalledTimes(1);
      expect(ensureSpy.mock.calls[0][0]).toBe(signer);
      expect(ensureSpy.mock.calls[0][1]).toBe(V10_KA_ADDRESS);
      expect(ensureSpy.mock.calls[0][4]).toBe(true);
    },
  );

  it('propagates a SECOND consecutive TooLowAllowance (recovery is one-shot, no infinite loop)', async () => {
    const { a, ensureSpy, signSpy, signer } = makeRecoveryAdapter();
    const populate = vi.fn().mockRejectedValue(tooLowAllowanceRevert());
    const kaContract = { publish: { populateTransaction: populate } };

    await expect(
      (a as any).populateAndSignV10WithAllowanceRecovery(
        signer, kaContract, 'publish', {}, V10_KA_ADDRESS, 0n, 'label',
      ),
    ).rejects.toThrow('TooLowAllowance');

    expect(populate).toHaveBeenCalledTimes(2); // initial + one forced retry, then give up
    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(signSpy).not.toHaveBeenCalled();
  });

  it('propagates an unrelated revert immediately without forcing a re-approve', async () => {
    const { a, ensureSpy, signSpy, signer } = makeRecoveryAdapter();
    const populate = vi.fn().mockRejectedValue(new Error('execution reverted: NotBatchPublisher()'));
    const kaContract = { update: { populateTransaction: populate } };

    await expect(
      (a as any).populateAndSignV10WithAllowanceRecovery(
        signer, kaContract, 'update', {}, V10_KA_ADDRESS, 0n, 'label',
      ),
    ).rejects.toThrow('NotBatchPublisher');

    expect(populate).toHaveBeenCalledTimes(1); // no retry on a non-allowance error
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(signSpy).not.toHaveBeenCalled();
  });
});
