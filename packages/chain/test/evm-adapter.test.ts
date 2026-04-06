import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { JsonRpcProvider } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import path from 'node:path';

const EVM_MODULE_DIR = path.resolve(import.meta.dirname, '../../evm-module');
const RPC_URL = 'http://127.0.0.1:8545';
const HARDHAT_CHAIN_ID = 31337;

const DEPLOYER_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

let hardhatProcess: ChildProcess | null = null;
let hubAddress: string;
let skipSuite = false;

/** Returns true if node is ready, false if timeout (so caller can skip the suite). */
async function waitForNode(url: string, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const provider = new JsonRpcProvider(url);
      await provider.getBlockNumber();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

async function deployContracts(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['hardhat', 'deploy', '--network', 'localhost', '--config', 'hardhat.node.config.ts'], {
      cwd: EVM_MODULE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RPC_LOCALHOST: RPC_URL },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Deploy failed (code ${code}):\n${stderr}\n${stdout}`));
        return;
      }

      const hubMatch = stdout.match(/deploying "Hub".*?deployed at (\S+)/s);
      if (hubMatch) {
        resolve(hubMatch[1]);
      } else {
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.includes('"Hub"') && line.includes('deployed at')) {
            const match = line.match(/deployed at (0x[0-9a-fA-F]+)/);
            if (match) {
              resolve(match[1]);
              return;
            }
          }
        }
        reject(new Error(`Could not find Hub address in deploy output:\n${stdout}`));
      }
    });
  });
}

function makeConfig(): EVMAdapterConfig {
  return {
    rpcUrl: RPC_URL,
    privateKey: DEPLOYER_PRIVATE_KEY,
    hubAddress,
    chainId: `evm:${HARDHAT_CHAIN_ID}`,
  };
}

describe('EVMChainAdapter integration', () => {
  beforeAll(async () => {
    hardhatProcess = spawn('npx', ['hardhat', 'node', '--config', 'hardhat.node.config.ts'], {
      cwd: EVM_MODULE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const ready = await waitForNode(RPC_URL, 15_000);
    if (!ready) {
      skipSuite = true;
      if (hardhatProcess) {
        hardhatProcess.kill('SIGTERM');
        hardhatProcess = null;
      }
      return;
    }
    hubAddress = await deployContracts();
  }, 60_000);

  afterAll(() => {
    if (hardhatProcess) {
      hardhatProcess.kill('SIGTERM');
      hardhatProcess = null;
    }
  });

  it('should connect and resolve V8 contracts from Hub', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const adapter = new EVMChainAdapter(makeConfig());

    expect(adapter.chainType).toBe('evm');
    expect(adapter.chainId).toBe(`evm:${HARDHAT_CHAIN_ID}`);

    const kc = await adapter.getContract('KnowledgeCollection');
    expect(kc).toBeDefined();
    expect(await kc.name()).toBe('KnowledgeCollection');

    const staking = await adapter.getContract('Staking');
    expect(staking).toBeDefined();
    expect(await staking.name()).toBe('Staking');
  }, 30_000);

  it('should have correct signer address', (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const adapter = new EVMChainAdapter(makeConfig());
    const address = adapter.getSignerAddress();
    expect(address.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  });

  it('getBlockNumber reads from the live Hardhat node (no contract init required)', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const adapter = new EVMChainAdapter(makeConfig());
    const bn = await adapter.getBlockNumber();
    expect(typeof bn).toBe('number');
    expect(bn).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it('verifyPublisherOwnsRange resolves KnowledgeAssetsStorage after init', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const adapter = new EVMChainAdapter(makeConfig());
    const initSpy = vi.spyOn(adapter, 'init');
    const deployer = adapter.getSignerAddress();
    const owns = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n);
    // init() must be called to resolve KnowledgeAssetsStorage
    expect(initSpy).toHaveBeenCalled();
    // Fresh Hardhat node has no published ranges, so result should be false
    expect(owns).toBe(false);
  }, 30_000);
});
