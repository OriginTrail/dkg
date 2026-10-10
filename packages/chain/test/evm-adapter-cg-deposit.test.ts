import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers, Wallet, Contract, type JsonRpcProvider } from 'ethers';
import {
  getSharedContext,
  createProvider,
  createEVMAdapter,
  takeSnapshot,
  revertSnapshot,
} from './evm-test-context.js';
import { HARDHAT_KEYS, mintTokens } from './hardhat-harness.js';

/**
 * OT-RFC-53 — EVMChainAdapter.createOnChainContextGraph deposit auto-approval.
 *
 * Validates the client-side path users rely on to create a CG when the on-chain
 * registration deposit is active: the adapter reads
 * `ParametersStorage.contextGraphRegistrationDeposit()` and approves it to the
 * ContextGraphs facade before submitting `createContextGraph`. Without that
 * approval the facade's `transferFrom` reverts `TooLowAllowance`, so a successful
 * create + a recorded escrow proves the approval branch ran. Also covers the
 * dormant (deposit == 0) no-op path.
 */
describe('EVMChainAdapter — OT-RFC-53 CG registration deposit approval', () => {
  let provider: JsonRpcProvider;
  let hubAddress: string;
  let baseSnapshot: string;
  const DEPOSIT = ethers.parseEther('100');

  beforeAll(async () => {
    const ctx = getSharedContext();
    hubAddress = ctx.hubAddress;
    provider = createProvider();
    // File-level isolation: this suite flips the global deposit param, so
    // snapshot once up front and restore after to keep other files unaffected.
    baseSnapshot = await takeSnapshot();
  });

  afterAll(async () => {
    await revertSnapshot(baseSnapshot);
  });

  const hub = () =>
    new Contract(
      hubAddress,
      [
        'function getContractAddress(string) view returns (address)',
        'function getAssetStorageAddress(string) view returns (address)',
      ],
      provider,
    );

  // ParametersStorage setter is onlyOwnerOrMultiSigOwner; DEPLOYER is the owner.
  const setDeposit = async (amount: bigint): Promise<void> => {
    const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, provider);
    const psAddr = await hub().getContractAddress('ParametersStorage');
    const ps = new Contract(
      psAddr,
      ['function setContextGraphRegistrationDeposit(uint96) external'],
      deployer,
    );
    await (await ps.setContextGraphRegistrationDeposit(amount)).wait();
  };

  const getEscrow = async (cgId: bigint): Promise<bigint> => {
    const cgsAddr = await hub().getAssetStorageAddress('ContextGraphStorage');
    const cgs = new Contract(
      cgsAddr,
      ['function getRegistrationEscrow(uint256) view returns (uint96)'],
      provider,
    );
    return cgs.getRegistrationEscrow(cgId);
  };

  // Count CORE_OP→ContextGraphs TRAC approvals since `fromBlock` — proves whether the
  // adapter's deposit-approval branch ran (0 = dormant no-op; >=1 = approved + retried).
  const approvalCount = async (owner: string, fromBlock: number): Promise<number> => {
    const tokenAddr = await hub().getContractAddress('Token');
    const cgAddr = await hub().getContractAddress('ContextGraphs');
    const token = new Contract(
      tokenAddr,
      ['event Approval(address indexed owner, address indexed spender, uint256 value)'],
      provider,
    );
    const logs = await token.queryFilter(token.filters.Approval(owner, cgAddr), fromBlock, 'latest');
    return logs.length;
  };

  it('approves + pays the deposit when active, recording the CG escrow', async () => {
    await setDeposit(DEPOSIT);
    const coreOp = new Wallet(HARDHAT_KEYS.CORE_OP, provider);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, DEPOSIT);

    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const fromBlock = await provider.getBlockNumber();
    const result = await adapter.createOnChainContextGraph({
      accessPolicy: 0, // public
      publishPolicy: 1, // open
    });

    // Success proves the adapter approved the deposit — otherwise the facade's
    // transferFrom would have reverted TooLowAllowance.
    expect(result.success).toBe(true);
    expect(result.contextGraphId > 0n).toBe(true);
    expect(await getEscrow(result.contextGraphId)).toBe(DEPOSIT);
    // ...and the approval branch actually ran: a CORE_OP→ContextGraphs approval is
    // present (>=1), proving the TooLowAllowance recovery + retry fired (not that the
    // create just happened to have a pre-existing allowance).
    expect(await approvalCount(coreOp.address, fromBlock + 1)).toBeGreaterThan(0);
  });

  it('is a no-op when the deposit is 0 (dormant): creates the CG with no approval/escrow', async () => {
    await setDeposit(0n);

    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const coreOpAddress = new Wallet(HARDHAT_KEYS.CORE_OP).address;
    const fromBlock = await provider.getBlockNumber();
    const result = await adapter.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    });

    expect(result.success).toBe(true);
    expect(await getEscrow(result.contextGraphId)).toBe(0n);
    // PROVE the dormant path approved nothing — a regression that always approved
    // (or called ensureV10ApproveTrac(..., 0n)) would still pass the assertions above
    // but leave a stray CORE_OP→ContextGraphs approval, which this catches.
    expect(await approvalCount(coreOpAddress, fromBlock + 1)).toBe(0);
  });

  // ContextGraphs 10.0.5: an open graph registered by a PCA agent is waived
  // against the agent's PCA, so a wallet with gas but no TRAC can register it
  // through the unchanged adapter in a single transaction.
  it('registers an open CG for a PCA agent with no TRAC: one tx, no approval, no escrow', async () => {
    await setDeposit(DEPOSIT);
    const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, provider);
    const fundGas = async (to: string) =>
      (await deployer.sendTransaction({ to, value: ethers.parseEther('1') })).wait();

    // An eligible PCA: at least the waiver floor, owned by a fresh wallet.
    const pcaOwner = Wallet.createRandom().connect(provider);
    await fundGas(pcaOwner.address);
    const psAddr = await hub().getContractAddress('ParametersStorage');
    const floor: bigint = await new Contract(
      psAddr,
      ['function minPcaCommitmentForCgWaiver() view returns (uint96)'],
      provider,
    ).minPcaCommitmentForCgWaiver();
    const commit = floor > ethers.parseEther('50000') ? floor : ethers.parseEther('50000');
    const nftAddr = await hub().getContractAddress('DKGPublishingConvictionNFT');
    const tokenAddr = await hub().getContractAddress('Token');
    const token = new Contract(
      tokenAddr,
      [
        'function approve(address, uint256) returns (bool)',
        'function balanceOf(address) view returns (uint256)',
      ],
      pcaOwner,
    );
    const nft = new Contract(
      nftAddr,
      [
        'function createAccount(uint96 committedTRAC, uint72 primaryNode) returns (uint256)',
        'function registerAgent(uint256 accountId, address agent)',
        'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
      ],
      pcaOwner,
    );
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, pcaOwner.address, commit);
    await (await token.approve(nftAddr, commit)).wait();
    await (await nft.createAccount(commit, 0)).wait();
    const accountId: bigint = await nft.tokenOfOwnerByIndex(pcaOwner.address, 0);

    // The signer: gas money only, registered as the PCA's agent.
    const agent = Wallet.createRandom().connect(provider);
    await fundGas(agent.address);
    await (await nft.registerAgent(accountId, agent.address)).wait();
    expect(await token.balanceOf(agent.address)).toBe(0n);

    const adapter = createEVMAdapter(agent.privateKey);
    const fromBlock = await provider.getBlockNumber();
    const result = await adapter.createOnChainContextGraph({
      accessPolicy: 0, // public
      publishPolicy: 1, // open
    });

    expect(result.success).toBe(true);
    expect(await getEscrow(result.contextGraphId)).toBe(0n);
    expect(await token.balanceOf(agent.address)).toBe(0n);
    // One transaction from the agent: no approval, no retry.
    expect(await provider.getTransactionCount(agent.address)).toBe(1);
    expect(await approvalCount(agent.address, fromBlock + 1)).toBe(0);
    const waiver = new Contract(
      await hub().getContractAddress('ContextGraphWaiverStorage'),
      ['function waivedCgCount(uint256) view returns (uint256)'],
      provider,
    );
    expect(await waiver.waivedCgCount(accountId)).toBe(1n);
  });
});
