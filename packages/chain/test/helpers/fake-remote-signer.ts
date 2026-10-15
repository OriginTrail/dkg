// SPDX-License-Identifier: Apache-2.0
/**
 * In-process stand-in for an external JSON-RPC signer (Web3Signer-style `eth`
 * dialect or Clef-style `account` dialect), served over HTTP or HTTPS on
 * loopback, or over HTTP on a unix domain socket. NOT a test file.
 *
 * Accounts are scoped by bearer credential, as a multi-tenant signing service
 * would scope them: each credential maps to its own key set. The server signs
 * exactly what it is asked to sign (it never fills nonce, gas or fees) and
 * records every request so tests can assert on what the node sent. It also
 * serves the optional `dkg_signSyncRequest`, `dkg_signControlObject`,
 * `dkg_signAgentDelegation` and `dkg_signJoinEncryptionKeys` methods of the
 * `eth` dialect with strict, independently written validators (list one in
 * `unsupported` to stand in for a signer without it).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { ethers } from 'ethers';

export interface FakeSignerCredential {
  /** Bearer token; omit for a credential-less signer. */
  token?: string;
  /** Private keys whose accounts this credential may use. */
  keys: readonly string[];
}

export interface FakeSignerRequest {
  method: string;
  params: unknown[];
  authorization?: string;
}

export interface FakeSignerOptions {
  credentials: readonly FakeSignerCredential[];
  api?: 'eth' | 'clef';
  /** Listen on this unix socket instead of 127.0.0.1. */
  socketPath?: string;
  /** Serve HTTPS with this certificate and key; the signer's URL is then `https://localhost:<port>`. */
  tls?: { cert: string; key: string };
  /** Methods answered with JSON-RPC -32601 (method not found). */
  unsupported?: Iterable<string>;
  /** Methods that are accepted but never answered. */
  hang?: Iterable<string>;
  /**
   * Rewrite a result before it is sent (tamper tests). Return the value to send.
   * `wallet` is the account the request was for, when there is one.
   */
  tamper?: (method: string, result: unknown, request: FakeSignerRequest, wallet?: ethers.Wallet) => unknown | Promise<unknown>;
  /** Answer a method with a JSON-RPC error instead of signing. */
  reject?: (method: string, request: FakeSignerRequest) => { code: number; message: string } | undefined;
  /** Answer with a raw HTTP response (status + body) instead of JSON-RPC. */
  rawResponse?: (method: string) => { status: number; body: string } | undefined;
  /** Further methods taking `[address, preimage]`: each derives the bytes it signs with EIP-191 from the preimage. */
  preimageMethods?: Record<string, (preimage: unknown) => Uint8Array>;
}

export interface FakeSigner {
  readonly url?: string;
  readonly socketPath?: string;
  readonly requests: FakeSignerRequest[];
  /** Requests for one JSON-RPC method. */
  calls(method: string): FakeSignerRequest[];
  /** Connections the signer currently has open. */
  openConnections(): Promise<number>;
  close(): Promise<void>;
}

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export async function startFakeRemoteSigner(options: FakeSignerOptions): Promise<FakeSigner> {
  const api = options.api ?? 'eth';
  const unsupported = new Set(options.unsupported ?? []);
  const hang = new Set(options.hang ?? []);
  const requests: FakeSignerRequest[] = [];
  // Keys are read per request so a test can add keys to a running signer.
  const walletsOf = (keys: readonly string[]) => keys.map((key) => new ethers.Wallet(key));

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        let body: { id?: unknown; method?: unknown; params?: unknown };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
          return;
        }
        const method = String(body.method);
        const params = Array.isArray(body.params) ? body.params : [];
        const authorization = req.headers.authorization;
        const request: FakeSignerRequest = { method, params, ...(authorization ? { authorization } : {}) };
        requests.push(request);
        if (hang.has(method)) return;
        const raw = options.rawResponse?.(method);
        if (raw) {
          res.writeHead(raw.status, { 'content-type': 'application/json' });
          res.end(raw.body);
          return;
        }
        const credential = options.credentials.find((entry) => (
          entry.token === undefined ? authorization === undefined : authorization === `Bearer ${entry.token}`
        ));
        if (!credential) {
          send(res, 401, { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'unauthorized' } });
          return;
        }
        if (unsupported.has(method)) {
          send(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: METHOD_NOT_FOUND, message: `the method ${method} does not exist` } });
          return;
        }
        const rejection = options.reject?.(method, request);
        if (rejection) {
          send(res, 200, { jsonrpc: '2.0', id: body.id, error: rejection });
          return;
        }
        try {
          const { result, wallet } = await answer(api, method, params, walletsOf(credential.keys), options.preimageMethods);
          const sent = options.tamper ? await options.tamper(method, result, request, wallet) : result;
          send(res, 200, { jsonrpc: '2.0', id: body.id, result: sent });
        } catch (err) {
          const thrown = (err as { code?: unknown }).code;
          const code = thrown === METHOD_NOT_FOUND || thrown === INVALID_PARAMS ? thrown : -32000;
          // Only an error's message goes back to the client, never the thrown value itself.
          send(res, 200, {
            jsonrpc: '2.0',
            id: body.id,
            error: { code, message: err instanceof Error ? err.message : 'signing failed' },
          });
        }
      })();
    });
  };
  const server: Server | HttpsServer = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handle)
    : createServer(handle);

  if (options.socketPath) {
    await new Promise<void>((resolve) => server.listen(options.socketPath, resolve));
  } else {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  }
  const address = server.address();
  return {
    ...(options.socketPath
      ? { socketPath: options.socketPath }
      : { url: options.tls ? `https://localhost:${(address as AddressInfo).port}` : `http://127.0.0.1:${(address as AddressInfo).port}` }),
    requests,
    calls: (method) => requests.filter((request) => request.method === method),
    openConnections: () => new Promise<number>((resolve, reject) => {
      server.getConnections((err, count) => (err ? reject(err) : resolve(count)));
    }),
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/**
 * The signer's open connections once a client has closed its own: closed ones
 * are gone within milliseconds, while one a client leaves open stays well past
 * this wait (an idle connection is kept for 5 s).
 */
export async function connectionsLeftOpen(signer: FakeSigner): Promise<number> {
  const deadline = Date.now() + 1_000;
  let open = await signer.openConnections();
  while (open > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    open = await signer.openConnections();
  }
  return open;
}

const SYNC_REQUEST_FIELDS = [
  'contextGraphId', 'offset', 'limit', 'includeSharedMemory', 'targetPeerId',
  'requesterPeerId', 'requestId', 'issuedAtMs', 'requesterAgentAddress',
] as const;
const BASE58_PEER_ID = /^[1-9A-HJ-NP-Za-km-z]{46,128}$/;

function invalidParams(message: string): Error {
  return Object.assign(new Error(`invalid params: ${message}`), { code: INVALID_PARAMS });
}

/**
 * A strict validator for `dkg_signSyncRequest`, written from the documented
 * request layout with ethers primitives only (it shares no code with the node):
 * every field must have its grammar, the request must be fresh, and the digest
 * is recomputed here. Returns the 32 digest bytes to sign with EIP-191.
 */
function syncRequestDigest(value: unknown): Uint8Array {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidParams('the request must be an object');
  const request = value as Record<string, unknown>;
  const authenticated = 'authPurpose' in request || 'authSelector' in request;
  const allowed = new Set<string>([...SYNC_REQUEST_FIELDS, ...(authenticated ? ['authPurpose', 'authSelector'] : [])]);
  for (const key of Object.keys(request)) if (!allowed.has(key)) throw invalidParams(`unexpected field ${key}`);
  for (const key of allowed) if (!(key in request)) throw invalidParams(`missing field ${key}`);
  const { contextGraphId, offset, limit, includeSharedMemory, targetPeerId, requesterPeerId, requestId, issuedAtMs, requesterAgentAddress } = request;
  const text = (field: unknown, name: string, pattern?: RegExp): string => {
    if (typeof field !== 'string' || field.length === 0 || field.length > 512 || (pattern && !pattern.test(field))) {
      throw invalidParams(`bad ${name}`);
    }
    return field;
  };
  const integer = (field: unknown, name: string, min: number, max: number): number => {
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < min || field > max) throw invalidParams(`bad ${name}`);
    return field;
  };
  if (typeof includeSharedMemory !== 'boolean') throw invalidParams('bad includeSharedMemory');
  if (typeof requesterAgentAddress !== 'string' || !/^(0x[0-9a-f]{40})?$/.test(requesterAgentAddress)) {
    throw invalidParams('bad requesterAgentAddress');
  }
  const issued = integer(issuedAtMs, 'issuedAtMs', 0, Number.MAX_SAFE_INTEGER);
  if (issued < Date.now() - 60_000 || issued > Date.now() + 5_000) throw invalidParams('stale or future issuedAtMs');
  const types = ['string', 'uint256', 'uint256', 'bool', 'string', 'string', 'string', 'uint256', 'string'];
  const values: unknown[] = [
    text(contextGraphId, 'contextGraphId'),
    integer(offset, 'offset', 0, Number.MAX_SAFE_INTEGER),
    integer(limit, 'limit', 1, 500),
    includeSharedMemory,
    text(targetPeerId, 'targetPeerId', BASE58_PEER_ID),
    text(requesterPeerId, 'requesterPeerId', BASE58_PEER_ID),
    text(requestId, 'requestId', /^0x[0-9a-f]{24}$/),
    issued,
    requesterAgentAddress,
  ];
  if (authenticated) {
    if (typeof request.authPurpose !== 'string' || typeof request.authSelector !== 'string'
      || request.authPurpose.length > 512 || request.authSelector.length > 512) {
      throw invalidParams('bad authPurpose or authSelector');
    }
    types.push('string', 'string');
    values.push(request.authPurpose, request.authSelector);
  }
  return ethers.getBytes(ethers.solidityPackedKeccak256(types, values));
}

const CONTROL_OBJECT_DOMAIN = 'dkg-control-object-v1\n';
const CONTROL_OBJECT_TYPES = new Set([
  'SwmAuthorInventoryHeadV1', 'AuthorCatalogHeadV1', 'AuthorCatalogBucketV1', 'AuthorCatalogDirectoryNodeV1',
  'AuthorCatalogIssuerDelegationV1', 'ContextGraphPolicyV1', 'MemberRosterV1',
]);

/** JSON text with sorted object keys and no whitespace (canonical for these objects). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A strict validator for `dkg_signControlObject`, written from the documented
 * layout with ethers primitives only: the canonical unsigned object must be an
 * allowed object type issued by the signing account, and the digest is
 * recomputed here. Returns the 32 digest bytes to sign with EIP-191.
 */
function controlObjectDigest(value: unknown, account: string): Uint8Array {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidParams('the request must be an object');
  const request = value as Record<string, unknown>;
  if (Object.keys(request).sort().join() !== 'domain,envelope') throw invalidParams('expected exactly domain and envelope');
  if (request.domain !== CONTROL_OBJECT_DOMAIN) throw invalidParams('bad domain');
  if (typeof request.envelope !== 'string' || request.envelope.length > 1_048_576) throw invalidParams('bad envelope');
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(request.envelope) as Record<string, unknown>;
  } catch {
    throw invalidParams('the envelope is not JSON');
  }
  // Re-serializing must give the same text: no duplicate keys, no other spelling.
  if (canonicalJson(envelope) !== request.envelope) throw invalidParams('the envelope is not canonical');
  if (Object.keys(envelope).sort().join() !== 'issuer,objectType,payload,signatureEvidence,signatureSuite') {
    throw invalidParams('unexpected envelope fields');
  }
  if (!CONTROL_OBJECT_TYPES.has(String(envelope.objectType))) throw invalidParams('object type not allowed');
  if (envelope.issuer !== account.toLowerCase()) throw invalidParams('the issuer is not the signing account');
  if (envelope.signatureSuite !== 'eip191-personal-sign-digest-v1') throw invalidParams('bad signature suite');
  if (canonicalJson(envelope.signatureEvidence) !== '{"kind":"none"}') throw invalidParams('bad signature evidence');
  return ethers.getBytes(ethers.sha256(ethers.toUtf8Bytes(CONTROL_OBJECT_DOMAIN + request.envelope)));
}

function exactObject(value: unknown, members: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidParams('the request must be an object');
  if (Object.keys(value).sort().join() !== [...members].sort().join()) throw invalidParams(`expected exactly ${members.join(', ')}`);
  return value as Record<string, unknown>;
}

function peerIdOrEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || (value !== '' && !BASE58_PEER_ID.test(value))) throw invalidParams(`bad ${name}`);
  return value;
}

/**
 * A strict validator for `dkg_signAgentDelegation`, written from the documented
 * layout with ethers primitives only. Returns the 32 digest bytes to sign.
 */
function agentDelegationDigest(value: unknown, account: string): Uint8Array {
  const request = exactObject(value, ['scope', 'agentAddress', 'delegateePeerId', 'delegateeOpKey', 'issuedAtMs', 'expiresAtMs']);
  if (request.agentAddress !== account.toLowerCase()) throw invalidParams('the agent is not the signing account');
  if (typeof request.scope !== 'string' || !/^sync:deployment=[^:]+:.+$/.test(request.scope) || request.scope.length > 512) {
    throw invalidParams('bad scope');
  }
  const peer = peerIdOrEmpty(request.delegateePeerId, 'delegateePeerId');
  if (typeof request.delegateeOpKey !== 'string' || !/^(0x[0-9a-f]{40})?$/.test(request.delegateeOpKey)) throw invalidParams('bad delegateeOpKey');
  if (peer === '' && request.delegateeOpKey === '') throw invalidParams('no delegatee');
  const issued = request.issuedAtMs;
  const expires = request.expiresAtMs;
  if (typeof issued !== 'number' || !Number.isSafeInteger(issued) || Math.abs(issued - Date.now()) > 60_000) throw invalidParams('bad issuedAtMs');
  if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || (expires !== 0 && expires <= issued)) throw invalidParams('bad expiresAtMs');
  return ethers.getBytes(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['string', 'string', 'address', 'string', 'string', 'uint256', 'uint256'],
    ['dkg.agent-delegation.v2', request.scope, request.agentAddress, peer, request.delegateeOpKey, issued, expires],
  )));
}

function framedProofPayload(agentAddress: string, publicKey: Uint8Array): Uint8Array {
  const field = (bytes: Uint8Array) => ethers.concat([ethers.toBeHex(bytes.length, 4), bytes]);
  const text = (value: string) => field(ethers.toUtf8Bytes(value));
  return ethers.getBytes(ethers.concat([
    text('domain'), text('dkg.workspace.agent-encryption-key-proof.v1'),
    text('agentAddress'), text(agentAddress),
    text('encryptionKeyAlgorithm'), text('X25519'),
    text('publicEncryptionKey'), field(publicKey),
  ]));
}

/**
 * A strict validator for `dkg_signJoinEncryptionKeys`: each key in the bundle
 * must be bound to the signing account by its own proof, and the bundle text
 * must be canonical. Returns the 32 digest bytes to sign.
 */
function joinEncryptionKeysDigest(value: unknown, account: string): Uint8Array {
  const request = exactObject(value, ['agentAddress', 'delegateePeerId', 'delegationSignature', 'workspaceEncryptionKeys']);
  const agent = account.toLowerCase();
  if (request.agentAddress !== agent) throw invalidParams('the agent is not the signing account');
  const peer = peerIdOrEmpty(request.delegateePeerId, 'delegateePeerId');
  if (typeof request.delegationSignature !== 'string' || !/^0x[0-9a-f]{130}$/.test(request.delegationSignature)) {
    throw invalidParams('bad delegationSignature');
  }
  if (typeof request.workspaceEncryptionKeys !== 'string') throw invalidParams('bad workspaceEncryptionKeys');
  let keys: unknown;
  try {
    keys = JSON.parse(request.workspaceEncryptionKeys);
  } catch {
    throw invalidParams('workspaceEncryptionKeys is not JSON');
  }
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 8) throw invalidParams('bad key count');
  const entries = keys.map((key) => {
    const entry = exactObject(key, ['encryptionKeyAlgorithm', 'publicEncryptionKey', 'encryptionKeyProof']);
    if (entry.encryptionKeyAlgorithm !== 'X25519' || typeof entry.publicEncryptionKey !== 'string' || typeof entry.encryptionKeyProof !== 'string') {
      throw invalidParams('bad key');
    }
    const publicKey = new Uint8Array(Buffer.from(entry.publicEncryptionKey, 'base64url'));
    if (publicKey.length !== 32) throw invalidParams('bad key length');
    if (ethers.verifyMessage(framedProofPayload(agent, publicKey), entry.encryptionKeyProof).toLowerCase() !== agent) {
      throw invalidParams('a key is not bound to the signing account');
    }
    return JSON.stringify({ encryptionKeyAlgorithm: entry.encryptionKeyAlgorithm, publicEncryptionKey: entry.publicEncryptionKey, encryptionKeyProof: entry.encryptionKeyProof });
  });
  if (`[${[...entries].sort().join(',')}]` !== request.workspaceEncryptionKeys) throw invalidParams('workspaceEncryptionKeys is not canonical');
  return ethers.getBytes(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['string', 'address', 'string', 'string', 'string'],
    ['dkg.join-encryption-keys.v1', agent, peer, request.delegationSignature, request.workspaceEncryptionKeys],
  )));
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function answer(
  api: 'eth' | 'clef',
  method: string,
  params: unknown[],
  wallets: readonly ethers.Wallet[],
  preimageMethods: FakeSignerOptions['preimageMethods'],
): Promise<{ result: unknown; wallet?: ethers.Wallet }> {
  const byAddress = (value: unknown): ethers.Wallet => {
    const wallet = typeof value === 'string' && ethers.isAddress(value)
      ? wallets.find((entry) => entry.address.toLowerCase() === value.toLowerCase())
      : undefined;
    if (!wallet) throw new Error('unknown account');
    return wallet;
  };
  const derive = preimageMethods?.[method];
  if (derive) {
    const wallet = byAddress(params[0]);
    return { result: await wallet.signMessage(derive(params[1])), wallet };
  }
  switch (`${api}:${method}`) {
    case 'eth:eth_accounts':
    case 'clef:account_list':
      return { result: wallets.map((wallet) => wallet.address) };
    case 'eth:eth_signTransaction':
    case 'clef:account_signTransaction': {
      const tx = params[0] as Record<string, string | undefined>;
      const wallet = byAddress(tx.from);
      if (tx.nonce === undefined || tx.gas === undefined) throw new Error('nonce and gas are required');
      // Like Clef outside its advanced mode: a recipient without a valid EIP-55
      // checksum is a validation warning, and a warning refuses the request.
      if (api === 'clef' && tx.to !== undefined && tx.to !== ethers.getAddress(tx.to)) {
        throw new Error('validation failed: Invalid checksum on recipient address');
      }
      const raw = await wallet.signTransaction({
        to: tx.to ?? null,
        nonce: Number(BigInt(tx.nonce)),
        gasLimit: BigInt(tx.gas),
        value: BigInt(tx.value ?? '0x0'),
        data: tx.data ?? tx.input ?? '0x',
        chainId: BigInt(tx.chainId ?? '0x0'),
        ...(tx.maxFeePerGas !== undefined
          ? { type: 2, maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas ?? '0x0') }
          : { type: 0, gasPrice: BigInt(tx.gasPrice ?? '0x0') }),
      });
      return { result: api === 'clef' ? { raw, tx: { hash: ethers.Transaction.from(raw).hash } } : raw, wallet };
    }
    case 'eth:eth_signTypedData_v4':
    case 'eth:eth_signTypedData':
    case 'clef:account_signTypedData': {
      const wallet = byAddress(params[0]);
      // eth_signTypedData_v4 takes the typed data as a JSON string, while
      // eth_signTypedData (as Web3Signer documents it) and account_signTypedData
      // take it as an object.
      const asJson = method === 'eth_signTypedData_v4';
      if (asJson !== (typeof params[1] === 'string')) {
        throw Object.assign(new Error(`invalid params: ${method} takes the typed data as ${asJson ? 'a JSON string' : 'an object'}`), { code: INVALID_PARAMS });
      }
      const payload = (asJson ? JSON.parse(params[1] as string) : params[1]) as {
        domain: ethers.TypedDataDomain;
        types: Record<string, ethers.TypedDataField[]>;
        message: Record<string, unknown>;
      };
      const { EIP712Domain: _domainType, ...types } = payload.types;
      return { result: await wallet.signTypedData(payload.domain, types, payload.message), wallet };
    }
    case 'eth:eth_sign': {
      const wallet = byAddress(params[0]);
      return { result: await wallet.signMessage(ethers.getBytes(String(params[1]))), wallet };
    }
    case 'eth:dkg_signSyncRequest': {
      const wallet = byAddress(params[0]);
      return { result: await wallet.signMessage(syncRequestDigest(params[1])), wallet };
    }
    case 'eth:dkg_signControlObject': {
      const wallet = byAddress(params[0]);
      return { result: await wallet.signMessage(controlObjectDigest(params[1], wallet.address)), wallet };
    }
    case 'eth:dkg_signAgentDelegation': {
      const wallet = byAddress(params[0]);
      return { result: await wallet.signMessage(agentDelegationDigest(params[1], wallet.address)), wallet };
    }
    case 'eth:dkg_signJoinEncryptionKeys': {
      const wallet = byAddress(params[0]);
      return { result: await wallet.signMessage(joinEncryptionKeysDigest(params[1], wallet.address)), wallet };
    }
    case 'eth:personal_sign': {
      const wallet = byAddress(params[1]);
      return { result: await wallet.signMessage(ethers.getBytes(String(params[0]))), wallet };
    }
    case 'clef:account_signData': {
      if (params[0] !== 'text/plain') throw new Error('unsupported content type');
      const wallet = byAddress(params[1]);
      return { result: await wallet.signMessage(ethers.getBytes(String(params[2]))), wallet };
    }
    default:
      throw Object.assign(new Error(`the method ${method} does not exist`), { code: METHOD_NOT_FOUND });
  }
}
