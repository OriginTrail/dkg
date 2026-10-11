// SPDX-License-Identifier: Apache-2.0
/**
 * External JSON-RPC signer support: transport (HTTP and HTTP over a unix
 * socket), credentials, verification of every answer, error mapping, the
 * no-retry/no-failover guarantees and the payer/author account split. Runs
 * against an in-process fake signer; no chain is needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import {
  RemoteSigner,
  RemoteSignerClient,
} from '../src/remote-signer.js';
import { RemoteSignerError, isRemoteSignerError } from '../src/remote-signer-errors.js';
import { connectRemoteSigners } from '../src/remote-signer-connect.js';
import { connectConfiguredRemoteSigners, resolveChainSignerConfig } from '../src/remote-signer-config.js';
import { classifyRpcRetryDisposition, isRetryableRpcError } from '../src/evm-adapter-rpc.js';
import { RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS } from '../src/evm-adapter-constants.js';
import { OperationalKeyUnavailableError, isExternalEvmSigner } from '../src/evm-signer.js';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { makeClient, recorder } from './rpc-failover-test-helpers.js';
import type { SignPopulatedFn } from '../src/rpc-failover-client.js';
import { startFakeRemoteSigner, type FakeSigner, type FakeSignerOptions } from './helpers/fake-remote-signer.js';

const KEY_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const KEY_B = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const KEY_C = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const KEY_D = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';
const WALLET_A = new ethers.Wallet(KEY_A);
const WALLET_B = new ethers.Wallet(KEY_B);
const WALLET_C = new ethers.Wallet(KEY_C);
const WALLET_D = new ethers.Wallet(KEY_D);
const TOKEN = 'payer-token-1b2c3d4e5f60718293a4b5c6';
const AUTHOR_TOKEN = 'author-token-9f8e7d6c5b4a39281706f5e4';
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const TX: ethers.TransactionRequest = {
  type: 2,
  to: '0x00000000000000000000000000000000000000a1',
  data: '0x095ea7b3',
  value: 0n,
  nonce: 7,
  gasLimit: 120_000n,
  maxFeePerGas: 3_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  chainId: 31337n,
};

const DOMAIN = { name: 'Example', version: '1', chainId: 31337, verifyingContract: '0x00000000000000000000000000000000000000c3' };
const TYPES = { Attestation: [{ name: 'root', type: 'bytes32' }, { name: 'author', type: 'address' }, { name: 'n', type: 'uint256' }] };
const VALUE = { root: ethers.keccak256('0x01'), author: WALLET_A.address, n: 5n };

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

function highS(signature: string): string {
  const sig = ethers.Signature.from(signature);
  const s = N - BigInt(sig.s);
  const bytes = ethers.getBytes(ethers.concat([sig.r, ethers.toBeHex(s, 32), sig.v === 27 ? '0x1c' : '0x1b']));
  return ethers.hexlify(bytes);
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (signers.length > 0) await signers.pop()!.close();
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe('remote signer transport', () => {
  it('lists accounts over HTTP with the bearer credential', async () => {
    const signer = await fakeSigner();
    await expect(client(signer).listAccounts()).resolves.toEqual([WALLET_A.address, WALLET_B.address]);
    expect(signer.calls('eth_accounts')).toEqual([
      { method: 'eth_accounts', params: [], authorization: `Bearer ${TOKEN}` },
    ]);
  });

  it('speaks HTTP over a unix domain socket', async () => {
    const dir = await shortTempDir();
    const signer = await fakeSigner({ socketPath: join(dir, 'signer.sock') });
    const remote = client(signer);
    expect(remote.endpoint).toBe(`unix:${join(dir, 'signer.sock')}`);
    await expect(remote.listAccounts()).resolves.toEqual([WALLET_A.address, WALLET_B.address]);
    const signed = await new RemoteSigner(WALLET_A.address, remote).signTransaction(TX);
    expect(signed).toBe(await WALLET_A.signTransaction(TX));
  });

  it('maps a refused credential to REMOTE_SIGNER_UNAUTHORIZED without echoing the token', async () => {
    const signer = await fakeSigner();
    const wrong = new RemoteSignerClient({ url: signer.url, authToken: 'wrong-token-0123456789' });
    const err = await wrong.listAccounts().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteSignerError);
    expect((err as RemoteSignerError).code).toBe('REMOTE_SIGNER_UNAUTHORIZED');
    expect((err as RemoteSignerError).httpStatus).toBe(401);
    expect(JSON.stringify(err) + String(err)).not.toContain('wrong-token-0123456789');
  });

  it('maps JSON-RPC errors, redacting a credential the signer echoes back', async () => {
    const signer = await fakeSigner({
      reject: (method) => method === 'eth_signTransaction'
        ? { code: -32010, message: `policy refused request made with ${TOKEN}\n(chain id)` }
        : undefined,
    });
    const err = await new RemoteSigner(WALLET_A.address, client(signer)).signTransaction(TX).catch((e: unknown) => e);
    expect((err as RemoteSignerError).code).toBe('REMOTE_SIGNER_REJECTED');
    expect((err as RemoteSignerError).rpcCode).toBe(-32010);
    expect((err as Error).message).toContain('policy refused request made with [redacted] (chain id)');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('maps a missing method to REMOTE_SIGNER_METHOD_NOT_SUPPORTED', async () => {
    const signer = await fakeSigner({ unsupported: ['eth_accounts'] });
    await expect(client(signer).listAccounts()).rejects.toMatchObject({
      code: 'REMOTE_SIGNER_METHOD_NOT_SUPPORTED',
      rpcCode: -32601,
    });
  });

  it('maps non-JSON-RPC answers to HTTP or bad-response errors', async () => {
    const http500 = await fakeSigner({ rawResponse: () => ({ status: 502, body: '<html>bad gateway</html>' }) });
    await expect(client(http500).listAccounts()).rejects.toMatchObject({
      code: 'REMOTE_SIGNER_HTTP_ERROR',
      httpStatus: 502,
    });
    const notJson = await fakeSigner({ rawResponse: () => ({ status: 200, body: 'ok' }) });
    await expect(client(notJson).listAccounts()).rejects.toMatchObject({ code: 'REMOTE_SIGNER_BAD_RESPONSE' });
    const wrongShape = await fakeSigner({ tamper: () => 'not-a-list' });
    await expect(client(wrongShape).listAccounts()).rejects.toMatchObject({ code: 'REMOTE_SIGNER_BAD_RESPONSE' });
  });

  it('times out a signing request once and never re-sends it', async () => {
    const signer = await fakeSigner({ hang: ['eth_signTransaction'] });
    const remote = new RemoteSigner(WALLET_A.address, client(signer, { timeoutMs: 150 }));
    const started = Date.now();
    const err = await remote.signTransaction(TX).catch((e: unknown) => e);
    expect((err as RemoteSignerError).code).toBe('REMOTE_SIGNER_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(signer.calls('eth_signTransaction')).toHaveLength(1);
  });

  it('maps an unreachable endpoint or socket to REMOTE_SIGNER_UNAVAILABLE', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(new RemoteSignerClient({ url: `http://127.0.0.1:${port}` }).listAccounts())
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_UNAVAILABLE' });
    const dir = await shortTempDir();
    await expect(new RemoteSignerClient({ socketPath: join(dir, 'missing.sock') }).listAccounts())
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_UNAVAILABLE' });
  });

  it('rejects invalid endpoint, credential and timeout settings', () => {
    expect(() => new RemoteSignerClient({})).toThrow(/exactly one of url or socketPath/);
    expect(() => new RemoteSignerClient({ url: 'http://a', socketPath: '/s' })).toThrow(/exactly one of url or socketPath/);
    expect(() => new RemoteSignerClient({ url: 'ftp://signer' })).toThrow(/http: or https:/);
    expect(() => new RemoteSignerClient({ url: 'https://user:secret@signer' })).toThrow(/must not embed credentials/);
    expect(() => new RemoteSignerClient({ url: 'http://signer', authToken: 'has space' })).toThrow(/visible ASCII/);
    expect(() => new RemoteSignerClient({ url: 'http://signer', timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => new RemoteSignerClient({ url: 'http://signer', api: 'other' as never })).toThrow(/"eth" or "clef"/);
    const err = (() => { try { new RemoteSignerClient({ url: 'https://user:secret@signer' }); } catch (e) { return e; } })();
    expect(String(err)).not.toContain('secret');
  });

  it('rejects malformed, mismatched and oversized answers, and reaches https endpoints', async () => {
    expect(() => new RemoteSignerClient({ url: 'http://[' })).toThrow(/not a valid URL/);
    const wrongId = await fakeSigner({
      rawResponse: () => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 999, result: [] }) }),
    });
    await expect(client(wrongId).listAccounts()).rejects.toThrow(/malformed JSON-RPC response/);
    const oversized = await fakeSigner({ rawResponse: () => ({ status: 200, body: 'x'.repeat(4 * 1024 * 1024 + 1) }) });
    await expect(client(oversized).listAccounts()).rejects.toThrow(/sent more than/);
    const notAnAccount = await fakeSigner({ tamper: (method, result) => method === 'eth_accounts' ? ['not-an-address'] : result });
    await expect(client(notAnAccount).listAccounts()).rejects.toMatchObject({ code: 'REMOTE_SIGNER_BAD_RESPONSE' });

    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const secure = new RemoteSignerClient({ url: `https://127.0.0.1:${port}`, timeoutMs: 2_000 });
    expect(secure.endpoint).toBe(`https://127.0.0.1:${port}`);
    expect(secure.timeoutMs).toBe(2_000);
    await expect(secure.listAccounts()).rejects.toMatchObject({ code: 'REMOTE_SIGNER_UNAVAILABLE' });
    secure.destroy();
  });
});

describe('RemoteSigner verification', () => {
  it('signs exactly the populated transaction it was given', async () => {
    const signer = await fakeSigner();
    const remote = new RemoteSigner(WALLET_A.address, client(signer));
    expect(isExternalEvmSigner(remote)).toBe(true);
    const signed = await remote.signTransaction(TX);
    expect(signed).toBe(await WALLET_A.signTransaction(TX));
    expect(signer.calls('eth_signTransaction')).toEqual([{
      method: 'eth_signTransaction',
      authorization: `Bearer ${TOKEN}`,
      params: [{
        from: WALLET_A.address.toLowerCase(),
        to: '0x00000000000000000000000000000000000000a1',
        gas: '0x1d4c0',
        value: '0x0',
        data: '0x095ea7b3',
        nonce: '0x7',
        chainId: '0x7a69',
        type: '0x2',
        maxFeePerGas: '0xb2d05e00',
        maxPriorityFeePerGas: '0x3b9aca00',
      }],
    }]);
  });

  it('signs legacy transactions and speaks the clef dialect', async () => {
    const legacy: ethers.TransactionRequest = {
      type: 0, to: TX.to, data: '0x', value: 5n, nonce: 1, gasLimit: 21_000n, gasPrice: 2_000_000_000n, chainId: 31337n,
    };
    const signer = await fakeSigner({ api: 'clef' });
    const remote = new RemoteSigner(WALLET_B.address, client(signer, { api: 'clef' }));
    expect(await remote.signTransaction(legacy)).toBe(await WALLET_B.signTransaction(legacy));
    expect(await remote.signTransaction(TX)).toBe(await WALLET_B.signTransaction(TX));
    expect(signer.calls('account_signTransaction')).toHaveLength(2);
    expect(signer.calls('account_signTransaction')[0].params[0]).toMatchObject({ gasPrice: '0x77359400' });
    expect(await client(signer, { api: 'clef' }).listAccounts()).toEqual([WALLET_A.address, WALLET_B.address]);
    const typed = await remote.signTypedData(DOMAIN, TYPES, VALUE);
    expect(typed).toBe(await WALLET_B.signTypedData(DOMAIN, TYPES, VALUE));
    expect(signer.calls('account_signTypedData')[0].params[1]).toMatchObject({ primaryType: 'Attestation' });
    const message = await remote.signMessage(ethers.getBytes(ethers.id('digest')));
    expect(ethers.verifyMessage(ethers.getBytes(ethers.id('digest')), message)).toBe(WALLET_B.address);
    expect(signer.calls('account_signData')[0].params[0]).toBe('text/plain');
  });

  it('refuses an unpopulated transaction without contacting the signer', async () => {
    const signer = await fakeSigner();
    const remote = new RemoteSigner(WALLET_A.address, client(signer));
    const { nonce: _nonce, ...withoutNonce } = TX;
    await expect(remote.signTransaction(withoutNonce)).rejects.toMatchObject({ code: 'REMOTE_SIGNER_TRANSACTION_NOT_SIGNABLE' });
    const { maxFeePerGas: _fee, ...withoutFee } = TX;
    await expect(remote.signTransaction(withoutFee)).rejects.toMatchObject({ code: 'REMOTE_SIGNER_TRANSACTION_NOT_SIGNABLE' });
    await expect(remote.signTransaction({ ...TX, from: WALLET_B.address })).rejects.toMatchObject({
      code: 'REMOTE_SIGNER_TRANSACTION_NOT_SIGNABLE',
    });
    expect(signer.requests).toHaveLength(0);
  });

  it.each([
    ['nonce', { nonce: 8 }],
    ['chainId', { chainId: 1n }],
    ['to', { to: '0x00000000000000000000000000000000000000b2' }],
    ['value', { value: 1n }],
    ['data', { data: '0x095ea7b4' }],
    ['gasLimit', { gasLimit: 120_001n }],
    ['maxFeePerGas', { maxFeePerGas: 3_000_000_001n }],
  ] as const)('rejects a signed transaction whose %s differs from the request', async (field, change) => {
    const signer = await fakeSigner({
      tamper: async (method, result, _request, wallet) => (
        method === 'eth_signTransaction' ? wallet!.signTransaction({ ...TX, ...change }) : result
      ),
    });
    const err = await new RemoteSigner(WALLET_A.address, client(signer)).signTransaction(TX).catch((e: unknown) => e);
    expect((err as RemoteSignerError).code).toBe('REMOTE_SIGNER_TRANSACTION_MISMATCH');
    expect((err as Error).message).toContain(field);
    expect(signer.calls('eth_signTransaction')).toHaveLength(1);
  });

  it('rejects a transaction signed by another key or with a non-canonical signature', async () => {
    const otherKey = await fakeSigner({
      tamper: (method, result) => method === 'eth_signTransaction' ? WALLET_C.signTransaction(TX) : result,
    });
    await expect(new RemoteSigner(WALLET_A.address, client(otherKey)).signTransaction(TX))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_INVALID_SIGNATURE' });

    // The same signature in its malleable high-s form, re-encoded by hand.
    const malleable = await fakeSigner({
      tamper: (method, result) => {
        if (method !== 'eth_signTransaction') return result;
        const raw = ethers.getBytes(String(result));
        const fields = ethers.decodeRlp(raw.subarray(1)) as string[];
        fields[9] = fields[9] === '0x' ? '0x01' : '0x';
        fields[11] = ethers.toBeHex(N - BigInt(fields[11]));
        return ethers.concat(['0x02', ethers.encodeRlp(fields)]);
      },
    });
    const malleated = await new RemoteSigner(WALLET_A.address, client(malleable)).signTransaction(TX)
      .catch((e: unknown) => e);
    expect((malleated as RemoteSignerError).code).toBe('REMOTE_SIGNER_INVALID_SIGNATURE');

    const garbage = await fakeSigner({ tamper: (method, result) => method === 'eth_signTransaction' ? '0xdeadbeef' : result });
    await expect(new RemoteSigner(WALLET_A.address, client(garbage)).signTransaction(TX))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_BAD_RESPONSE' });
  });

  it('rejects an answer that is not a signed transaction', async () => {
    const unsigned = await fakeSigner({
      tamper: (method, result) => method === 'eth_signTransaction' ? ethers.Transaction.from(String(result)).unsignedSerialized : result,
    });
    await expect(new RemoteSigner(WALLET_A.address, client(unsigned)).signTransaction(TX))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_INVALID_SIGNATURE' });
    const notHex = await fakeSigner({ tamper: (method, result) => method === 'eth_signTransaction' ? 42 : result });
    await expect(new RemoteSigner(WALLET_A.address, client(notHex)).signTransaction(TX))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_BAD_RESPONSE' });
  });

  it('refuses transactions and typed data it cannot sign externally', async () => {
    const signer = await fakeSigner();
    const remote = new RemoteSigner(WALLET_A.address, client(signer));
    const { maxFeePerGas: _fee, maxPriorityFeePerGas: _tip, ...withoutFees } = TX;
    const unsignable: ethers.TransactionRequest[] = [
      { ...TX, authorizationList: [] },
      { ...withoutFees, type: 0 },
      { ...TX, type: 4 },
    ];
    for (const tx of unsignable) {
      await expect(remote.signTransaction(tx)).rejects.toMatchObject({ code: 'REMOTE_SIGNER_TRANSACTION_NOT_SIGNABLE' });
    }
    // A name in typed data needs a provider to resolve it before anything is sent.
    const named = { ...DOMAIN, verifyingContract: 'signer.example' };
    await expect(remote.signTypedData(named, TYPES, VALUE)).rejects.toMatchObject({
      code: 'REMOTE_SIGNER_TRANSACTION_NOT_SIGNABLE',
    });
    expect(signer.requests).toHaveLength(0);
    const resolving = remote.connect({ resolveName: async () => DOMAIN.verifyingContract } as unknown as ethers.Provider);
    expect(await resolving.signTypedData(named, TYPES, VALUE)).toBe(await WALLET_A.signTypedData(DOMAIN, TYPES, VALUE));
  });

  it('signs typed data with eth_signTypedData_v4 (a JSON string) and falls back once to eth_signTypedData (an object)', async () => {
    const v4 = await fakeSigner();
    const remote = new RemoteSigner(WALLET_A.address, client(v4));
    expect(await remote.signTypedData(DOMAIN, TYPES, VALUE)).toBe(await WALLET_A.signTypedData(DOMAIN, TYPES, VALUE));
    const [request] = v4.calls('eth_signTypedData_v4');
    expect(request.params[0]).toBe(WALLET_A.address.toLowerCase());
    // The standard EIP-712 JSON payload (as a string), hashing to the same digest.
    const payload = JSON.parse(String(request.params[1]));
    expect(payload.primaryType).toBe('Attestation');
    expect(payload.types.EIP712Domain.map((field: { name: string }) => field.name))
      .toEqual(['name', 'version', 'chainId', 'verifyingContract']);
    const { EIP712Domain: _domain, ...payloadTypes } = payload.types;
    expect(ethers.TypedDataEncoder.hash(payload.domain, payloadTypes, payload.message))
      .toBe(ethers.TypedDataEncoder.hash(DOMAIN, TYPES, VALUE));

    const legacyName = await fakeSigner({ unsupported: ['eth_signTypedData_v4'] });
    const shared = client(legacyName);
    const viaFallback = new RemoteSigner(WALLET_A.address, shared);
    expect(await viaFallback.signTypedData(DOMAIN, TYPES, VALUE)).toBe(await WALLET_A.signTypedData(DOMAIN, TYPES, VALUE));
    await new RemoteSigner(WALLET_B.address, shared).signTypedData(DOMAIN, TYPES, VALUE);
    expect(legacyName.calls('eth_signTypedData_v4')).toHaveLength(1);
    expect(legacyName.calls('eth_signTypedData')).toHaveLength(2);
    // The same payload, as the object eth_signTypedData takes; this signer refuses a JSON string there.
    expect(legacyName.calls('eth_signTypedData')[0].params).toEqual([request.params[0], payload]);
    await expect(shared.transport.request('eth_signTypedData', request.params))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_REJECTED', rpcCode: -32602 });
  });

  it('signs EIP-191 messages with eth_sign, falling back to personal_sign', async () => {
    const digest = ethers.getBytes(ethers.id('ack digest'));
    const ethSign = await fakeSigner();
    const signature = await new RemoteSigner(WALLET_A.address, client(ethSign)).signMessage(digest);
    expect(signature).toBe(await WALLET_A.signMessage(digest));
    expect(ethSign.calls('eth_sign')[0].params).toEqual([WALLET_A.address.toLowerCase(), ethers.hexlify(digest)]);

    const personal = await fakeSigner({ unsupported: ['eth_sign'] });
    expect(await new RemoteSigner(WALLET_A.address, client(personal)).signMessage('hello')).toBe(await WALLET_A.signMessage('hello'));
    expect(personal.calls('personal_sign')[0].params).toEqual([ethers.hexlify(ethers.toUtf8Bytes('hello')), WALLET_A.address.toLowerCase()]);
  });

  it('normalizes high-s and v=0/1 signatures and rejects ones from another key', async () => {
    const normalizing = await fakeSigner({
      tamper: (method, result) => {
        if (method === 'eth_signTypedData_v4') return highS(String(result));
        if (method === 'eth_sign') {
          const sig = ethers.Signature.from(String(result));
          return ethers.concat([sig.r, sig.s, sig.v === 27 ? '0x00' : '0x01']);
        }
        return result;
      },
    });
    const remote = new RemoteSigner(WALLET_A.address, client(normalizing));
    expect(await remote.signTypedData(DOMAIN, TYPES, VALUE)).toBe(await WALLET_A.signTypedData(DOMAIN, TYPES, VALUE));
    expect(await remote.signMessage('x')).toBe(await WALLET_A.signMessage('x'));

    const otherKey = await fakeSigner({
      tamper: (method, result) => method === 'eth_signTypedData_v4' ? WALLET_C.signTypedData(DOMAIN, TYPES, VALUE) : result,
    });
    await expect(new RemoteSigner(WALLET_A.address, client(otherKey)).signTypedData(DOMAIN, TYPES, VALUE))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_INVALID_SIGNATURE' });
  });

  it('accepts 64-byte compact signatures and rejects malformed ones', async () => {
    const answering = (rewrite: (signature: string) => string) => fakeSigner({
      tamper: (method, result) => method === 'eth_signTypedData_v4' ? rewrite(String(result)) : result,
    });
    const compact = await answering((signature) => ethers.Signature.from(signature).compactSerialized);
    expect(await new RemoteSigner(WALLET_A.address, client(compact)).signTypedData(DOMAIN, TYPES, VALUE))
      .toBe(await WALLET_A.signTypedData(DOMAIN, TYPES, VALUE));

    const malformed: Array<[string, (signature: string) => string, string]> = [
      ['not hex', () => 'not-hex', 'REMOTE_SIGNER_BAD_RESPONSE'],
      ['two bytes', () => '0x1234', 'REMOTE_SIGNER_BAD_RESPONSE'],
      ['recovery id 5', (signature) => ethers.concat([ethers.dataSlice(signature, 0, 64), '0x05']), 'REMOTE_SIGNER_INVALID_SIGNATURE'],
      ['r of zero', (signature) => ethers.concat([ethers.ZeroHash, ethers.dataSlice(signature, 32)]), 'REMOTE_SIGNER_INVALID_SIGNATURE'],
      // r = 5 is not the x coordinate of a curve point, so nothing recovers from it.
      ['unrecoverable', () => ethers.concat([ethers.toBeHex(5n, 32), ethers.toBeHex(1n, 32), '0x1b']), 'REMOTE_SIGNER_INVALID_SIGNATURE'],
    ];
    for (const [label, rewrite, code] of malformed) {
      const signer = await answering(rewrite);
      await expect(new RemoteSigner(WALLET_A.address, client(signer)).signTypedData(DOMAIN, TYPES, VALUE), label)
        .rejects.toMatchObject({ code });
    }
  });

  it('connect() keeps the account and transport and binds the provider', async () => {
    const signer = await fakeSigner();
    const remote = new RemoteSigner(WALLET_A.address, client(signer));
    const provider = new ethers.JsonRpcProvider('http://127.0.0.1:1', 31337, { staticNetwork: true });
    const bound = remote.connect(provider);
    expect(bound).toBeInstanceOf(RemoteSigner);
    expect(bound.address).toBe(WALLET_A.address);
    expect(bound.provider).toBe(provider);
    expect(bound.client).toBe(remote.client);
    expect(await bound.getAddress()).toBe(WALLET_A.address);
    provider.destroy();
  });
});

describe('payer and author accounts', () => {
  it('uses every served account as a payer, or the configured subset in order', async () => {
    const signer = await fakeSigner({ credentials: [{ token: TOKEN, keys: [KEY_A, KEY_B, KEY_C] }] });
    const all = await connectRemoteSigners({ url: signer.url, authToken: TOKEN });
    expect(all.operational.map((s) => s.address)).toEqual([WALLET_A.address, WALLET_B.address, WALLET_C.address]);
    expect(all.authors).toBeUndefined();
    const subset = await connectRemoteSigners({ url: signer.url, authToken: TOKEN, addresses: [WALLET_C.address, WALLET_A.address] });
    expect(subset.operational.map((s) => s.address)).toEqual([WALLET_C.address, WALLET_A.address]);
    await expect(connectRemoteSigners({ url: signer.url, authToken: TOKEN, addresses: [WALLET_D.address] }))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_ADDRESS_NOT_AVAILABLE' });
  });

  it('keeps author keys of a separate credential apart from the payers', async () => {
    const signer = await fakeSigner({
      credentials: [
        { token: TOKEN, keys: [KEY_A, KEY_B, KEY_C] },
        { token: AUTHOR_TOKEN, keys: [KEY_C] },
      ],
    });
    const result = await connectRemoteSigners({ url: signer.url, authToken: TOKEN, author: { authToken: AUTHOR_TOKEN } });
    expect(result.operational.map((s) => s.address)).toEqual([WALLET_A.address, WALLET_B.address]);
    expect(result.authors!.defaultAuthor!.address).toBe(WALLET_C.address);
    expect(await result.authors!.signerFor(WALLET_A.address)).toBeUndefined();
    const author = await result.authors!.signerFor(WALLET_C.address.toLowerCase());
    expect(await author!.signTypedData(DOMAIN, TYPES, VALUE)).toBe(await WALLET_C.signTypedData(DOMAIN, TYPES, VALUE));
    const typedCall = signer.calls('eth_signTypedData_v4').at(-1)!;
    expect(typedCall.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
  });

  it('picks up author keys added after startup but never a payer account', async () => {
    const authorKeys = [KEY_C];
    const signer = await fakeSigner({
      credentials: [
        { token: TOKEN, keys: [KEY_A, KEY_B] },
        { token: AUTHOR_TOKEN, keys: authorKeys },
      ],
    });
    const result = await connectRemoteSigners({
      url: signer.url,
      authToken: TOKEN,
      author: { authToken: AUTHOR_TOKEN, address: WALLET_C.address },
    });
    expect(await result.authors!.signerFor(WALLET_D.address)).toBeUndefined();
    authorKeys.push(KEY_D, KEY_A);
    expect((await result.authors!.signerFor(WALLET_D.address))?.address).toBe(WALLET_D.address);
    expect(await result.authors!.signerFor(WALLET_A.address)).toBeUndefined();
    expect(result.operational.map((s) => s.address)).toEqual([WALLET_A.address, WALLET_B.address]);
  });

  it('reserves a named author on the main connection and rejects overlapping settings', async () => {
    const signer = await fakeSigner({ credentials: [{ token: TOKEN, keys: [KEY_A, KEY_B, KEY_C] }] });
    const result = await connectRemoteSigners({ url: signer.url, authToken: TOKEN, author: { address: WALLET_B.address } });
    expect(result.operational.map((s) => s.address)).toEqual([WALLET_A.address, WALLET_C.address]);
    expect(result.authors!.defaultAuthor!.address).toBe(WALLET_B.address);
    expect(await result.authors!.signerFor(WALLET_C.address)).toBeUndefined();
    await expect(connectRemoteSigners({
      url: signer.url, authToken: TOKEN, addresses: [WALLET_B.address], author: { address: WALLET_B.address },
    })).rejects.toMatchObject({ code: 'REMOTE_SIGNER_CONFIG' });
    await expect(connectRemoteSigners({ url: signer.url, authToken: TOKEN, author: {} }))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_CONFIG' });
    await expect(connectRemoteSigners({ url: signer.url, authToken: TOKEN, author: { address: WALLET_D.address } }))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_ADDRESS_NOT_AVAILABLE' });
  });

  it('refuses a signer without payer or author accounts, and invalid payer addresses', async () => {
    const signer = await fakeSigner({
      credentials: [
        { token: TOKEN, keys: [KEY_A] },
        { token: AUTHOR_TOKEN, keys: [] },
      ],
    });
    await expect(connectRemoteSigners({ url: signer.url, authToken: TOKEN, author: { authToken: AUTHOR_TOKEN } }))
      .rejects.toThrow(/serves no account/);
    await expect(connectRemoteSigners({ url: signer.url, authToken: TOKEN, author: { address: WALLET_A.address } }))
      .rejects.toThrow(/serves no payer account/);
    await expect(connectRemoteSigners({ url: signer.url, authToken: TOKEN, addresses: ['not-an-address'] }))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_CONFIG' });
  });

  it('describes the author connection and ignores lookups that are not addresses', async () => {
    const signer = await fakeSigner({
      credentials: [
        { token: TOKEN, keys: [KEY_A] },
        { token: AUTHOR_TOKEN, keys: [KEY_B] },
      ],
    });
    const { authors } = await connectRemoteSigners({ url: signer.url, authToken: TOKEN, author: { authToken: AUTHOR_TOKEN } });
    expect(authors!.endpoint).toBe(signer.url);
    expect(authors!.addresses).toEqual([WALLET_B.address]);
    expect(await authors!.signerFor('not-an-address')).toBeUndefined();
  });
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
});

describe('remote signer failures are final for the transaction path', () => {
  it('classifies every remote signer error as non-retryable and non-failover', () => {
    for (const code of ['REMOTE_SIGNER_TIMEOUT', 'REMOTE_SIGNER_UNAVAILABLE', 'REMOTE_SIGNER_HTTP_ERROR'] as const) {
      const err = new RemoteSignerError(code, 'Remote signer at unix:/s is unavailable for eth_signTransaction (ECONNREFUSED) timed out 503');
      expect(classifyRpcRetryDisposition(err)).toBe('fail');
      expect(isRetryableRpcError(err)).toBe(false);
    }
  });

  const externalSigner = () => ({
    address: WALLET_A.address,
    isExternalSigner: true,
    connect: () => ({ address: WALLET_A.address, isExternalSigner: true }),
  }) as never;

  it('does not fail a signer error over to another RPC endpoint', async () => {
    const populates = [recorder(async () => ({ to: '0xTO', data: '0x' })), recorder(async () => ({ to: '0xTO', data: '0x' }))];
    let endpoint = 0;
    const contract = { connect: () => ({ doWrite: { populateTransaction: populates[endpoint++] } }) } as never;
    const signPopulated = recorder(async () => {
      throw new RemoteSignerError('REMOTE_SIGNER_UNAVAILABLE', 'Remote signer at unix:/s is unavailable for eth_signTransaction (ECONNRESET)');
    });
    const rpc = makeClient([{}, {}], ['https://a.example', 'https://b.example'], signPopulated as SignPopulatedFn);
    await expect(rpc.populateAndSign(contract, 'doWrite', [], externalSigner(), 'V10 publish'))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_UNAVAILABLE' });
    expect(signPopulated.calls).toHaveLength(1);
    expect(populates[1].calls).toHaveLength(0);
  });

  it('does not cut an external signing request off at the per-endpoint deadline', async () => {
    vi.useFakeTimers();
    const contract = { connect: () => ({ doWrite: { populateTransaction: async () => ({ to: '0xTO', data: '0x' }) } }) } as never;
    const signPopulated = recorder(() => new Promise<{ signedTx: string; txHash: string }>((resolve) => {
      setTimeout(() => resolve({ signedTx: '0xS', txHash: '0xH' }), RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS + 5_000);
    }));
    const rpc = makeClient([{}], ['https://only.example'], signPopulated as SignPopulatedFn);
    const pending = rpc.populateAndSign(contract, 'doWrite', [], externalSigner(), 'V10 publish');
    await vi.advanceTimersByTimeAsync(RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS + 6_000);
    await expect(pending).resolves.toEqual({ signedTx: '0xS', txHash: '0xH' });
    expect(signPopulated.calls).toHaveLength(1);
  });
});

describe('EVMChainAdapter with external signers', () => {
  const base = { rpcUrl: 'http://127.0.0.1:1', hubAddress: '0x00000000000000000000000000000000000000d4', chainId: 'evm:31337' };

  it('uses the external signers as its operational accounts and exposes no private key', async () => {
    const signer = await fakeSigner();
    const { operational } = await connectRemoteSigners({ url: signer.url, authToken: TOKEN });
    const adapter = new EVMChainAdapter({ ...base, signers: operational, allowNoAdminSigner: true });
    try {
      expect(adapter.getSignerAddresses()).toEqual([WALLET_A.address, WALLET_B.address]);
      expect(adapter.getSignerAddress()).toBe(WALLET_A.address);
      expect(() => adapter.getOperationalPrivateKey()).toThrow(OperationalKeyUnavailableError);
      expect(adapter.getACKSignerKey()).toBeUndefined();
      const signature = await adapter.signTypedDataAs(WALLET_B.address, DOMAIN, TYPES, VALUE);
      expect(signature).toBe(await WALLET_B.signTypedData(DOMAIN, TYPES, VALUE));
    } finally {
      adapter.destroy();
    }
  });

  it('rejects mixing local keys with external signers, or duplicate signers', async () => {
    const signer = await fakeSigner();
    const { operational } = await connectRemoteSigners({ url: signer.url, authToken: TOKEN });
    expect(() => new EVMChainAdapter({ ...base, privateKey: KEY_C, signers: operational }))
      .toThrow(/either privateKey\/additionalKeys or signers/);
    expect(() => new EVMChainAdapter({ ...base, signers: [operational[0], operational[0]] }))
      .toThrow(/more than once/);
    expect(() => new EVMChainAdapter({ ...base })).toThrow(/privateKey or at least one signer/);
  });

  it('still exposes the key of a local operational wallet', () => {
    const adapter = new EVMChainAdapter({ ...base, privateKey: KEY_C, allowNoAdminSigner: true });
    try {
      expect(adapter.getOperationalPrivateKey()).toBe(KEY_C);
      expect(adapter.getACKSignerKey()).toBe(KEY_C);
    } finally {
      adapter.destroy();
    }
  });
});
