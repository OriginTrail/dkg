// SPDX-License-Identifier: Apache-2.0

/**
 * Discover the accounts an external signer serves and split them into two
 * disjoint roles:
 *
 *   - payers: the operational accounts that sign and pay for transactions;
 *   - authors: accounts that only sign author attestations.
 *
 * A V10 knowledge asset is minted to its EIP-712-attested author, not to the
 * transaction sender, and only that owner may attest an update. Authors
 * (owners) and payers are therefore separate keys, both can live in an
 * external signer, and each agent can have its own author key: payers publish
 * in parallel while ownership stays with the author. A payer account is never
 * used as an author, and an author account is never used as a payer.
 *
 * Payers are the accounts of the main signer connection (narrowed by
 * `addresses` when given). Authors are the accounts of the `author`
 * connection when it has its own endpoint or credential, or else just
 * `author.address` on the main connection. The default author, used for
 * requests that name no agent, is `author.address`, or the only account of
 * the author connection.
 */
import { getAddress, type Provider } from 'ethers';
import type { AuthorSigner, ExternalAuthorSigners } from './evm-signer.js';
import { RemoteSigner, RemoteSignerClient, type RemoteSignerClientOptions } from './remote-signer.js';
import { RemoteSignerError } from './remote-signer-errors.js';

export interface RemoteSignerAuthorOptions {
  /**
   * The default author. Without its own endpoint or token it must be one of
   * the main signer's accounts and is then the only author account.
   */
  address?: string;
  /** A separate endpoint for author keys; when neither is set the main endpoint is used. */
  url?: string;
  socketPath?: string;
  /** A separate credential for author keys; defaults to the main auth token. */
  authToken?: string;
}

export interface ConnectRemoteSignersOptions extends RemoteSignerClientOptions {
  /**
   * Optional filter: use only these payer accounts, in this order. Each must
   * be served by the signer. Without it every served account is a payer.
   */
  addresses?: readonly string[];
  /** Optional author keys, kept apart from the payers. */
  author?: RemoteSignerAuthorOptions;
  /** Provider the returned signers are connected to. */
  provider?: Provider | null;
}

export interface RemoteSigners {
  /** Payer accounts that sign transactions, first one primary. */
  operational: RemoteSigner[];
  /** Author accounts, when configured; never overlapping `operational`. */
  authors?: RemoteAuthorSigners;
  /**
   * Close the connections to the signer, once the signers are no longer used:
   * each connection once, whether payers and authors share it or not, and with
   * it those of the signers derived from these with `connect()`. Calling it
   * again does nothing.
   */
  destroy(): void;
}

/** Author keys of an external signer; see the module comment. */
export class RemoteAuthorSigners implements ExternalAuthorSigners {
  readonly defaultAuthor?: AuthorSigner;
  readonly #client: RemoteSignerClient;
  readonly #provider: Provider | null;
  readonly #payers: ReadonlySet<string>;
  /** Only the default author when authors share the payers' connection. */
  readonly #defaultOnly: boolean;
  #accounts: readonly string[];

  constructor(init: {
    client: RemoteSignerClient;
    accounts: readonly string[];
    payers: readonly string[];
    defaultAuthor?: string;
    defaultOnly: boolean;
    provider: Provider | null;
  }) {
    this.#client = init.client;
    this.#provider = init.provider;
    this.#payers = new Set(init.payers);
    this.#defaultOnly = init.defaultOnly;
    this.#accounts = init.accounts.filter((address) => !this.#payers.has(address));
    if (init.defaultAuthor !== undefined) {
      this.defaultAuthor = new RemoteSigner(init.defaultAuthor, init.client, init.provider);
    }
  }

  /** Host-only description of the endpoint serving the author keys. */
  get endpoint(): string {
    return this.#client.endpoint;
  }

  /** Author accounts known so far (refreshed when an unknown address is asked for). */
  get addresses(): readonly string[] {
    return this.#defaultOnly ? (this.defaultAuthor ? [this.defaultAuthor.address] : []) : this.#accounts;
  }

  async signerFor(address: string): Promise<AuthorSigner | undefined> {
    return (await this.firstSignerOf([address]))?.signer;
  }

  /**
   * The first of `addresses`, in order, that is an author key. The accounts are
   * asked for again at most once per call, and only when an address before
   * the first known author is unknown: keys added to the signer after startup
   * become usable without a restart, and the selection keeps its order.
   */
  async firstSignerOf(addresses: readonly string[]): Promise<{ address: string; signer: AuthorSigner } | undefined> {
    const candidates: Array<{ address: string; target: string }> = [];
    for (const address of addresses) {
      let target: string;
      try {
        target = getAddress(address);
      } catch {
        continue;
      }
      if (!this.#payers.has(target)) candidates.push({ address, target });
    }
    let refreshed = false;
    for (const { address, target } of candidates) {
      if (!refreshed && !this.#defaultOnly && !this.#isAuthor(target)) {
        refreshed = true;
        const served = await this.#client.listAccounts();
        this.#accounts = served.filter((account) => !this.#payers.has(account));
      }
      if (this.#isAuthor(target)) return { address, signer: this.#signerOf(target) };
    }
    return undefined;
  }

  #isAuthor(address: string): boolean {
    return this.defaultAuthor?.address === address || (!this.#defaultOnly && this.#accounts.includes(address));
  }

  #signerOf(address: string): AuthorSigner {
    return this.defaultAuthor?.address === address
      ? this.defaultAuthor
      : new RemoteSigner(address, this.#client, this.#provider);
  }
}

/**
 * Ask the signer for its accounts and build the payer and author signers. The
 * result owns the connections it opened (see {@link RemoteSigners.destroy});
 * when the signer cannot be used, they are closed before the error is thrown.
 */
export async function connectRemoteSigners(options: ConnectRemoteSignersOptions): Promise<RemoteSigners> {
  const connections = new SignerConnections();
  try {
    const signers = await discoverSigners(options, connections);
    return { ...signers, destroy: () => connections.close() };
  } catch (err) {
    connections.close();
    throw err;
  }
}

/** The clients opened for one set of signers, each closed once. */
class SignerConnections {
  readonly #clients = new Set<RemoteSignerClient>();
  #closed = false;

  open(options: RemoteSignerClientOptions): RemoteSignerClient {
    const client = new RemoteSignerClient(options);
    this.#clients.add(client);
    return client;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const client of this.#clients) client.destroy();
  }
}

async function discoverSigners(
  options: ConnectRemoteSignersOptions,
  connections: SignerConnections,
): Promise<Omit<RemoteSigners, 'destroy'>> {
  const provider = options.provider ?? null;
  const client = connections.open(options);
  const served = await client.listAccounts();
  const filter = normalizeAddresses(options.addresses, 'addresses');
  if (filter !== undefined) requireServed(client, served, filter, 'the configured addresses');
  const defaultAuthor = normalizeAddresses(
    options.author?.address === undefined ? undefined : [options.author.address],
    'author.address',
  )?.[0];

  let authors: { client: RemoteSignerClient; accounts: readonly string[]; defaultOnly: boolean } | undefined;
  if (options.author !== undefined) {
    const author = options.author;
    const ownEndpoint = author.url !== undefined || author.socketPath !== undefined;
    if (!ownEndpoint && author.authToken === undefined) {
      if (defaultAuthor === undefined) {
        throw configError('author needs an address, or its own url, socketPath or auth token');
      }
      requireServed(client, served, [defaultAuthor], 'the author address');
      authors = { client, accounts: [defaultAuthor], defaultOnly: true };
    } else {
      const authorClient = connections.open({
        api: options.api,
        timeoutMs: options.timeoutMs,
        ...(ownEndpoint
          ? { url: author.url, socketPath: author.socketPath }
          : { url: options.url, socketPath: options.socketPath }),
        authToken: author.authToken ?? options.authToken,
      });
      authors = { client: authorClient, accounts: await authorClient.listAccounts(), defaultOnly: false };
      if (authors.accounts.length === 0) {
        throw new RemoteSignerError(
          'REMOTE_SIGNER_ADDRESS_NOT_AVAILABLE',
          `The author signer at ${authorClient.endpoint} serves no account`,
          { endpoint: authorClient.endpoint },
        );
      }
    }
  }

  const authorAccounts = new Set(authors?.accounts ?? []);
  const overlap = filter?.filter((address) => authorAccounts.has(address)) ?? [];
  if (overlap.length > 0) {
    throw configError(`author accounts must not also be payer addresses: ${overlap.join(', ')}`);
  }
  const payers = (filter ?? served).filter((address) => !authorAccounts.has(address));
  if (payers.length === 0) {
    throw new RemoteSignerError(
      'REMOTE_SIGNER_ADDRESS_NOT_AVAILABLE',
      `Remote signer at ${client.endpoint} serves no payer account` +
        (authors === undefined ? '' : ' that is not an author account'),
      { endpoint: client.endpoint },
    );
  }

  let resolvedDefault = defaultAuthor;
  if (authors !== undefined && !authors.defaultOnly) {
    const authorAccountList = authors.accounts.filter((address) => !payers.includes(address));
    if (resolvedDefault !== undefined) {
      requireServed(authors.client, authorAccountList, [resolvedDefault], 'the author address');
    } else if (authorAccountList.length === 1) {
      resolvedDefault = authorAccountList[0];
    }
  }
  return {
    operational: payers.map((address) => new RemoteSigner(address, client, provider)),
    ...(authors === undefined ? {} : {
      authors: new RemoteAuthorSigners({
        client: authors.client,
        accounts: authors.accounts,
        payers,
        ...(resolvedDefault === undefined ? {} : { defaultAuthor: resolvedDefault }),
        defaultOnly: authors.defaultOnly,
        provider,
      }),
    }),
  };
}

function requireServed(
  client: RemoteSignerClient,
  served: readonly string[],
  wanted: readonly string[],
  what: string,
): void {
  const missing = wanted.filter((address) => !served.includes(address));
  if (missing.length > 0) {
    throw new RemoteSignerError(
      'REMOTE_SIGNER_ADDRESS_NOT_AVAILABLE',
      `Remote signer at ${client.endpoint} does not serve ${what}: ${missing.join(', ')}`,
      { endpoint: client.endpoint },
    );
  }
}

function normalizeAddresses(values: readonly string[] | undefined, label: string): string[] | undefined {
  if (values === undefined) return undefined;
  const out: string[] = [];
  for (const value of values) {
    let address: string;
    try {
      address = getAddress(value);
    } catch {
      throw configError(`${label} contains an invalid address`);
    }
    if (!out.includes(address)) out.push(address);
  }
  if (out.length === 0) throw configError(`${label} must not be empty`);
  return out;
}

function configError(message: string): RemoteSignerError {
  return new RemoteSignerError('REMOTE_SIGNER_CONFIG', `Invalid remote signer configuration: ${message}`);
}
