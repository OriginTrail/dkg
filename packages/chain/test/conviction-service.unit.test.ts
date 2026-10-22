/**
 * Conviction Account service spending (OT-RFC-27) on the EVM adapter, without a
 * chain: the contract reads and the transaction send are stubbed on a real
 * `EVMChainAdapter`, and every argument and receipt goes through the vendored
 * ABIs.
 *
 * Covered:
 *   - the ABI encoding of each call, against calldata built from the Solidity
 *     signatures with every struct field in declaration order;
 *   - the EIP-712 typed data, equal to `ServiceSubscriptions.hashAssignment`:
 *     a known-answer vector from the compiled contract, an independent
 *     `abi.encode` computation with the type string read from the Solidity
 *     source, and the buyer key's consent signature;
 *   - `PeriodFunded` parsing from a funding receipt;
 *   - error decoding: every custom error the service contracts can revert with
 *     is classified, and reverts surface as typed errors;
 *   - `existing: true` on a repeated `periodId`, with the original funding's
 *     transaction recovered and nothing sent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Contract, ethers, type InterfaceAbi } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { HubContractNotFoundError } from '../src/hub-contract-not-found-error.js';
import { RemoteSignerError } from '../src/remote-signer-errors.js';
import {
  SERVICE_ASSIGNMENT_TYPES,
  convictionServiceDomain,
  serviceAssignmentDigest,
  serviceSubscriptionIdOf,
  type CaAssignmentTerms,
  type CaFundingRequest,
} from '../src/conviction-service.js';
import {
  CONVICTION_SERVICE_REVERT_KINDS,
  ConvictionServiceInputError,
  ConvictionServiceRevertError,
  ConvictionServiceUnavailableError,
  convictionServiceRevertKind,
  isConvictionServiceRevertError,
} from '../src/conviction-service-errors.js';
import { decodeServicePeriodFunding, getServiceSubscriptionsInterface } from '../src/evm-adapter-conviction-service.js';
import { getPcaLogicInterface } from '../src/evm-adapter-errors.js';

// Hardhat's well-known development keys #0 (owner) and #1 (buyer key).
const OWNER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const BUYER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const OWNER = new ethers.Wallet(OWNER_PK).address;
const BUYER = new ethers.Wallet(BUYER_PK).address;

const HUB = '0x0000000000000000000000000000000000000001';
const SS = ethers.getAddress('0x' + '5e'.repeat(20));
const CSS = ethers.getAddress('0x' + '5c'.repeat(20));
const PC = ethers.getAddress('0x' + '9c'.repeat(20));
const NFT = ethers.getAddress('0x' + 'a1'.repeat(20));
const PARAMS = ethers.getAddress('0x' + 'a2'.repeat(20));
const EPOCHS = ethers.getAddress('0x' + 'a3'.repeat(20));
const TRAC = 10n ** 18n;

const SS_IFACE = getServiceSubscriptionsInterface();
const PC_IFACE = getPcaLogicInterface();

const TERMS: CaAssignmentTerms = {
  accountId: 42n,
  assignee: BUYER,
  maxCostPerPeriod: 25n * TRAC,
  maxInferenceCostPerPeriod: 25n * TRAC,
  maxQueryCostPerPeriod: 0n,
  maxCostPerWindow: 100n * TRAC,
  maxTotalCost: 1000n * TRAC,
  maxPeriodSeconds: 2_678_400,
  expiresAt: 1_795_996_800,
  nonce: 3n,
};

const bytes32 = (byte: string): string => '0x' + byte.repeat(32);

const REQUEST: CaFundingRequest = {
  accountId: 42n,
  periodId: bytes32('ab'),
  sessionKey: ethers.ZeroAddress,
  periodSeconds: 2_592_000,
  planDigest: bytes32('cd'),
  buckets: [
    { bucketId: bytes32('01'), serviceClass: 1, value: 10n * TRAC, maxAskWeiPerUnit: 2_500_000_000_000n },
    { bucketId: bytes32('02'), serviceClass: 2, value: 2n * TRAC, maxAskWeiPerUnit: 1_000_000n },
  ],
};

type Read = (...args: any[]) => unknown;
interface Sent { to: string; method: string; args: readonly unknown[]; from: string }

/**
 * A real adapter with `init` skipped, the service contracts at fixed addresses,
 * every contract read answered from `reads` (keyed `address:method`) and every
 * send recorded and answered by `receipt`.
 */
function harness(config: Partial<EVMAdapterConfig> = {}) {
  const adapter = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:59997',
    privateKey: OWNER_PK,
    additionalKeys: [BUYER_PK],
    hubAddress: HUB,
    chainId: 'evm:31337',
    staticNetwork: false,
    allowNoAdminSigner: true,
    ...config,
  } as EVMAdapterConfig);
  const a = adapter as any;
  const byName: Record<string, Contract> = {
    ServiceSubscriptions: new Contract(SS, loadAbi('ServiceSubscriptions')),
    ConvictionServiceStorage: new Contract(CSS, loadAbi('ConvictionServiceStorage')),
    PublishingConviction: new Contract(PC, loadAbi('PublishingConviction')),
    EpochStorageV8: new Contract(EPOCHS, loadAbi('EpochStorage')),
  };
  const missing = new Set<string>();
  a.init = async () => undefined;
  a.getEvmChainId = async () => 31337n;
  a.resolveContract = async (name: string) => {
    if (missing.has(name) || !byName[name]) throw new HubContractNotFoundError(name, HUB);
    return byName[name];
  };
  a.contracts.dkgPublishingConvictionNFT = new Contract(NFT, loadAbi('DKGPublishingConvictionNFT'));
  a.contracts.parametersStorage = new Contract(PARAMS, loadAbi('ParametersStorage'));

  const reads = new Map<string, Read>();
  const readLog: string[] = [];
  a.readContract = async (contract: Contract, _label: string, method: string, ...args: unknown[]) => {
    const key = `${await contract.getAddress()}:${method}`;
    readLog.push(key);
    const read = reads.get(key);
    if (!read) throw new Error(`unexpected read ${key}`);
    return read(...args);
  };
  const sent: Sent[] = [];
  let receipt: (s: Sent) => unknown = () => ({ hash: bytes32('11'), blockNumber: 7, index: 0, status: 1, logs: [] });
  a.sendContractTransaction = async (contract: Contract, method: string, args: readonly unknown[], signer: { address: string }) => {
    const s = { to: await contract.getAddress(), method, args, from: signer.address };
    sent.push(s);
    return receipt(s);
  };
  return {
    adapter,
    reads,
    readLog,
    sent,
    missing,
    onSend(fn: (s: Sent) => unknown) { receipt = fn; },
  };
}

/** An account the NFT knows: `ownerOf` and the `accounts` tuple. */
function withAccount(h: ReturnType<typeof harness>, opts: { owner?: string; createdAt?: number } = {}): void {
  h.reads.set(`${NFT}:ownerOf`, (id: bigint) => {
    if (id !== 42n) throw revertError('ERC721NonexistentToken', [id]);
    return opts.owner ?? OWNER;
  });
  h.reads.set(`${NFT}:accounts`, (id: bigint) => id === 42n
    ? [1_200_000n * TRAC, 100n, 112n, BigInt(opts.createdAt ?? 1_760_000_000), 1_761_036_800n, 12n, 7500n, 12n, false, 0n, 0n]
    : [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, false, 0n, 0n]);
}

const ALL_ERROR_ABIS = ['ServiceSubscriptions', 'ConvictionServiceStorage', 'PublishingConviction',
  'PublishingConvictionStorage', 'DKGPublishingConvictionNFT', 'Hub'];

/** A provider's opaque custom-error revert, as `estimateGas` throws it: no name, only `data`. */
function revertError(name: string, args: readonly unknown[]): Error {
  for (const abi of ALL_ERROR_ABIS) {
    const iface = new ethers.Interface(loadAbi(abi) as InterfaceAbi);
    const fragment = iface.fragments.find((f) => f.type === 'error' && (f as ethers.ErrorFragment).name === name);
    if (!fragment) continue;
    const data = iface.encodeErrorResult(fragment as ethers.ErrorFragment, args);
    return Object.assign(
      new Error(`execution reverted (unknown custom error) (action="estimateGas", data="${data}", reason=null)`),
      { code: 'CALL_EXCEPTION', data },
    );
  }
  throw new Error(`no vendored ABI declares ${name}`);
}

function logOf(iface: ethers.Interface, address: string, event: string, args: readonly unknown[], index: number) {
  const { topics, data } = iface.encodeEventLog(event, args);
  return { address, topics, data, index, transactionHash: bytes32('11'), blockNumber: 7, transactionIndex: 0 };
}

const BUCKET_TUPLES = REQUEST.buckets.map((b) => [b.bucketId, b.serviceClass, b.value, b.maxAskWeiPerUnit]);

/** The logs of a funding of REQUEST by BUYER: cost 3 TRAC at 7500 bps, all from the window. */
function fundingLogs(subscriptionId: string) {
  return [
    logOf(PC_IFACE, PC, 'ServiceCostCovered', [42n, BUYER, subscriptionId, 12n * TRAC, 3n * TRAC, 1205n, 3n, 3n * TRAC, 0n], 4),
    logOf(SS_IFACE, SS, 'ServiceEmissionLabelled', [42n, 1205n, 1205n, 3n * TRAC, subscriptionId, false], 5),
    logOf(SS_IFACE, SS, 'PeriodFunded', [subscriptionId, 42n, BUYER, REQUEST.periodId, REQUEST.sessionKey,
      REQUEST.planDigest, 1_760_400_200n, 1_762_992_200n, 12n * TRAC, 3n * TRAC, 7500n, BUCKET_TUPLES], 6),
  ];
}

describe('ABI encoding of each call', () => {
  // The Solidity signatures, every struct field positional in declaration order.
  const SOLIDITY = new ethers.Interface([
    'function setServiceSpending(uint256 accountId, bool enabled)',
    'function assign((uint256,address,uint96,uint96,uint96,uint96,uint96,uint32,uint40,uint64) t, bytes ownerSignature, bytes assigneeSignature)',
    'function revoke(uint256 accountId, address assignee)',
    'function updateAssignmentCaps(uint256 accountId, address assignee, (uint96,uint96,uint96,uint96,uint96,uint32,uint40) caps)',
    'function advanceAssignmentNonce(uint256 accountId)',
    'function fundFromConviction((uint256,bytes32,address,uint32,bytes32,(bytes32,uint8,uint96,uint96)[]) r)',
  ]);
  const termsTuple = [TERMS.accountId, TERMS.assignee, TERMS.maxCostPerPeriod, TERMS.maxInferenceCostPerPeriod,
    TERMS.maxQueryCostPerPeriod, TERMS.maxCostPerWindow, TERMS.maxTotalCost, TERMS.maxPeriodSeconds, TERMS.expiresAt, TERMS.nonce];
  const capsTuple = termsTuple.slice(2, 9);

  async function calldataOf(h: ReturnType<typeof harness>, run: () => Promise<unknown>): Promise<Sent & { data: string }> {
    await run();
    const s = h.sent.at(-1)!;
    return { ...s, data: SS_IFACE.encodeFunctionData(s.method, s.args) };
  }

  it('sends each owner write to ServiceSubscriptions from the primary wallet, with the Solidity layout', async () => {
    const h = harness();
    withAccount(h);
    h.reads.set(`${CSS}:assignmentNonce`, () => 5n);
    const cases: Array<[() => Promise<unknown>, string, unknown[]]> = [
      [() => h.adapter.setConvictionServiceSpending(42n, true), 'setServiceSpending', [42n, true]],
      [() => h.adapter.revokeConvictionServiceBuyer(42n, BUYER.toLowerCase()), 'revoke', [42n, BUYER]],
      [() => h.adapter.updateConvictionServiceCaps(42n, BUYER, TERMS), 'updateAssignmentCaps', [42n, BUYER, capsTuple]],
      [() => h.adapter.advanceConvictionServiceNonce(42n), 'advanceAssignmentNonce', [42n]],
      [() => h.adapter.assignConvictionServiceBuyer(TERMS, { assignee: '0x1234' }, 'owner'), 'assign', [termsTuple, '0x', '0x1234']],
    ];
    for (const [run, method, solidityArgs] of cases) {
      const s = await calldataOf(h, run);
      expect(s.method).toBe(method);
      expect(s.to).toBe(SS);
      expect(s.from).toBe(OWNER);
      expect(s.data).toBe(SOLIDITY.encodeFunctionData(method, solidityArgs));
    }
  });

  it('sends fundFromConviction from the buyer key, with the request in the Solidity layout', async () => {
    const h = harness({ convictionServiceBuyerAddress: BUYER });
    h.reads.set(`${CSS}:subscriptionExists`, () => false);
    h.onSend(() => ({ hash: bytes32('11'), blockNumber: 7, index: 0, status: 1, logs: fundingLogs(serviceSubscriptionIdOf(BUYER, REQUEST.periodId)) }));
    const s = await calldataOf(h, () => h.adapter.fundServicePeriodFromConviction(REQUEST));
    expect(s.from).toBe(BUYER);
    expect(s.data).toBe(SOLIDITY.encodeFunctionData('fundFromConviction', [[
      REQUEST.accountId, REQUEST.periodId, REQUEST.sessionKey, REQUEST.periodSeconds, REQUEST.planDigest, BUCKET_TUPLES,
    ]]));
  });

  it('refuses arguments the contracts cannot take before anything is read or sent', async () => {
    const h = harness();
    await expect(h.adapter.fundServicePeriodFromConviction({ ...REQUEST, periodId: '0x1234' })).rejects.toBeInstanceOf(ConvictionServiceInputError);
    await expect(h.adapter.assignConvictionServiceBuyer({ ...TERMS, maxCostPerPeriod: 1n << 96n }, {}, 'owner')).rejects.toThrow(/maxCostPerPeriod/);
    await expect(h.adapter.revokeConvictionServiceBuyer(-1n, BUYER)).rejects.toThrow(/accountId/);
    await expect(h.adapter.getConvictionServiceLabels(42n, 0, 120)).rejects.toThrow(/at most 120 epochs/);
    await expect(h.adapter.listServicePeriods(42n, 0, 101)).rejects.toThrow(/limit/);
    expect(h.sent).toEqual([]);
    expect(h.readLog).toEqual([]);
  });
});

describe('typed data equal to ServiceSubscriptions.hashAssignment', () => {
  // `hashAssignment(TERMS)` and `subscriptionIdOf(BUYER, 0xab…ab)` of the compiled
  // ServiceSubscriptions 1.0.0, deployed first on the Hardhat network (chain 31337).
  const KNOWN = {
    verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    domainSeparator: '0x1d6d0389927e65f751bd390221965e88c6683363f114d218c30ce2481487f996',
    typehash: '0x5c07588c8ab3e5e6af8c92d341b066974907b0dd5ee0ba03186b2d6adf60d435',
    digest: '0x3290218c1875169b166295a1a62ab0848b1f700bceb6335981c7ec8ac50a2c94',
    subscriptionId: '0x7583dcf99ec53d648cd7eb36b331b7a993d4bd4e262d0add096eee7d22f76239',
  };
  const domain = convictionServiceDomain(31337, KNOWN.verifyingContract);

  it('matches the compiled contract: domain separator, type hash, digest and subscription id', () => {
    expect(ethers.TypedDataEncoder.hashDomain(domain)).toBe(KNOWN.domainSeparator);
    expect(ethers.id(ethers.TypedDataEncoder.from(SERVICE_ASSIGNMENT_TYPES).encodeType('ServiceAssignment'))).toBe(KNOWN.typehash);
    expect(serviceAssignmentDigest(domain, TERMS)).toBe(KNOWN.digest);
    expect(serviceSubscriptionIdOf(BUYER, bytes32('ab'))).toBe(KNOWN.subscriptionId);
  });

  it('matches an abi.encode computation with the type string the Solidity source declares', () => {
    const source = readFileSync(join(import.meta.dirname, '../../evm-module/contracts/ServiceSubscriptions.sol'), 'utf8');
    const declared = /SERVICE_ASSIGNMENT_TYPEHASH\s*=\s*keccak256\(\s*((?:"[^"]*"\s*)+)\)/.exec(source)![1]!;
    const typeString = [...declared.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
    expect(ethers.TypedDataEncoder.from(SERVICE_ASSIGNMENT_TYPES).encodeType('ServiceAssignment')).toBe(typeString);

    const coder = ethers.AbiCoder.defaultAbiCoder();
    const separator = ethers.keccak256(coder.encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [ethers.id('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
        ethers.id('DKGConvictionServices'), ethers.id('1'), 31337, KNOWN.verifyingContract],
    ));
    const structHash = ethers.keccak256(coder.encode(
      ['bytes32', 'uint256', 'address', 'uint96', 'uint96', 'uint96', 'uint96', 'uint96', 'uint32', 'uint40', 'uint64'],
      [ethers.id(typeString), TERMS.accountId, TERMS.assignee, TERMS.maxCostPerPeriod, TERMS.maxInferenceCostPerPeriod,
        TERMS.maxQueryCostPerPeriod, TERMS.maxCostPerWindow, TERMS.maxTotalCost, TERMS.maxPeriodSeconds, TERMS.expiresAt, TERMS.nonce],
    ));
    expect(ethers.keccak256(ethers.concat(['0x1901', separator, structHash]))).toBe(serviceAssignmentDigest(domain, TERMS));
  });

  it('signs consent with the buyer key over the digest, under the numeric chain id', async () => {
    const h = harness({ convictionServiceBuyerAddress: BUYER, chainId: 'base:84532' });
    (h.adapter as any).getEvmChainId = async () => 84532n;
    const { digest, signature } = await h.adapter.signConvictionServiceConsent(TERMS);
    const expected = convictionServiceDomain(84532, SS);
    expect(digest).toBe(serviceAssignmentDigest(expected, TERMS));
    expect(ethers.verifyTypedData(expected, SERVICE_ASSIGNMENT_TYPES, { ...TERMS }, signature)).toBe(BUYER);
    expect(ethers.recoverAddress(digest, signature)).toBe(BUYER);
    expect(h.sent).toEqual([]);
  });

  it('refuses to sign terms whose assignee is not the buyer key', async () => {
    const h = harness();
    await expect(h.adapter.signConvictionServiceConsent(TERMS)).rejects.toThrow(/not this node's buyer key/);
  });
});

describe('consent of the sending party', () => {
  it('drops the signature of every party that sends: owner, buyer key and primary wallet the same', async () => {
    const h = harness();
    withAccount(h);
    await h.adapter.assignConvictionServiceBuyer({ ...TERMS, assignee: OWNER }, { owner: '0xdead', assignee: '0xbeef' }, 'owner');
    expect(h.sent[0]!.args.slice(1)).toEqual(['0x', '0x']);
    await h.adapter.assignConvictionServiceBuyer({ ...TERMS, assignee: OWNER }, { owner: '0xdead', assignee: '0xbeef' }, 'assignee');
    expect(h.sent[1]!.args.slice(1)).toEqual(['0x', '0x']);
  });

  it('sends as the assignee with the owner signature, and passes it on for an account the NFT does not know', async () => {
    const h = harness({ convictionServiceBuyerAddress: BUYER });
    withAccount(h);
    await h.adapter.assignConvictionServiceBuyer(TERMS, { owner: '0xdead', assignee: '0xbeef' }, 'assignee');
    expect(h.sent[0]!.from).toBe(BUYER);
    expect(h.sent[0]!.args.slice(1)).toEqual(['0xdead', '0x']);
    await h.adapter.assignConvictionServiceBuyer({ ...TERMS, accountId: 7n }, { owner: '0xdead' }, 'assignee');
    expect(h.sent[1]!.args.slice(1)).toEqual(['0xdead', '0x']);
  });

  it('returns the digest ServiceAssigned records', async () => {
    const h = harness({ convictionServiceBuyerAddress: BUYER });
    withAccount(h);
    h.onSend(() => ({
      hash: bytes32('12'), blockNumber: 8, index: 1, status: 1,
      logs: [logOf(SS_IFACE, SS, 'ServiceAssigned', [42n, BUYER, bytes32('77'), ...Object.values(TERMS).slice(2)], 0)],
    }));
    const result = await h.adapter.assignConvictionServiceBuyer(TERMS, { owner: '0xdead' }, 'assignee');
    expect(result).toMatchObject({ hash: bytes32('12'), blockNumber: 8, txIndex: 1, success: true, digest: bytes32('77') });
  });
});

describe('the buyer key', () => {
  it('is the primary wallet unless configured, and null when the node holds no signer for the configured address', async () => {
    expect(harness().adapter.getConvictionServiceBuyerAddress()).toBe(OWNER);
    expect(harness({ convictionServiceBuyerAddress: BUYER.toLowerCase() }).adapter.getConvictionServiceBuyerAddress()).toBe(BUYER);
    const stranger = harness({ convictionServiceBuyerAddress: ethers.Wallet.createRandom().address });
    expect(stranger.adapter.getConvictionServiceBuyerAddress()).toBeNull();
    expect(harness({ convictionServiceBuyerAddress: 'not-an-address' }).adapter.getConvictionServiceBuyerAddress()).toBeNull();
    await expect(stranger.adapter.fundServicePeriodFromConviction(REQUEST)).rejects.toBeInstanceOf(ConvictionServiceUnavailableError);
    await expect(stranger.adapter.signConvictionServiceConsent(TERMS)).rejects.toBeInstanceOf(ConvictionServiceUnavailableError);
    expect(stranger.sent).toEqual([]);
  });
});

describe('PeriodFunded parsing', () => {
  const id = serviceSubscriptionIdOf(BUYER, REQUEST.periodId);

  it('reads the period from its PeriodFunded log and the draw split of ServiceCostCovered', () => {
    const spoof = logOf(SS_IFACE, ethers.getAddress('0x' + 'ee'.repeat(20)), 'PeriodFunded', [id, 1n, OWNER, REQUEST.periodId,
      REQUEST.sessionKey, REQUEST.planDigest, 1n, 2n, 1n, 1n, 0n, []], 3);
    const decoded = decodeServicePeriodFunding([spoof, ...fundingLogs(id)], SS, id)!;
    expect(decoded.logIndex).toBe(6);
    expect(decoded.period).toEqual({
      subscriptionId: id, accountId: 42n, assignee: BUYER, sessionKey: ethers.ZeroAddress,
      periodId: REQUEST.periodId, planDigest: REQUEST.planDigest, periodStart: 1_760_400_200, periodEnd: 1_762_992_200,
      fundedEpoch: 1205, fundedWindow: 3, discountBps: 7500, value: 12n * TRAC, cost: 3n * TRAC,
      drawnFromWindow: 3n * TRAC, drawnFromTopUp: 0n, buckets: REQUEST.buckets,
    });
    expect(decodeServicePeriodFunding(fundingLogs(id).slice(0, 2), SS, id)).toBeNull();
    expect(decodeServicePeriodFunding(fundingLogs(id), SS, bytes32('99'))).toBeNull();
  });

  it('returns the funding with its log index, and invalidates the account\'s cached allowance', async () => {
    const h = harness({ convictionServiceBuyerAddress: BUYER });
    h.reads.set(`${CSS}:subscriptionExists`, () => false);
    h.onSend(() => ({ hash: bytes32('11'), blockNumber: 7, index: 2, status: 1, logs: fundingLogs(id) }));
    const invalidated: unknown[] = [];
    (h.adapter as any).pcaReadCache.invalidateMutation = (inv: unknown) => invalidated.push(inv);
    const funding = await h.adapter.fundServicePeriodFromConviction(REQUEST);
    expect(funding).toMatchObject({
      hash: bytes32('11'), blockNumber: 7, txIndex: 2, success: true,
      subscriptionId: id, cost: 3n * TRAC, logIndex: 6, existing: false,
    });
    expect(funding.period.drawnFromWindow).toBe(3n * TRAC);
    expect(invalidated).toEqual([{ kind: 'account-changed', accountId: 42n }]);
  });
});

describe('existing on a repeated periodId', () => {
  const id = serviceSubscriptionIdOf(BUYER, REQUEST.periodId);
  const STORED = [42n, BUYER, ethers.ZeroAddress, REQUEST.periodId, REQUEST.planDigest, 1_760_400_200n, 1_762_992_200n,
    1205n, 3n, 7500n, 2n, 12n * TRAC, 3n * TRAC, 3n * TRAC, 0n];

  /** A chain whose block 1000 + k has timestamp 1_760_400_000 + 2k, with the funding at block 1100. */
  function funded(h: ReturnType<typeof harness>) {
    h.reads.set(`${CSS}:subscriptionExists`, () => true);
    h.reads.set(`${CSS}:getSubscription`, () => STORED);
    h.reads.set(`${CSS}:getBuckets`, () => BUCKET_TUPLES);
    const a = h.adapter as any;
    a.readTipProvider = async (_label: string, fn: (p: unknown) => unknown) => fn({ getBlockNumber: async () => 5000 });
    a.readProviderRetryingNull = async (_label: string, fn: (p: unknown) => unknown) => fn({
      getBlock: async (n: number) => ({ number: n, timestamp: 1_760_400_000 + 2 * (n - 1000) }),
    });
    const queries: unknown[] = [];
    const decoy = logOf(SS_IFACE, SS, 'PeriodFunded', [id, 41n, BUYER, REQUEST.periodId, REQUEST.sessionKey,
      REQUEST.planDigest, 1_760_400_200n, 1_762_992_200n, 12n * TRAC, 3n * TRAC, 7500n, BUCKET_TUPLES], 2);
    const original = { ...fundingLogs(id)[2]!, transactionHash: bytes32('0f'), blockNumber: 1100, transactionIndex: 3, index: 9 };
    a.readProvider = async (_label: string, fn: (p: unknown) => unknown) => fn({
      getLogs: async (filter: unknown) => { queries.push(filter); return [decoy, original]; },
    });
    return queries;
  }

  it('answers from the chain with the original funding\'s transaction and log, and sends nothing', async () => {
    const h = harness({ convictionServiceBuyerAddress: BUYER });
    const queries = funded(h);
    const funding = await h.adapter.fundServicePeriodFromConviction(REQUEST);
    expect(h.sent).toEqual([]);
    expect(funding).toMatchObject({
      hash: bytes32('0f'), blockNumber: 1100, txIndex: 3, logIndex: 9, success: true,
      subscriptionId: id, cost: 3n * TRAC, existing: true,
    });
    expect(funding.period.periodStart).toBe(1_760_400_200);
    // One block, found by its timestamp: no wide log range.
    expect(queries).toEqual([{ topics: [SS_IFACE.getEvent('PeriodFunded')!.topicHash, id], fromBlock: 1100, toBlock: 1100 }]);
  });

  it('falls back to the funded period when a concurrent request wins the race', async () => {
    const h = harness({ convictionServiceBuyerAddress: BUYER });
    funded(h);
    let checks = 0;
    h.reads.set(`${CSS}:subscriptionExists`, () => checks++ > 0);
    h.onSend(() => { throw revertError('PeriodAlreadyFunded', [id]); });
    const funding = await h.adapter.fundServicePeriodFromConviction(REQUEST);
    expect(h.sent).toHaveLength(1);
    expect(funding).toMatchObject({ existing: true, hash: bytes32('0f'), logIndex: 9 });
  });
});

describe('error decoding', () => {
  it('classifies every custom error the service contracts and their callees can revert with', () => {
    const names = new Set<string>();
    for (const abi of ['ServiceSubscriptions', 'ConvictionServiceStorage']) {
      for (const entry of loadAbi(abi) as Array<{ type: string; name?: string }>) {
        if (entry.type === 'error') names.add(entry.name!);
      }
    }
    // Nested reverts: the account storage, the NFT's `ownerOf`, PublishingConviction's
    // gate on `coverServiceCost`, and the Hub's lookups.
    for (const name of ['UnknownAccount', 'ERC721NonexistentToken', 'OnlyServiceSubscriptions', 'ContractDoesNotExist']) {
      names.add(name);
    }
    const unclassified = [...names].filter((name) => !Object.hasOwn(CONVICTION_SERVICE_REVERT_KINDS, name));
    expect(unclassified, 'add each new error to CONVICTION_SERVICE_REVERT_KINDS').toEqual([]);
  });

  it('maps each refusal to the kind its caller answers', () => {
    const byKind: Record<string, string[]> = {
      invalid: ['InvalidAssignmentTerms', 'InvalidFundingRequest', 'ConsentMissing', 'InvalidConsentSignature'],
      forbidden: ['NotAccountOwner', 'NotAssigned'],
      'not-found': ['UnknownAccount', 'ERC721NonexistentToken'],
      conflict: ['ServiceSpendingDisabled', 'ServiceSpendingUnchanged', 'InvalidAssignmentNonce', 'AssignmentRevoked',
        'AssignmentExpired', 'CapsUnchanged', 'CapExceeded', 'PeriodAlreadyFunded', 'LabelCapacityExceeded',
        'InsufficientAllowance', 'AccountExpired'],
      unavailable: ['ExactScheduleFromUnset', 'ServiceFundingPausedTreasuryWired'],
      internal: ['DrawMismatch', 'ZeroPeriodStart', 'Panic', 'SomethingNew'],
    };
    for (const [kind, names] of Object.entries(byKind)) {
      for (const name of names) expect(convictionServiceRevertKind(name), name).toBe(kind);
    }
  });

  it('throws a write revert as a typed error with the arguments under their ABI names', async () => {
    const h = harness();
    const cases: Array<[string, unknown[], Record<string, unknown>]> = [
      ['NotAccountOwner', [42n, BUYER], { accountId: 42n, caller: BUYER }],
      ['ExactScheduleFromUnset', [], {}],
      ['ServiceSpendingUnchanged', [42n, true], { accountId: 42n, enabled: true }],
      ['AccountExpired', [42n, 112n], { accountId: 42n, expiresAtEpoch: 112n }],
      ['CapExceeded', ['maxTotalCost', 100n, 150n], { cap: 'maxTotalCost', limit: 100n, attempted: 150n }],
      ['InsufficientAllowance', [42n, 1205n, 3n, 2n], { accountId: 42n, epoch: 1205n, required: 3n, available: 2n }],
      ['ERC721NonexistentToken', [42n], { tokenId: 42n }],
    ];
    for (const [name, args, named] of cases) {
      h.onSend(() => { throw revertError(name, args); });
      const err = await h.adapter.setConvictionServiceSpending(42n, true).catch((e) => e);
      expect(err, name).toBeInstanceOf(ConvictionServiceRevertError);
      expect(err.revertName).toBe(name);
      expect(err.kind).toBe(convictionServiceRevertKind(name));
      expect(err.args).toEqual(named);
      expect(err.message).toContain(name);
      expect(isConvictionServiceRevertError(err)).toBe(true);
      expect(err.cause.code).toBe('CALL_EXCEPTION');
    }
  });

  it('throws a read revert as a typed error, and answers null for an unknown account', async () => {
    const h = harness();
    h.reads.set(`${CSS}:assignmentNonce`, () => { throw revertError('UnauthorizedAccess', ['Only Contracts in Hub']); });
    await expect(h.adapter.getConvictionServiceAssignmentNonce(42n)).rejects.toMatchObject({
      revertName: 'UnauthorizedAccess', kind: 'unavailable',
    });
    withAccount(h);
    expect(await h.adapter.getConvictionServiceStatus(7n)).toBeNull();
    expect(await h.adapter.getConvictionServiceWindowAllowance(7n)).toBeNull();
    await expect(h.adapter.getConvictionServiceLabels(7n, 0, 0)).rejects.toMatchObject({ revertName: 'UnknownAccount', kind: 'not-found' });
  });

  it('answers a Hub without the service contracts as unavailable', async () => {
    const h = harness();
    h.missing.add('ServiceSubscriptions');
    expect(await h.adapter.getConvictionServiceContracts()).toBeNull();
    await expect(h.adapter.getConvictionServiceStatus(42n)).rejects.toBeInstanceOf(ConvictionServiceUnavailableError);
    await expect(h.adapter.setConvictionServiceSpending(42n, true)).rejects.toMatchObject({ code: 'CA_UNAVAILABLE', kind: 'unavailable' });
  });

  it('passes RPC and signer failures through as they are', async () => {
    const h = harness();
    const rpc = Object.assign(new Error('connection refused'), { code: 'SERVER_ERROR' });
    h.onSend(() => { throw rpc; });
    await expect(h.adapter.setConvictionServiceSpending(42n, true)).rejects.toBe(rpc);
    const refused = new RemoteSignerError('REMOTE_SIGNER_REJECTED', 'policy refused the transaction');
    h.onSend(() => { throw refused; });
    await expect(h.adapter.setConvictionServiceSpending(42n, true)).rejects.toBe(refused);
  });
});

describe('reads', () => {
  function withServiceState(h: ReturnType<typeof harness>, cutOver: bigint) {
    withAccount(h);
    h.reads.set(`${PC}:version`, () => '10.1.0');
    h.reads.set(`${CSS}:serviceSpendingEnabledAt`, () => 1_760_400_000n);
    h.reads.set(`${SS}:currentWindowAllowance`, () => [3n, 70_000n * TRAC, 5n * TRAC, false]);
    h.reads.set(`${SS}:emissionSpan`, () => [1201n, 1224n]);
    h.reads.set(`${CSS}:exactScheduleFrom`, () => cutOver);
    h.reads.set(`${CSS}:accountServiceLabelTotal`, () => 3n * TRAC);
    h.reads.set(`${CSS}:labelCursor`, () => 1205n);
    h.reads.set(`${CSS}:assigneeCount`, () => 2n);
    h.reads.set(`${CSS}:assigneeAt`, (_id: bigint, i: number) => [BUYER, OWNER][i]);
    h.reads.set(`${CSS}:isAssignmentActive`, (_id: bigint, who: string) => who === BUYER);
    h.reads.set(`${PARAMS}:protocolTreasury`, () => ethers.ZeroAddress);
    h.reads.set(`${SS}:baseLabelCapacity`, () => 900_000n * TRAC);
  }

  it('reads the status, with currentWindowAllowance as its window', async () => {
    const h = harness();
    withServiceState(h, 1_750_000_000n);
    expect(await h.adapter.getConvictionServiceStatus(42n, { fresh: true })).toEqual({
      accountId: 42n, owner: OWNER, logicVersion: '10.1.0', serviceSpendingEnabledAt: 1_760_400_000,
      discountBps: 7500, lockDurationEpochs: 12, expiresAtTimestamp: 1_761_036_800,
      window: { index: 3, baseAllowance: 100_000n * TRAC, baseRemaining: 70_000n * TRAC, topUpBuffer: 5n * TRAC, expired: false },
      schedule: { exact: true, firstEpoch: 1201, lastEpoch: 1224 },
      labels: { total: 3n * TRAC, cursor: 1205, remainingBaseCapacity: 900_000n * TRAC },
      assignments: { count: 2, active: 1 },
      treasuryWired: false,
    });
  });

  it('reads the status before the schedule cut-over is set, without the views that need it', async () => {
    const h = harness();
    withServiceState(h, 0n);
    const status = (await h.adapter.getConvictionServiceStatus(42n))!;
    expect(status.schedule.exact).toBe(false);
    expect(status.labels.remainingBaseCapacity).toBe(0n);
    expect(h.readLog).not.toContain(`${SS}:baseLabelCapacity`);
  });

  it('reads labels per epoch, the pool from EpochStorage shard 1, and no schedule before the cut-over', async () => {
    const h = harness();
    withAccount(h);
    h.reads.set(`${CSS}:exactScheduleFrom`, () => 0n);
    h.reads.set(`${CSS}:accountLabel`, (_id: bigint, e: number) => [BigInt(e), 1n]);
    h.reads.set(`${CSS}:serviceLabel`, (e: number) => BigInt(e) + 1n);
    const shards: unknown[] = [];
    h.reads.set(`${EPOCHS}:getEpochPool`, (shard: number, e: number) => { shards.push(shard); return BigInt(e) * 10n; });
    expect(await h.adapter.getConvictionServiceLabels(42n, 1203, 1204)).toEqual([
      { epoch: 1203, scheduled: 0n, baseLabel: 1203n, topUpLabel: 1n, serviceLabel: 1204n, pool: 12030n },
      { epoch: 1204, scheduled: 0n, baseLabel: 1204n, topUpLabel: 1n, serviceLabel: 1205n, pool: 12040n },
    ]);
    expect(shards).toEqual([1, 1]);
    expect(h.readLog).not.toContain(`${SS}:scheduledEmission`);
  });

  it('lists assignments and periods from the storage enumeration', async () => {
    const h = harness();
    h.reads.set(`${CSS}:assigneeCount`, () => 1n);
    h.reads.set(`${CSS}:assigneeAt`, () => BUYER);
    h.reads.set(`${CSS}:getAssignment`, () => [25n, 25n, 0n, 100n, 1000n, 2_678_400n, 1_760_000_100n, 1_795_996_800n, 0n, 3n]);
    h.reads.set(`${CSS}:getUsage`, () => [3n, 3n, 3n, 1n]);
    h.reads.set(`${CSS}:isAssignmentActive`, () => true);
    expect(await h.adapter.listConvictionServiceAssignments(42n)).toEqual([{
      assignee: BUYER, maxCostPerPeriod: 25n, maxInferenceCostPerPeriod: 25n, maxQueryCostPerPeriod: 0n,
      maxCostPerWindow: 100n, maxTotalCost: 1000n, maxPeriodSeconds: 2_678_400, assignedAt: 1_760_000_100,
      expiresAt: 1_795_996_800, revokedAt: 0, nonce: 3n, active: true,
      usage: { totalCost: 3n, windowCost: 3n, window: 3, periods: 1 },
    }]);

    const id = serviceSubscriptionIdOf(BUYER, REQUEST.periodId);
    h.reads.set(`${CSS}:accountSubscriptionCount`, () => 3n);
    h.reads.set(`${CSS}:accountSubscriptionAt`, () => id);
    h.reads.set(`${CSS}:getSubscription`, () => [42n, BUYER, ethers.ZeroAddress, REQUEST.periodId, REQUEST.planDigest,
      1_760_400_200n, 1_762_992_200n, 1205n, 3n, 7500n, 2n, 12n * TRAC, 3n * TRAC, 3n * TRAC, 0n]);
    h.reads.set(`${CSS}:getBuckets`, () => BUCKET_TUPLES);
    const page = await h.adapter.listServicePeriods(42n, 2, 50);
    expect(page.total).toBe(3);
    expect(page.periods.map((p) => [p.subscriptionId, p.cost, p.buckets])).toEqual([[id, 3n * TRAC, REQUEST.buckets]]);
    h.reads.set(`${CSS}:getSubscription`, () => Array.from({ length: 15 }, () => 0n));
    expect(await h.adapter.getServicePeriod(bytes32('99'))).toBeNull();
  });
});
