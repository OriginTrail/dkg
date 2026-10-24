// SPDX-License-Identifier: Apache-2.0

/**
 * The `chain.signer` block of a node configuration: how the node signs EVM
 * transactions. Omitted (or `{ "type": "local" }`), the node signs with the
 * operational keys in its wallet file. `{ "type": "remote", ... }` delegates
 * signing to an external JSON-RPC signer (for example an HSM-backed or a
 * separate signing service), so the node holds no operational private key.
 *
 * Only the static parts are required: `type` plus `url` or `socketPath`, and
 * usually `authTokenFile`. The operational addresses are learned from the
 * signer at startup; `addresses` only narrows them down.
 */
import { readFile, stat } from 'node:fs/promises';
import type { Provider } from 'ethers';
import { connectRemoteSigners, type RemoteSigners } from './remote-signer-connect.js';
import { RemoteSignerError } from './remote-signer-errors.js';
import type { RemoteSignerApi } from './remote-signer.js';
import { MAX_REMOTE_SIGNER_TIMEOUT_MS } from './remote-signer-transport.js';

export interface LocalChainSignerConfig {
  type: 'local';
}

interface RemoteSignerCredentialConfig {
  /** File holding the bearer token (trimmed). Keep it readable by the node user only. */
  authTokenFile?: string;
  /** Name of an environment variable holding the bearer token. */
  authTokenEnv?: string;
}

export interface RemoteChainSignerAuthorConfig extends RemoteSignerCredentialConfig {
  /**
   * Default author for requests that name no agent. Without its own endpoint or
   * credential it is one of the main signer's accounts, reserved for authoring.
   */
  address?: string;
  /** A separate signer endpoint serving the author keys (or set only a separate credential). */
  url?: string;
  socketPath?: string;
}

export interface RemoteChainSignerConfig extends RemoteSignerCredentialConfig {
  type: 'remote';
  /** `http(s)://` URL of the signer's JSON-RPC endpoint. */
  url?: string;
  /** Unix domain socket on which the signer serves HTTP. */
  socketPath?: string;
  /** JSON-RPC dialect: `eth` (default; Web3Signer-compatible) or `clef`. */
  api?: RemoteSignerApi;
  /** Optional filter on the signer's accounts. */
  addresses?: string[];
  /** Per-request deadline in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Author keys (owners of published assets), kept apart from the paying accounts. */
  author?: RemoteChainSignerAuthorConfig;
}

export type ChainSignerConfig = LocalChainSignerConfig | RemoteChainSignerConfig;

export interface ChainSignerSettings {
  /**
   * How the node signs EVM transactions; local keys when omitted. See
   * {@link RemoteChainSignerConfig} and the "External signer" node docs.
   */
  signer?: ChainSignerConfig;
}

/** A validated remote signer block. */
export type ResolvedRemoteSignerConfig = Readonly<RemoteChainSignerConfig & {
  author?: Readonly<RemoteChainSignerAuthorConfig>;
}>;

const REMOTE_KEYS = new Set([
  'type', 'url', 'socketPath', 'authTokenFile', 'authTokenEnv', 'api', 'addresses', 'timeoutMs', 'author',
]);
const AUTHOR_KEYS = new Set(['address', 'url', 'socketPath', 'authTokenFile', 'authTokenEnv']);
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate a raw `chain.signer` value. Returns undefined for local signing
 * (omitted or `{ "type": "local" }`); throws `REMOTE_SIGNER_CONFIG` otherwise.
 */
export function resolveChainSignerConfig(
  raw: unknown,
  label = 'chain.signer',
): ResolvedRemoteSignerConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw configError(label, 'must be an object');
  if (raw.type === 'local') {
    const extra = Object.keys(raw).filter((key) => key !== 'type');
    if (extra.length > 0) throw configError(label, `local signing takes no other settings (${extra.join(', ')})`);
    return undefined;
  }
  if (raw.type !== 'remote') throw configError(label, 'type must be "local" or "remote"');
  rejectUnknownKeys(raw, REMOTE_KEYS, label);
  const resolved: RemoteChainSignerConfig = { type: 'remote', ...endpointOf(raw, label, true) };
  Object.assign(resolved, credentialOf(raw, label));
  if (raw.api !== undefined) {
    if (raw.api !== 'eth' && raw.api !== 'clef') throw configError(label, 'api must be "eth" or "clef"');
    resolved.api = raw.api;
  }
  if (raw.addresses !== undefined) {
    if (!Array.isArray(raw.addresses) || raw.addresses.length === 0
      || !raw.addresses.every((entry) => typeof entry === 'string' && ADDRESS_PATTERN.test(entry))) {
      throw configError(label, 'addresses must be a non-empty array of 0x-prefixed 20-byte addresses');
    }
    resolved.addresses = [...raw.addresses] as string[];
  }
  if (raw.timeoutMs !== undefined) {
    const value = raw.timeoutMs;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_REMOTE_SIGNER_TIMEOUT_MS) {
      throw configError(label, `timeoutMs must be an integer between 1 and ${MAX_REMOTE_SIGNER_TIMEOUT_MS}`);
    }
    resolved.timeoutMs = value;
  }
  if (raw.author !== undefined) {
    const authorLabel = `${label}.author`;
    if (!isRecord(raw.author)) throw configError(authorLabel, 'must be an object');
    rejectUnknownKeys(raw.author, AUTHOR_KEYS, authorLabel);
    const author: RemoteChainSignerAuthorConfig = {
      ...endpointOf(raw.author, authorLabel, false),
      ...credentialOf(raw.author, authorLabel),
    };
    if (raw.author.address !== undefined) {
      if (typeof raw.author.address !== 'string' || !ADDRESS_PATTERN.test(raw.author.address)) {
        throw configError(authorLabel, 'address must be a 0x-prefixed 20-byte address');
      }
      author.address = raw.author.address;
    }
    if (Object.keys(author).length === 0) {
      throw configError(authorLabel, 'needs an address, or its own url, socketPath or auth token');
    }
    resolved.author = Object.freeze(author);
  }
  return Object.freeze(resolved);
}

export interface ConnectConfiguredRemoteSignersOptions {
  provider?: Provider | null;
  /** Environment used for `authTokenEnv` (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Receives non-fatal findings, such as an auth token file readable by other users. */
  onWarning?: (message: string) => void;
}

/** Read the configured credentials and connect to the signer(s) described by `config`. */
export async function connectConfiguredRemoteSigners(
  config: ResolvedRemoteSignerConfig,
  options: ConnectConfiguredRemoteSignersOptions = {},
): Promise<RemoteSigners> {
  const env = options.env ?? process.env;
  const authToken = await readAuthToken(config, 'chain.signer', env, options.onWarning);
  const author = config.author;
  const authorToken = author === undefined
    ? undefined
    : await readAuthToken(author, 'chain.signer.author', env, options.onWarning);
  return connectRemoteSigners({
    url: config.url,
    socketPath: config.socketPath,
    api: config.api,
    timeoutMs: config.timeoutMs,
    addresses: config.addresses,
    provider: options.provider ?? null,
    ...(authToken === undefined ? {} : { authToken }),
    ...(author === undefined ? {} : {
      author: {
        address: author.address,
        url: author.url,
        socketPath: author.socketPath,
        ...(authorToken === undefined ? {} : { authToken: authorToken }),
      },
    }),
  });
}

async function readAuthToken(
  source: RemoteSignerCredentialConfig,
  label: string,
  env: NodeJS.ProcessEnv,
  onWarning?: (message: string) => void,
): Promise<string | undefined> {
  if (source.authTokenEnv !== undefined) {
    const token = env[source.authTokenEnv]?.trim();
    if (!token) {
      throw configError(label, `authTokenEnv names ${source.authTokenEnv}, which is not set`);
    }
    return token;
  }
  if (source.authTokenFile === undefined) return undefined;
  let token: string;
  try {
    token = (await readFile(source.authTokenFile, 'utf8')).trim();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    throw configError(label, `cannot read authTokenFile ${source.authTokenFile} (${typeof code === 'string' ? code : 'error'})`);
  }
  if (token === '') throw configError(label, `authTokenFile ${source.authTokenFile} is empty`);
  if (process.platform !== 'win32' && onWarning !== undefined) {
    const { mode } = await stat(source.authTokenFile);
    if ((mode & 0o077) !== 0) {
      onWarning(`${label}.authTokenFile ${source.authTokenFile} is accessible to other users; restrict it to the node's user (chmod 600)`);
    }
  }
  return token;
}

function endpointOf(
  raw: Record<string, unknown>,
  label: string,
  required: boolean,
): { url?: string; socketPath?: string } {
  const url = optionalString(raw, 'url', label);
  const socketPath = optionalString(raw, 'socketPath', label);
  if (url !== undefined && socketPath !== undefined) throw configError(label, 'set url or socketPath, not both');
  if (required && url === undefined && socketPath === undefined) throw configError(label, 'set url or socketPath');
  if (url !== undefined && !/^https?:\/\//i.test(url)) throw configError(label, 'url must start with http:// or https://');
  return { ...(url === undefined ? {} : { url }), ...(socketPath === undefined ? {} : { socketPath }) };
}

function credentialOf(raw: Record<string, unknown>, label: string): RemoteSignerCredentialConfig {
  const authTokenFile = optionalString(raw, 'authTokenFile', label);
  const authTokenEnv = optionalString(raw, 'authTokenEnv', label);
  if (authTokenFile !== undefined && authTokenEnv !== undefined) {
    throw configError(label, 'set authTokenFile or authTokenEnv, not both');
  }
  if (authTokenEnv !== undefined && !ENV_NAME_PATTERN.test(authTokenEnv)) {
    throw configError(label, 'authTokenEnv must be an environment variable name');
  }
  return {
    ...(authTokenFile === undefined ? {} : { authTokenFile }),
    ...(authTokenEnv === undefined ? {} : { authTokenEnv }),
  };
}

function optionalString(raw: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw configError(label, `${key} must be a non-empty string`);
  return value.trim();
}

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw configError(label, `unknown setting(s): ${unknown.join(', ')}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configError(label: string, message: string): RemoteSignerError {
  return new RemoteSignerError('REMOTE_SIGNER_CONFIG', `Invalid ${label}: ${message}`);
}
