/**
 * How the daemon signs EVM transactions. Without `chain.signer` it keeps the
 * operational keys in wallets.json (unchanged behaviour). With an external
 * signer it learns the payer and author accounts from the signer, creates and
 * loads no key file, and refuses configurations it cannot serve before any key
 * would exist.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { resolveDaemonEvmSigning } from '../src/daemon/evm-signing.js';
import { loadLocalOpWalletsUnlessExternal, usesExternalSigner } from '../src/local-op-wallets.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';

const TOKEN = 'daemon-payer-credential-6a5b4c3d2e1f';
const AUTHOR_TOKEN = 'daemon-author-credential-f1e2d3c4b5a6';
const payers = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
const author = ethers.Wallet.createRandom();

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-signing-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeSigner(): Promise<FakeSigner> {
  const fake = await startFakeRemoteSigner({
    credentials: [
      { token: TOKEN, keys: payers.map((payer) => payer.privateKey) },
      { token: AUTHOR_TOKEN, keys: [author.privateKey] },
    ],
  });
  cleanups.push(() => fake.close());
  return fake;
}

async function tokenFiles(dir: string): Promise<{ payer: string; author: string }> {
  const payer = join(dir, 'signer.token');
  const authorFile = join(dir, 'author.token');
  await writeFile(payer, `${TOKEN}\n`);
  await writeFile(authorFile, `${AUTHOR_TOKEN}\n`);
  await chmod(payer, 0o600);
  await chmod(authorFile, 0o600);
  return { payer, author: authorFile };
}

describe('daemon EVM signing', () => {
  it('keeps the local wallets.json behaviour when no signer is configured', async () => {
    const dir = await tempDir();
    const signing = await resolveDaemonEvmSigning({ config: { nodeRole: 'edge' }, chainType: 'evm', dataDir: dir, log: () => {} });
    expect(signing.mode).toBe('local');
    expect(existsSync(join(dir, 'wallets.json'))).toBe(true);
    if (signing.mode !== 'local') return;
    expect(signing.chainSigning.operationalKeys).toHaveLength(3);
    expect(signing.addresses.wallets.map((w) => w.address)).toEqual(
      signing.chainSigning.operationalKeys.map((key) => new ethers.Wallet(key).address),
    );
    // The route-facing view carries addresses only.
    expect(JSON.stringify(signing.addresses)).not.toContain(signing.chainSigning.operationalKeys[0].slice(2));
  });

  it('learns payers and authors from the external signer and creates no key file', async () => {
    const dir = await tempDir();
    const fake = await fakeSigner();
    const tokens = await tokenFiles(dir);
    const lines: string[] = [];
    const signing = await resolveDaemonEvmSigning({
      config: {
        nodeRole: 'edge',
        chain: { signer: { type: 'remote', url: fake.url, authTokenFile: tokens.payer, author: { authTokenFile: tokens.author } } },
      },
      chainType: 'evm',
      dataDir: dir,
      log: (line) => lines.push(line),
    });
    expect(signing.mode).toBe('remote');
    expect(existsSync(join(dir, 'wallets.json'))).toBe(false);
    expect(existsSync(join(dir, 'wallets.key'))).toBe(false);
    if (signing.mode !== 'remote') return;
    expect(signing.addresses).toEqual({ wallets: payers.map((payer) => ({ address: payer.address })) });
    expect(signing.chainSigning.signers.map((signer) => signer.address)).toEqual(payers.map((payer) => payer.address));
    expect(signing.chainSigning.authors?.defaultAuthor?.address).toBe(author.address);
    const log = lines.join('\n');
    expect(log).toContain('external signer');
    expect(log).toContain(payers[0].address);
    expect(log).toContain(author.address);
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(AUTHOR_TOKEN);
  });

  it('runs with payers only when no author keys are configured', async () => {
    const dir = await tempDir();
    const fake = await fakeSigner();
    const tokens = await tokenFiles(dir);
    const lines: string[] = [];
    const signing = await resolveDaemonEvmSigning({
      config: { nodeRole: 'edge', chain: { signer: { type: 'remote', url: fake.url, authTokenFile: tokens.payer } } },
      chainType: 'evm',
      dataDir: dir,
      log: (line) => lines.push(line),
    });
    expect(signing.mode).toBe('remote');
    if (signing.mode !== 'remote') return;
    expect(signing.chainSigning.authors).toBeUndefined();
    expect(lines.join('\n')).toContain('Author keys: none configured');
  });

  it('refuses core nodes, the mock chain and the async publisher runtime before any key exists', async () => {
    const dir = await tempDir();
    const signer = { type: 'remote' as const, socketPath: join(dir, 'unused.sock') };
    await expect(resolveDaemonEvmSigning({
      config: { nodeRole: 'core', chain: { signer } }, chainType: 'evm', dataDir: dir, log: () => {},
    })).rejects.toThrow(/edge nodes only/);
    await expect(resolveDaemonEvmSigning({
      config: { nodeRole: 'edge', chain: { signer } }, chainType: 'mock', dataDir: dir, log: () => {},
    })).rejects.toThrow(/requires an EVM chain/);
    await expect(resolveDaemonEvmSigning({
      config: { nodeRole: 'edge', chain: { signer }, publisher: { enabled: true } }, chainType: 'evm', dataDir: dir, log: () => {},
    })).rejects.toThrow(/publisher\.enabled/);
    await expect(resolveDaemonEvmSigning({
      config: { nodeRole: 'edge', chain: { signer: { type: 'remote' } as never } }, chainType: 'evm', dataDir: dir, log: () => {},
    })).rejects.toThrow(/set url or socketPath/);
    expect(existsSync(join(dir, 'wallets.json'))).toBe(false);
  });

  it('fails startup when the external signer cannot be reached', async () => {
    const dir = await tempDir();
    await expect(resolveDaemonEvmSigning({
      config: { nodeRole: 'edge', chain: { signer: { type: 'remote', socketPath: join(dir, 'absent.sock') } } },
      chainType: 'evm',
      dataDir: dir,
      log: () => {},
    })).rejects.toMatchObject({ code: 'REMOTE_SIGNER_UNAVAILABLE' });
    expect(existsSync(join(dir, 'wallets.json'))).toBe(false);
  });
});

describe('setup flows', () => {
  it('create no wallets.json for a node that signs through an external signer', async () => {
    const external = await tempDir();
    await writeFile(join(external, 'config.json'), JSON.stringify({
      name: 'external',
      chain: { signer: { type: 'remote', socketPath: '/run/signer/signer.sock' } },
    }));
    expect(await usesExternalSigner(external)).toBe(true);
    expect(await loadLocalOpWalletsUnlessExternal(external)).toBeUndefined();
    expect(existsSync(join(external, 'wallets.json'))).toBe(false);

    const local = await tempDir();
    await writeFile(join(local, 'config.json'), JSON.stringify({ name: 'local' }));
    expect(await usesExternalSigner(local)).toBe(false);
    expect((await loadLocalOpWalletsUnlessExternal(local))?.wallets).toHaveLength(3);
    expect(existsSync(join(local, 'wallets.json'))).toBe(true);
  });
});
