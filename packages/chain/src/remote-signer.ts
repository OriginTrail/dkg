// SPDX-License-Identifier: Apache-2.0

/**
 * An ethers v6 signer whose key lives in an external signer (a remote signing
 * service, an HSM-backed signer, ...) reached over the standard Ethereum
 * JSON-RPC signing API, so that the node holds no private key.
 *
 * The external signer is SIGN-ONLY: the node populates nonce, gas and fees
 * locally (through its RPC provider), asks for a signature over exactly that
 * transaction, and broadcasts the returned bytes itself after recording them.
 * Every answer is verified before use: a signed transaction must recover to
 * this signer's address and be byte-for-byte the transaction that was
 * requested (type, chain id, nonce, gas, fees, recipient, value, data, access
 * list); a message or typed-data signature must recover to this address for
 * the locally computed digest. Nothing is ever retried or re-signed here.
 *
 * Two JSON-RPC dialects are supported:
 *   - `eth` (default; the `eth_*` signing namespace served by Web3Signer and
 *     compatible signing services): `eth_accounts`, `eth_signTransaction`,
 *     `eth_signTypedData_v4` (falling back to `eth_signTypedData`) and
 *     `eth_sign` (falling back to `personal_sign`).
 *   - `clef` (go-ethereum Clef's external API): `account_list`,
 *     `account_signTransaction`, `account_signTypedData` and
 *     `account_signData` with `text/plain`.
 * A fallback method is tried only when the signer answers "method not found"
 * for the previous one, with the same payload; the choice is remembered.
 */
import {
  AbstractSigner,
  Signature,
  Transaction,
  TypedDataEncoder,
  copyRequest,
  getAddress,
  getBytes,
  hashMessage,
  hexlify,
  isHexString,
  recoverAddress,
  resolveAddress,
  toBeHex,
  toBigInt,
  toQuantity,
  toUtf8Bytes,
  type Provider,
  type TransactionRequest,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers';
import type { ExternalEvmSigner } from './evm-signer.js';
import { RemoteSignerError } from './remote-signer-errors.js';
import { RemoteSignerTransport, type RemoteSignerTransportOptions } from './remote-signer-transport.js';

export type RemoteSignerApi = 'eth' | 'clef';

export interface RemoteSignerClientOptions extends RemoteSignerTransportOptions {
  /** JSON-RPC dialect of the signer. Defaults to `eth`. */
  api?: RemoteSignerApi;
}

type SigningOperation = 'signTypedData' | 'signMessage';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

const METHODS: Record<RemoteSignerApi, {
  accounts: string;
  signTransaction: string;
  signTypedData: readonly string[];
  signMessage: readonly string[];
}> = {
  eth: {
    accounts: 'eth_accounts',
    signTransaction: 'eth_signTransaction',
    signTypedData: ['eth_signTypedData_v4', 'eth_signTypedData'],
    signMessage: ['eth_sign', 'personal_sign'],
  },
  clef: {
    accounts: 'account_list',
    signTransaction: 'account_signTransaction',
    signTypedData: ['account_signTypedData'],
    signMessage: ['account_signData'],
  },
};

/**
 * One external signer endpoint: the transport plus the JSON-RPC dialect.
 * {@link RemoteSigner} instances for different accounts share one client.
 */
export class RemoteSignerClient {
  readonly api: RemoteSignerApi;
  readonly transport: RemoteSignerTransport;
  readonly #methodChoice = new Map<SigningOperation, string>();

  constructor(options: RemoteSignerClientOptions) {
    const api = options.api ?? 'eth';
    if (api !== 'eth' && api !== 'clef') {
      throw new RemoteSignerError('REMOTE_SIGNER_CONFIG', 'Invalid remote signer configuration: api must be "eth" or "clef"');
    }
    this.api = api;
    this.transport = new RemoteSignerTransport(options);
  }

  /** Host-only endpoint description, safe to log. */
  get endpoint(): string {
    return this.transport.endpoint;
  }

  /** The signer timeout, which bounds every signing request. */
  get timeoutMs(): number {
    return this.transport.timeoutMs;
  }

  /** Checksummed accounts the signer serves, in the order it reports them. */
  async listAccounts(): Promise<string[]> {
    const method = METHODS[this.api].accounts;
    const result = await this.transport.request(method, []);
    if (!Array.isArray(result)) throw this.#badResponse(method, 'expected an array of addresses');
    const accounts: string[] = [];
    for (const entry of result) {
      if (typeof entry !== 'string') throw this.#badResponse(method, 'expected an array of addresses');
      let address: string;
      try {
        address = getAddress(entry);
      } catch {
        throw this.#badResponse(method, 'expected an array of addresses');
      }
      if (!accounts.includes(address)) accounts.push(address);
    }
    return accounts;
  }

  /** Returns the raw signed transaction exactly as the signer encoded it. */
  async signTransaction(transaction: Record<string, unknown>): Promise<string> {
    const method = METHODS[this.api].signTransaction;
    const result = await this.transport.request(method, [transaction]);
    const raw = this.api === 'clef' && isRecord(result) ? result.raw : result;
    if (typeof raw !== 'string' || !isHexString(raw) || raw.length < 4) {
      throw this.#badResponse(method, 'expected a raw signed transaction');
    }
    return raw;
  }

  /** Returns the signature over the EIP-712 `payload` (as produced by `TypedDataEncoder.getPayload`). */
  signTypedData(address: string, payload: Record<string, unknown>): Promise<unknown> {
    const account = address.toLowerCase();
    return this.#callWithFallback('signTypedData', (method) => (
      method === 'account_signTypedData'
        ? [account, payload]
        : [account, JSON.stringify(payload)]
    ));
  }

  /** Returns the EIP-191 (`\x19Ethereum Signed Message:\n`) signature over `data`. */
  signMessage(address: string, data: Uint8Array): Promise<unknown> {
    const account = address.toLowerCase();
    const hexData = hexlify(data);
    return this.#callWithFallback('signMessage', (method) => {
      if (method === 'personal_sign') return [hexData, account];
      if (method === 'account_signData') return ['text/plain', account, hexData];
      return [account, hexData];
    });
  }

  /** Close idle connections to the signer. */
  destroy(): void {
    this.transport.destroy();
  }

  async #callWithFallback(
    operation: SigningOperation,
    params: (method: string) => unknown[],
  ): Promise<unknown> {
    const chosen = this.#methodChoice.get(operation);
    const candidates = chosen === undefined ? METHODS[this.api][operation] : [chosen];
    for (let i = 0; i < candidates.length; i += 1) {
      const method = candidates[i];
      try {
        const result = await this.transport.request(method, params(method));
        this.#methodChoice.set(operation, method);
        return result;
      } catch (err) {
        const unsupported = err instanceof RemoteSignerError && err.code === 'REMOTE_SIGNER_METHOD_NOT_SUPPORTED';
        if (!unsupported || i === candidates.length - 1) throw err;
      }
    }
    throw new Error('unreachable');
  }

  #badResponse(method: string, expected: string): RemoteSignerError {
    return new RemoteSignerError(
      'REMOTE_SIGNER_BAD_RESPONSE',
      `Remote signer at ${this.endpoint} returned an unexpected result for ${method}: ${expected}`,
      { endpoint: this.endpoint, method },
    );
  }
}

/** An ethers signer for one account held by an external JSON-RPC signer. */
export class RemoteSigner extends AbstractSigner implements ExternalEvmSigner {
  readonly isExternalSigner = true as const;
  readonly address: string;
  readonly client: RemoteSignerClient;

  constructor(address: string, client: RemoteSignerClient, provider: Provider | null = null) {
    super(provider);
    this.address = getAddress(address);
    this.client = client;
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  connect(provider: Provider | null): RemoteSigner {
    return new RemoteSigner(this.address, this.client, provider);
  }

  async signTransaction(tx: TransactionRequest): Promise<string> {
    const request = copyRequest(tx);
    const [to, from] = await Promise.all([
      request.to == null ? undefined : resolveAddress(request.to, this),
      request.from == null ? undefined : resolveAddress(request.from, this),
    ]);
    if (from !== undefined && getAddress(from) !== this.address) {
      throw this.#notSignable(`its from address ${from} is not this signer (${this.address})`);
    }
    if (request.nonce == null || request.gasLimit == null || request.chainId == null || request.chainId === 0n) {
      throw this.#notSignable('nonce, gas limit and chain id must be populated before external signing');
    }
    const extended = tx as { blobs?: unknown; blobVersionedHashes?: unknown; authorizationList?: unknown };
    if (extended.blobs != null || extended.blobVersionedHashes != null || extended.authorizationList != null) {
      throw this.#notSignable('blob and authorization-list transactions are not supported for external signing');
    }
    const unsigned = Transaction.from({
      type: request.type ?? null,
      to: to ?? null,
      nonce: request.nonce,
      gasLimit: request.gasLimit,
      gasPrice: request.gasPrice ?? null,
      maxFeePerGas: request.maxFeePerGas ?? null,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas ?? null,
      data: request.data ?? '0x',
      value: request.value ?? 0n,
      chainId: request.chainId,
      accessList: request.accessList ?? null,
    });
    const type = unsigned.type ?? unsigned.inferType();
    unsigned.type = type;
    const rpcTransaction: Record<string, unknown> = {
      from: this.address.toLowerCase(),
      ...(unsigned.to === null ? {} : { to: unsigned.to.toLowerCase() }),
      gas: toQuantity(unsigned.gasLimit),
      value: toQuantity(unsigned.value),
      data: unsigned.data,
      nonce: toQuantity(unsigned.nonce),
      chainId: toQuantity(unsigned.chainId),
    };
    if (type === 2) {
      if (request.maxFeePerGas == null || request.maxPriorityFeePerGas == null) {
        throw this.#notSignable('maxFeePerGas and maxPriorityFeePerGas must be populated before external signing');
      }
      Object.assign(rpcTransaction, {
        type: '0x2',
        maxFeePerGas: toQuantity(unsigned.maxFeePerGas!),
        maxPriorityFeePerGas: toQuantity(unsigned.maxPriorityFeePerGas!),
        ...(unsigned.accessList && unsigned.accessList.length > 0 ? { accessList: unsigned.accessList } : {}),
      });
    } else if (type === 0 || type === 1) {
      if (request.gasPrice == null) {
        throw this.#notSignable('gasPrice must be populated before external signing');
      }
      rpcTransaction.gasPrice = toQuantity(unsigned.gasPrice!);
      if (type === 1) Object.assign(rpcTransaction, { type: '0x1', accessList: unsigned.accessList ?? [] });
    } else {
      throw this.#notSignable(`transaction type ${type} is not supported for external signing`);
    }

    const raw = await this.client.signTransaction(rpcTransaction);
    return this.#verifySignedTransaction(raw, unsigned);
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const data = typeof message === 'string' ? toUtf8Bytes(message) : message;
    const signature = await this.client.signMessage(this.address, data);
    return this.#verifySignature(signature, hashMessage(data), 'message');
  }

  async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string> {
    const populated = await TypedDataEncoder.resolveNames(domain, types, value, async (name) => {
      const address = this.provider === null ? null : await this.provider.resolveName(name);
      if (address == null) throw this.#notSignable(`cannot resolve the name ${JSON.stringify(name)} in typed data`);
      return address;
    });
    const payload = TypedDataEncoder.getPayload(populated.domain, types, populated.value);
    const signature = await this.client.signTypedData(this.address, payload as unknown as Record<string, unknown>);
    return this.#verifySignature(
      signature,
      TypedDataEncoder.hash(populated.domain, types, populated.value),
      'typed data',
    );
  }

  #verifySignedTransaction(raw: string, requested: Transaction): string {
    let signed: Transaction;
    try {
      signed = Transaction.from(raw);
    } catch (err) {
      throw this.#error('REMOTE_SIGNER_BAD_RESPONSE', 'returned bytes that are not a signed transaction', err);
    }
    if (signed.signature == null) {
      throw this.#error('REMOTE_SIGNER_INVALID_SIGNATURE', 'returned an unsigned transaction');
    }
    let s: bigint | undefined;
    try {
      s = toBigInt(signed.signature.s);
    } catch {
      // ethers refuses to expose an s value with its top bit set.
    }
    if (s === undefined || s > SECP256K1_HALF_N) {
      throw this.#error('REMOTE_SIGNER_INVALID_SIGNATURE', 'returned a transaction with a non-canonical (high-s) signature');
    }
    let from: string | null;
    try {
      from = signed.from;
    } catch (err) {
      throw this.#error('REMOTE_SIGNER_INVALID_SIGNATURE', 'returned a transaction with an unrecoverable signature', err);
    }
    if (from == null || getAddress(from) !== this.address) {
      throw this.#error(
        'REMOTE_SIGNER_INVALID_SIGNATURE',
        `returned a transaction signed by ${from == null ? 'nobody' : getAddress(from)} instead of ${this.address}`,
      );
    }
    if (signed.serialized !== raw.toLowerCase()) {
      throw this.#error('REMOTE_SIGNER_BAD_RESPONSE', 'returned a transaction that is not canonically encoded');
    }
    if (signed.unsignedSerialized !== requested.unsignedSerialized) {
      throw this.#error(
        'REMOTE_SIGNER_TRANSACTION_MISMATCH',
        `returned a transaction that differs from the request in: ${transactionDifferences(requested, signed).join(', ')}`,
      );
    }
    return signed.serialized;
  }

  /**
   * Accept a 65-byte (v = 0/1/27/28) or 64-byte compact signature, normalize
   * it to low-s with v = 27/28 (the form on-chain ECDSA verifiers accept), and
   * require it to recover to this signer's address for `digest`.
   */
  #verifySignature(value: unknown, digest: string, what: string): string {
    if (typeof value !== 'string' || !isHexString(value)) {
      throw this.#error('REMOTE_SIGNER_BAD_RESPONSE', `returned a ${what} signature that is not hex`);
    }
    const bytes = getBytes(value);
    let r: bigint;
    let s: bigint;
    let yParity: number;
    if (bytes.length === 65) {
      r = toBigInt(bytes.subarray(0, 32));
      s = toBigInt(bytes.subarray(32, 64));
      const v = bytes[64];
      if (v !== 0 && v !== 1 && v !== 27 && v !== 28) {
        throw this.#error('REMOTE_SIGNER_INVALID_SIGNATURE', `returned a ${what} signature with an invalid recovery id`);
      }
      yParity = v >= 27 ? v - 27 : v;
    } else if (bytes.length === 64) {
      r = toBigInt(bytes.subarray(0, 32));
      const yParityAndS = toBigInt(bytes.subarray(32, 64));
      yParity = Number(yParityAndS >> 255n);
      s = yParityAndS & ((1n << 255n) - 1n);
    } else {
      throw this.#error('REMOTE_SIGNER_BAD_RESPONSE', `returned a ${what} signature of ${bytes.length} bytes`);
    }
    if (r === 0n || r >= SECP256K1_N || s === 0n || s >= SECP256K1_N) {
      throw this.#error('REMOTE_SIGNER_INVALID_SIGNATURE', `returned an out-of-range ${what} signature`);
    }
    if (s > SECP256K1_HALF_N) {
      s = SECP256K1_N - s;
      yParity ^= 1;
    }
    const signature = Signature.from({ r: toBeHex(r, 32), s: toBeHex(s, 32), v: 27 + yParity });
    let recovered: string;
    try {
      recovered = recoverAddress(digest, signature);
    } catch (err) {
      throw this.#error('REMOTE_SIGNER_INVALID_SIGNATURE', `returned an unrecoverable ${what} signature`, err);
    }
    if (getAddress(recovered) !== this.address) {
      throw this.#error(
        'REMOTE_SIGNER_INVALID_SIGNATURE',
        `returned a ${what} signature that recovers to ${getAddress(recovered)} instead of ${this.address}`,
      );
    }
    return signature.serialized;
  }

  #notSignable(reason: string): RemoteSignerError {
    return new RemoteSignerError(
      'REMOTE_SIGNER_TRANSACTION_NOT_SIGNABLE',
      `Cannot ask the remote signer to sign for ${this.address}: ${reason}`,
      { endpoint: this.client.endpoint },
    );
  }

  #error(code: RemoteSignerError['code'], what: string, cause?: unknown): RemoteSignerError {
    return new RemoteSignerError(
      code,
      `Remote signer at ${this.client.endpoint} ${what} (account ${this.address})`,
      { endpoint: this.client.endpoint, ...(cause === undefined ? {} : { cause }) },
    );
  }
}

const COMPARED_FIELDS = [
  'type', 'chainId', 'nonce', 'gasLimit', 'gasPrice', 'maxFeePerGas',
  'maxPriorityFeePerGas', 'to', 'value', 'data', 'accessList',
] as const;

function transactionDifferences(requested: Transaction, signed: Transaction): string[] {
  const differing = COMPARED_FIELDS.filter((field) => (
    comparable(requested[field]) !== comparable(signed[field])
  ));
  return differing.length > 0 ? [...differing] : ['encoding'];
}

function comparable(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, inner: unknown) => (
    typeof inner === 'bigint' ? inner.toString() : typeof inner === 'string' ? inner.toLowerCase() : inner
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
