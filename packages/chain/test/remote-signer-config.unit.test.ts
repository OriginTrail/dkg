// SPDX-License-Identifier: Apache-2.0
/**
 * The chain.signer configuration block: its validation, the bearer-token
 * sources and connecting a configured signer, against an in-process fake
 * signer; no chain is needed. The signer itself is covered in
 * remote-signer.unit.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { RemoteSignerClient } from '../src/remote-signer.js';
import { RemoteSignerError, isRemoteSignerError } from '../src/remote-signer-errors.js';
import { connectConfiguredRemoteSigners, resolveChainSignerConfig } from '../src/remote-signer-config.js';
import { startFakeRemoteSigner, type FakeSigner, type FakeSignerOptions } from './helpers/fake-remote-signer.js';

const KEY_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const KEY_B = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const WALLET_A = new ethers.Wallet(KEY_A);
const WALLET_B = new ethers.Wallet(KEY_B);
const TOKEN = 'payer-token-1b2c3d4e5f60718293a4b5c6';
const AUTHOR_TOKEN = 'author-token-9f8e7d6c5b4a39281706f5e4';

const signers: FakeSigner[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function fakeSigner(options: Partial<FakeSignerOptions> = {}): Promise<FakeSigner> {
  const signer = await startFakeRemoteSigner({
    credentials: [{ token: TOKEN, keys: [KEY_A, KEY_B] }],
    ...options,
  });
  signers.push(signer);
  return signer;
}

function client(signer: FakeSigner, options: Partial<ConstructorParameters<typeof RemoteSignerClient>[0]> = {}) {
  return new RemoteSignerClient({
    ...(signer.socketPath ? { socketPath: signer.socketPath } : { url: signer.url }),
    authToken: TOKEN,
    ...options,
  });
}

async function shortTempDir(): Promise<string> {
  // A unix socket path must stay short (about 100 bytes).
  const base = tmpdir().length < 60 ? tmpdir() : '/tmp';
  const dir = await mkdtemp(join(base, 'rs-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (signers.length > 0) await signers.pop()!.close();
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe('chain.signer configuration', () => {
  it('validates the block and treats an absent or local block as local signing', () => {
    expect(resolveChainSignerConfig(undefined)).toBeUndefined();
    expect(resolveChainSignerConfig({ type: 'local' })).toBeUndefined();
    expect(resolveChainSignerConfig({ type: 'remote', socketPath: '/run/signer.sock', authTokenFile: '/etc/token' })).toEqual({
      type: 'remote', socketPath: '/run/signer.sock', authTokenFile: '/etc/token',
    });
    const bad: Array<[unknown, RegExp]> = [
      [{ type: 'hsm' }, /type must be "local" or "remote"/],
      [{ type: 'local', url: 'http://x' }, /local signing takes no other settings/],
      [{ type: 'remote' }, /set url or socketPath/],
      [{ type: 'remote', url: 'http://x', socketPath: '/s' }, /not both/],
      [{ type: 'remote', url: 'x://y' }, /http:\/\/ or https:\/\//],
      [{ type: 'remote', url: 'http://x', authTokenFile: '/a', authTokenEnv: 'B' }, /authTokenFile or authTokenEnv/],
      [{ type: 'remote', url: 'http://x', authTokenEnv: 'not a name' }, /environment variable name/],
      [{ type: 'remote', url: 'http://x', addresses: ['0x1'] }, /addresses must be/],
      [{ type: 'remote', url: 'http://x', timeoutMs: 1.5 }, /timeoutMs/],
      [{ type: 'remote', url: 'http://x', authtokenfile: '/a' }, /unknown setting\(s\): authtokenfile/],
      [{ type: 'remote', url: 'http://x', author: {} }, /needs an address/],
      [{ type: 'remote', url: 'http://x', author: { address: 'nope' } }, /address must be/],
    ];
    for (const [raw, message] of bad) {
      expect(() => resolveChainSignerConfig(raw), JSON.stringify(raw)).toThrow(message);
    }
  });

  it('takes authors held on the node with payer accounts only, and never beside author keys of the signer', () => {
    expect(resolveChainSignerConfig({ type: 'remote', socketPath: '/run/signer.sock', authTokenFile: '/etc/token', nodeHeldAuthor: true })).toEqual({
      type: 'remote', socketPath: '/run/signer.sock', authTokenFile: '/etc/token', nodeHeldAuthor: true,
    });
    // Off is the same block as without the setting.
    expect(resolveChainSignerConfig({ type: 'remote', url: 'http://x', nodeHeldAuthor: false })).toEqual({ type: 'remote', url: 'http://x' });
    expect(resolveChainSignerConfig({ type: 'remote', url: 'http://x', author: { address: WALLET_B.address }, nodeHeldAuthor: false }))
      .toEqual({ type: 'remote', url: 'http://x', author: { address: WALLET_B.address } });
    const bad: Array<[unknown, RegExp]> = [
      [{ type: 'remote', url: 'http://x', nodeHeldAuthor: 'true' }, /nodeHeldAuthor must be true or false/],
      [{ type: 'remote', url: 'http://x', nodeHeldAuthor: 1 }, /nodeHeldAuthor must be true or false/],
      [{ type: 'remote', url: 'http://x', nodeHeldAuthor: true, author: { authTokenFile: '/a' } }, /cannot be combined with author/],
      [{ type: 'local', nodeHeldAuthor: true }, /local signing takes no other settings/],
    ];
    for (const [raw, message] of bad) {
      expect(() => resolveChainSignerConfig(raw), JSON.stringify(raw)).toThrow(message);
    }
  });

  it('keeps every optional setting, and connects an author block with its own credential', async () => {
    expect(resolveChainSignerConfig({
      type: 'remote',
      url: 'https://signer.internal',
      authTokenEnv: 'SIGNER_TOKEN',
      api: 'clef',
      addresses: [WALLET_A.address],
      timeoutMs: 5_000,
      author: { address: WALLET_B.address, authTokenEnv: 'SIGNER_AUTHOR_TOKEN' },
    })).toEqual({
      type: 'remote',
      url: 'https://signer.internal',
      authTokenEnv: 'SIGNER_TOKEN',
      api: 'clef',
      addresses: [WALLET_A.address],
      timeoutMs: 5_000,
      author: { address: WALLET_B.address, authTokenEnv: 'SIGNER_AUTHOR_TOKEN' },
    });
    expect(() => resolveChainSignerConfig({ type: 'remote', url: 'http://x', api: 'other' })).toThrow(/api must be/);

    const signer = await fakeSigner({
      credentials: [
        { token: TOKEN, keys: [KEY_A] },
        { token: AUTHOR_TOKEN, keys: [KEY_B] },
      ],
    });
    const connected = await connectConfiguredRemoteSigners(
      resolveChainSignerConfig({
        type: 'remote', url: signer.url, authTokenEnv: 'SIGNER_TOKEN', author: { authTokenEnv: 'SIGNER_AUTHOR_TOKEN' },
      })!,
      { env: { SIGNER_TOKEN: TOKEN, SIGNER_AUTHOR_TOKEN: AUTHOR_TOKEN } },
    );
    expect(connected.operational.map((s) => s.address)).toEqual([WALLET_A.address]);
    expect(connected.authors!.defaultAuthor!.address).toBe(WALLET_B.address);
  });

  it('reads the bearer token from a file or the environment, and warns on a shared file', async () => {
    const signer = await fakeSigner();
    const dir = await shortTempDir();
    const tokenFile = join(dir, 'token');
    await writeFile(tokenFile, `${TOKEN}\n`);
    await chmod(tokenFile, 0o644);
    const warnings: string[] = [];
    const viaFile = await connectConfiguredRemoteSigners(
      resolveChainSignerConfig({ type: 'remote', url: signer.url, authTokenFile: tokenFile })!,
      { onWarning: (message) => warnings.push(message) },
    );
    expect(viaFile.operational).toHaveLength(2);
    expect(warnings.join('\n')).toMatch(/accessible to other users/);
    expect(warnings.join('\n')).not.toContain(TOKEN);

    const viaEnv = await connectConfiguredRemoteSigners(
      resolveChainSignerConfig({ type: 'remote', url: signer.url, authTokenEnv: 'SIGNER_TOKEN' })!,
      { env: { SIGNER_TOKEN: TOKEN } },
    );
    expect(viaEnv.operational).toHaveLength(2);
    await expect(connectConfiguredRemoteSigners(
      resolveChainSignerConfig({ type: 'remote', url: signer.url, authTokenEnv: 'SIGNER_TOKEN' })!,
      { env: {} },
    )).rejects.toThrow(/SIGNER_TOKEN, which is not set/);
    await expect(connectConfiguredRemoteSigners(
      resolveChainSignerConfig({ type: 'remote', url: signer.url, authTokenFile: join(dir, 'absent') })!,
    )).rejects.toThrow(/cannot read authTokenFile/);
  });

  it('never writes the token to the console on failures', async () => {
    const output: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(' ')); });
    }
    const signer = await fakeSigner({
      reject: () => ({ code: -32000, message: `bad request carrying ${TOKEN}` }),
    });
    const errors: unknown[] = [];
    errors.push(await client(signer).listAccounts().catch((e: unknown) => e));
    errors.push(await new RemoteSignerClient({ url: signer.url, authToken: `${TOKEN}x` }).listAccounts().catch((e: unknown) => e));
    const hanging = await fakeSigner({ hang: ['eth_accounts'] });
    errors.push(await client(hanging, { timeoutMs: 50 }).listAccounts().catch((e: unknown) => e));
    for (const err of errors) {
      expect(isRemoteSignerError(err)).toBe(true);
      expect(`${String(err)} ${JSON.stringify(err)} ${(err as Error).stack}`).not.toContain(TOKEN);
    }
    expect(output.join('\n')).not.toContain(TOKEN);
  });

  it('recognizes a remote-signer failure by its code prefix, as a full error or a code-only record', () => {
    expect(isRemoteSignerError(new RemoteSignerError('REMOTE_SIGNER_TIMEOUT', 'timed out'))).toBe(true);
    // A record that keeps only the code, and a code another version of this module names.
    expect(isRemoteSignerError({ code: 'REMOTE_SIGNER_REJECTED' })).toBe(true);
    expect(isRemoteSignerError({ code: 'REMOTE_SIGNER_SOMETHING_NEWER' })).toBe(true);
    for (const other of [undefined, null, 'REMOTE_SIGNER_REJECTED', { code: 'RPC_TIMEOUT' }, { code: 7 }, new Error('REMOTE_SIGNER_REJECTED')]) {
      expect(isRemoteSignerError(other)).toBe(false);
    }
  });
});
