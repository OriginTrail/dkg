// SPDX-License-Identifier: Apache-2.0
/**
 * In-process stand-in for an external JSON-RPC signer (Web3Signer-style `eth`
 * dialect or Clef-style `account` dialect), served over HTTP or HTTPS on
 * loopback, or over HTTP on a unix domain socket. NOT a test file.
 *
 * Accounts are scoped by bearer credential, as a multi-tenant signing service
 * would scope them: each credential maps to its own key set. The server signs
 * exactly what it is asked to sign (it never fills nonce, gas or fees) and
 * records every request so tests can assert on what the node sent.
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
}

export interface FakeSigner {
  readonly url?: string;
  readonly socketPath?: string;
  readonly requests: FakeSignerRequest[];
  /** Requests for one JSON-RPC method. */
  calls(method: string): FakeSignerRequest[];
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
          const { result, wallet } = await answer(api, method, params, walletsOf(credential.keys));
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
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
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
): Promise<{ result: unknown; wallet?: ethers.Wallet }> {
  const byAddress = (value: unknown): ethers.Wallet => {
    const wallet = typeof value === 'string' && ethers.isAddress(value)
      ? wallets.find((entry) => entry.address.toLowerCase() === value.toLowerCase())
      : undefined;
    if (!wallet) throw new Error('unknown account');
    return wallet;
  };
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
