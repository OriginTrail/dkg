/**
 * CLI commands on a node that signs through an external signer (`chain.signer`
 * of type "remote"): `dkg wallet` lists the signer's payer and author accounts
 * without reading or creating wallets.json, `dkg set-ask` refuses (it needs a
 * local key), and the OpenClaw and Hermes setups create no wallets.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import type { Command as CommandType } from 'commander';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  loadNetworkConfig: vi.fn(),
  loadOpWallets: vi.fn(),
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { ...actual, loadConfig: mocks.loadConfig, loadNetworkConfig: mocks.loadNetworkConfig };
});

vi.mock('@origintrail-official/dkg-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-agent')>();
  return { ...actual, loadOpWallets: mocks.loadOpWallets };
});

const { Command } = await import('commander');
const { registerNodeOpsCommands } = await import('../src/commands/node-ops.js');
const { openclawSetupAction } = await import('../src/openclaw-setup.js');
const { hermesSetupAction } = await import('../src/hermes-setup.js');

const PAYER_TOKEN = 'cli-payer-credential-4d3c2b1a0f9e';
const AUTHOR_TOKEN = 'cli-author-credential-9e0f1a2b3c4d';
const payers = [new ethers.Wallet(HARDHAT_KEYS.PUBLISHER), new ethers.Wallet(HARDHAT_KEYS.PUBLISHER2)];
const author = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);

let fake: FakeSigner;
let home: string;
let logs: string[];
let errors: string[];

function remoteSignerConfig() {
  return {
    chain: {
      type: 'evm',
      chainId: 'evm:31337',
      signer: {
        type: 'remote',
        url: fake.url,
        authTokenEnv: 'DKG_TEST_SIGNER_TOKEN',
        author: { authTokenEnv: 'DKG_TEST_SIGNER_AUTHOR_TOKEN' },
      },
    },
  };
}

function commands(): CommandType {
  const program = new Command();
  program.exitOverride();
  registerNodeOpsCommands(program);
  return program;
}

const setupCommand = { getOptionValueSource: () => undefined } as Pick<CommandType, 'getOptionValueSource'>;

describe('CLI commands with an external signer', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    fake = await startFakeRemoteSigner({
      credentials: [
        { token: PAYER_TOKEN, keys: payers.map((payer) => payer.privateKey) },
        { token: AUTHOR_TOKEN, keys: [author.privateKey] },
      ],
    });
    home = await mkdtemp(join(tmpdir(), 'dkg-cli-signer-'));
    await writeFile(join(home, 'config.json'), JSON.stringify(remoteSignerConfig()));
    vi.stubEnv('DKG_TEST_SIGNER_TOKEN', PAYER_TOKEN);
    vi.stubEnv('DKG_TEST_SIGNER_AUTHOR_TOKEN', AUTHOR_TOKEN);
    mocks.loadConfig.mockResolvedValue(remoteSignerConfig());
    mocks.loadNetworkConfig.mockResolvedValue(null);
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fake.close();
    await rm(home, { recursive: true, force: true });
  });

  it('dkg wallet lists the payer and author accounts of the signer, not wallets.json', async () => {
    await commands().parseAsync(['wallet'], { from: 'user' });

    const output = logs.join('\n');
    expect(output).toContain('(none: the node holds no admin key; perform admin-key operations outside the node)');
    expect(output).toContain('Payer wallets (external signer) (2):');
    expect(output).toContain(`(primary) ${payers[0].address}`);
    expect(output).toContain(`(pool #2) ${payers[1].address}`);
    expect(output).toContain('Author keys (external signer; own published assets, never pay):');
    expect(output).toContain(`(default) ${author.address}`);
    expect(output).toContain(`Signer: ${fake.url}`);
    expect(output).not.toContain('wallets.json');
    expect(errors).toEqual([]);
    expect(mocks.loadOpWallets).not.toHaveBeenCalled();
  });

  it('dkg set-ask refuses, since it needs a local operational key', async () => {
    await expect(commands().parseAsync(['set-ask', '2'], { from: 'user' })).rejects.toThrow(/process\.exit\(1\)/);
    expect(process.exit).toHaveBeenNthCalledWith(1, 1);
    expect(errors[0]).toMatch(/dkg set-ask signs with a local operational key/);
    expect(fake.requests).toHaveLength(0);
  });

  it('the OpenClaw and Hermes setups create no wallets.json', async () => {
    const loaded: unknown[] = [];
    const runSetup = async (_opts: unknown, deps: { loadOpWallets: (dir: string) => Promise<unknown> }) => {
      loaded.push(await deps.loadOpWallets(home));
    };
    await openclawSetupAction({}, setupCommand, { runSetup: runSetup as never });
    await hermesSetupAction({}, setupCommand, { runSetup: runSetup as never });
    expect(loaded).toEqual([undefined, undefined]);
    expect(existsSync(join(home, 'wallets.json'))).toBe(false);
    expect(mocks.loadOpWallets).not.toHaveBeenCalled();
  });
});
