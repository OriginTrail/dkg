/**
 * Shared Hardhat test harness for EVM integration tests.
 *
 * Spawns a Hardhat node, deploys all contracts, creates node profiles,
 * and provides helpers for staking, token minting, and signing.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { ethers, JsonRpcProvider, Wallet, Contract } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import path from 'node:path';

const require = createRequire(import.meta.url);

export const EVM_MODULE_DIR = path.resolve(import.meta.dirname, '../../evm-module');
export const HARDHAT_CHAIN_ID = 31337;

// Hardhat deterministic accounts (accounts[0..19])
export const HARDHAT_KEYS = {
  DEPLOYER:    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // [0]
  CORE_OP:     '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // [1]
  CORE_ADMIN:  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // [2]
  REC1_OP:     '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // [3]
  REC1_ADMIN:  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // [4]
  REC2_OP:     '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', // [5]
  REC2_ADMIN:  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', // [6]
  REC3_OP:     '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356', // [7]
  REC3_ADMIN:  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97', // [8]
  PUBLISHER:   '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', // [9]
  PUBLISHER2:  '0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897', // [10]
  EXTRA1:      '0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82', // [11]
  EXTRA2:      '0xa267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1', // [12]
  EXTRA3:      '0x47c99abed3324a2707c28affff1267e45918ec8c3f20b8aa892e8b065d2942dd', // [13]
} as const;

export interface HardhatContext {
  process: ChildProcess;
  provider: JsonRpcProvider;
  hubAddress: string;
  rpcUrl: string;
  coreProfileId: number;
  receiverIds: number[];
}

export async function waitForNode(url: string, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      if (res.ok) return true;
    } catch {
      // node not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function deployContracts(rpcUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hardhatCli = require.resolve('hardhat/internal/cli/bootstrap', {
      paths: [EVM_MODULE_DIR],
    });
    const proc = spawn(
      process.execPath,
      [hardhatCli, 'deploy', '--network', 'localhost', '--config', 'hardhat.node.config.ts'],
      {
        cwd: EVM_MODULE_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RPC_LOCALHOST: rpcUrl },
      },
    );

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code, signal) => {
      // Parse Hub address from stdout even if the process was killed
      // (e.g. OOM after deploy completed but during GC cleanup)
      const hubMatch = stdout.match(/deploying "Hub".*?deployed at (\S+)/s);
      if (hubMatch) {
        resolve(hubMatch[1]);
        return;
      }

      if (code !== 0) {
        reject(new Error(`Deploy failed (code ${code}, signal ${signal}):\n${stderr}\n${stdout}`));
        return;
      }

      reject(new Error(`Hub address not found in deploy output:\n${stdout}`));
    });
  });
}

export function makeAdapterConfig(
  rpcUrl: string,
  hubAddress: string,
  privateKey: string,
  additionalKeys?: string[],
): EVMAdapterConfig {
  return {
    rpcUrl,
    privateKey,
    hubAddress,
    chainId: `evm:${HARDHAT_CHAIN_ID}`,
    additionalKeys,
  };
}

export async function createNodeProfile(
  provider: JsonRpcProvider,
  hubAddress: string,
  operationalKey: string,
  adminKey: string,
  name: string,
): Promise<number> {
  const operational = new Wallet(operationalKey, provider);
  const admin = new Wallet(adminKey, provider);
  const hub = new Contract(
    hubAddress,
    ['function getContractAddress(string) view returns (address)'],
    provider,
  );
  const profileAddr = await hub.getContractAddress('Profile');
  const profile = new Contract(
    profileAddr,
    ['function createProfile(address, address[], string, bytes, uint16) external'],
    operational,
  );

  const nodeId = ethers.hexlify(ethers.randomBytes(32));
  const tx = await profile.createProfile(admin.address, [], name, nodeId, 0);
  const receipt = await tx.wait();

  const iface = new ethers.Interface(['event IdentityCreated(uint72 indexed identityId, bytes32 indexed operationalKey, bytes32 indexed adminKey)']);
  const parsed = receipt.logs
    .map((log: any) => { try { return iface.parseLog({ topics: log.topics, data: log.data }); } catch { return null; } })
    .find((e: any) => e?.name === 'IdentityCreated');
  if (!parsed) throw new Error(`No IdentityCreated event for ${name}`);
  return Number(parsed.args.identityId);
}

export async function mintTokens(
  provider: JsonRpcProvider,
  hubAddress: string,
  deployerKey: string,
  recipientAddress: string,
  amount: bigint,
): Promise<void> {
  const deployer = new Wallet(deployerKey, provider);
  const hub = new Contract(
    hubAddress,
    ['function getContractAddress(string) view returns (address)'],
    provider,
  );
  const tokenAddr = await hub.getContractAddress('Token');
  const token = new Contract(
    tokenAddr,
    ['function mint(address, uint256)'],
    deployer,
  );
  await (await token.mint(recipientAddress, amount)).wait();
}

export async function stakeAndSetAsk(
  provider: JsonRpcProvider,
  hubAddress: string,
  deployerKey: string,
  operationalKey: string,
  identityId: number,
  stakeAmount = ethers.parseEther('50000'),
  ask = ethers.parseEther('1'),
): Promise<void> {
  const deployer = new Wallet(deployerKey, provider);
  const operational = new Wallet(operationalKey, provider);
  const hub = new Contract(
    hubAddress,
    ['function getContractAddress(string) view returns (address)'],
    provider,
  );

  const tokenAddr = await hub.getContractAddress('Token');
  const stakingAddr = await hub.getContractAddress('Staking');
  const profileAddr = await hub.getContractAddress('Profile');

  const token = new Contract(
    tokenAddr,
    ['function mint(address, uint256)', 'function approve(address, uint256) returns (bool)'],
    deployer,
  );
  const staking = new Contract(
    stakingAddr,
    ['function stake(uint72 identityId, uint96 amount)'],
    operational,
  );
  const profile = new Contract(
    profileAddr,
    ['function updateAsk(uint72 identityId, uint96 ask)'],
    operational,
  );

  await (await token.mint(operational.address, stakeAmount)).wait();
  await (await token.connect(operational).approve(stakingAddr, stakeAmount)).wait();
  await (await staking.stake(identityId, stakeAmount)).wait();
  await (await profile.updateAsk(identityId, ask)).wait();
}

export async function signMerkleRoot(
  signer: Wallet,
  identityId: number,
  merkleRoot: string,
): Promise<{ r: Uint8Array; vs: Uint8Array }> {
  const msgHash = ethers.solidityPackedKeccak256(
    ['uint72', 'bytes32'],
    [identityId, merkleRoot],
  );
  const rawSig = await signer.signMessage(ethers.getBytes(msgHash));
  const sig = ethers.Signature.from(rawSig);
  return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
}

export async function signReceiverMerkleRootAndByteSize(
  signer: Wallet,
  merkleRoot: string,
  publicByteSize: number | bigint,
): Promise<{ r: Uint8Array; vs: Uint8Array }> {
  const msgHash = ethers.solidityPackedKeccak256(
    ['bytes32', 'uint64'],
    [merkleRoot, BigInt(publicByteSize)],
  );
  const rawSig = await signer.signMessage(ethers.getBytes(msgHash));
  const sig = ethers.Signature.from(rawSig);
  return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
}

export async function getIdentityIdByAddress(
  provider: JsonRpcProvider,
  hubAddress: string,
  operationalAddress: string,
): Promise<number> {
  const hub = new Contract(
    hubAddress,
    ['function getContractAddress(string) view returns (address)'],
    provider,
  );
  const idStorageAddr = await hub.getContractAddress('IdentityStorage');
  const idStorage = new Contract(
    idStorageAddr,
    ['function getIdentityId(address) view returns (uint72)'],
    provider,
  );
  return Number(await idStorage.getIdentityId(operationalAddress));
}

export async function setMinimumRequiredSignatures(
  provider: JsonRpcProvider,
  hubAddress: string,
  deployerKey: string,
  value: number,
): Promise<void> {
  const deployer = new Wallet(deployerKey, provider);
  const hub = new Contract(
    hubAddress,
    ['function getContractAddress(string) view returns (address)'],
    provider,
  );
  const psAddr = await hub.getContractAddress('ParametersStorage');
  const ps = new Contract(
    psAddr,
    ['function setMinimumRequiredSignatures(uint256) external'],
    deployer,
  );
  await (await ps.setMinimumRequiredSignatures(value)).wait();
}

/**
 * Spin up a complete Hardhat environment with deployed contracts and
 * profiles for one core node and three receiver nodes (staked + ask set).
 *
 * @param port   Hardhat JSON-RPC port (use different ports per concurrent test file)
 * @returns      Context with process handle, provider, hub address, and identity IDs
 */
export async function spawnHardhatEnv(port: number): Promise<HardhatContext> {
  const rpcUrl = `http://127.0.0.1:${port}`;

  // Kill any orphaned process left on this port from a previous crashed run
  try {
    const { execSync } = await import('node:child_process');
    const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (pids) {
      for (const pid of pids.split('\n')) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch {}
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch {}

  let stderrOutput = '';
  let stdoutOutput = '';
  let processExitCode: number | null = null;

  const hardhatCli = require.resolve('hardhat/internal/cli/bootstrap', {
    paths: [EVM_MODULE_DIR],
  });
  const hardhatProcess = spawn(
    process.execPath,
    ['--max-old-space-size=2048', hardhatCli, 'node', '--no-deploy', '--port', String(port), '--config', 'hardhat.node.config.ts'],
    {
      cwd: EVM_MODULE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  );
  hardhatProcess.stdout?.on('data', (d) => { stdoutOutput += d.toString(); });
  hardhatProcess.stderr?.on('data', (d) => { stderrOutput += d.toString(); });
  hardhatProcess.on('exit', (code) => { processExitCode = code; });
  hardhatProcess.on('error', (err) => { stderrOutput += `\nspawn error: ${err.message}`; });

  const startupTimeout = process.env.CI ? 120_000 : 60_000;
  const ready = await waitForNode(rpcUrl, startupTimeout);
  if (!ready) {
    hardhatProcess.kill('SIGTERM');
    throw new Error(
      `Hardhat node failed to start on port ${port} within ${startupTimeout / 1000}s.\n` +
      `hardhatCli: ${hardhatCli}\n` +
      `exitCode: ${processExitCode}\n` +
      `stderr: ${stderrOutput}\nstdout: ${stdoutOutput}`,
    );
  }

  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const hubAddress = await deployContracts(rpcUrl);

  const coreProfileId = await createNodeProfile(
    provider, hubAddress,
    HARDHAT_KEYS.CORE_OP, HARDHAT_KEYS.CORE_ADMIN,
    'CoreNode1',
  );

  const rec1Id = await createNodeProfile(provider, hubAddress, HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC1_ADMIN, 'Receiver1');
  const rec2Id = await createNodeProfile(provider, hubAddress, HARDHAT_KEYS.REC2_OP, HARDHAT_KEYS.REC2_ADMIN, 'Receiver2');
  const rec3Id = await createNodeProfile(provider, hubAddress, HARDHAT_KEYS.REC3_OP, HARDHAT_KEYS.REC3_ADMIN, 'Receiver3');

  await stakeAndSetAsk(
    provider, hubAddress,
    HARDHAT_KEYS.DEPLOYER, HARDHAT_KEYS.CORE_OP,
    coreProfileId,
  );

  // Lower minimumRequiredSignatures to 1 so single-node self-signed ACK works.
  await setMinimumRequiredSignatures(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, 1);

  return {
    process: hardhatProcess,
    provider,
    hubAddress,
    rpcUrl,
    coreProfileId,
    receiverIds: [rec1Id, rec2Id, rec3Id],
  };
}

export function killHardhat(ctx: HardhatContext | null): void {
  if (ctx?.process) {
    ctx.process.kill('SIGKILL');
  }
}

/**
 * Build receiver signature array for publishKnowledgeAssets / publishToContextGraph.
 */
export async function buildReceiverSignatures(
  provider: JsonRpcProvider,
  hubAddress: string,
  merkleRoot: string,
  publicByteSize: bigint,
  receiverOpKeys: string[] = [HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC2_OP, HARDHAT_KEYS.REC3_OP],
): Promise<Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>> {
  const sigs: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }> = [];
  for (const key of receiverOpKeys) {
    const wallet = new Wallet(key, provider);
    const identityId = await getIdentityIdByAddress(provider, hubAddress, wallet.address);
    const sig = await signReceiverMerkleRootAndByteSize(wallet, merkleRoot, publicByteSize);
    sigs.push({ identityId: BigInt(identityId), ...sig });
  }
  return sigs;
}
