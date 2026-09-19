import { createHash, randomBytes } from 'node:crypto';

import { ethers } from 'ethers';

export const AGENT_HTTP_HEADER_NAMES = [
  'x-dkg-agent-address', 'x-dkg-agent-target', 'x-dkg-agent-timestamp', 'x-dkg-agent-nonce',
] as const;

export interface AgentHttpRequest {
  agentAddress: string;
  /** The receiving node's physical peer ID, not its HTTP Host header. */
  targetPeerId: string;
  method: string;
  /** Exact origin-form path, including query order and percent encoding. */
  path: string;
  contentType: string;
  body: Uint8Array;
  timestamp: string;
  nonce: string;
}

/** UTF-8 JSON array, signed with Ethereum personal_sign (EIP-191 version 0x45). */
export function agentHttpSigningMessage(input: AgentHttpRequest): string {
  const address = ethers.getAddress(input.agentAddress).toLowerCase();
  if (!/^[A-Z]+$/.test(input.method) || !input.path.startsWith('/') || input.path.startsWith('//')
      || /[\r\n#]/.test(input.path) || !input.targetPeerId || /[\r\n]/.test(input.targetPeerId + input.contentType)
      || !/^(0|[1-9][0-9]{0,15})$/.test(input.timestamp) || !Number.isSafeInteger(Number(input.timestamp))
      || !/^[0-9a-f]{32,64}$/.test(input.nonce)) throw new Error('Invalid agent HTTP signing input');
  return JSON.stringify([
    'DKG-HTTP-REQUEST-V1', address, input.targetPeerId, input.method, input.path,
    input.contentType, createHash('sha256').update(input.body).digest('hex'), input.timestamp, input.nonce,
  ]);
}

function headers(input: AgentHttpRequest, signature: string): Record<string, string> {
  return {
    authorization: 'DKG-Agent ' + signature,
    'x-dkg-agent-address': ethers.getAddress(input.agentAddress),
    'x-dkg-agent-target': input.targetPeerId,
    'x-dkg-agent-timestamp': input.timestamp,
    'x-dkg-agent-nonce': input.nonce,
    ...(input.contentType ? { 'content-type': input.contentType } : {}),
  };
}

/** No token issuance: this signs just the supplied request using the caller's own key. */
export function signAgentHttpHeaders(input: AgentHttpRequest, signingKey: ethers.SigningKey): Record<string, string> {
  if (ethers.computeAddress(signingKey.publicKey).toLowerCase() !== input.agentAddress.toLowerCase()) {
    throw new Error('Signing key does not match the claimed agent');
  }
  return headers(input, signingKey.sign(ethers.hashMessage(agentHttpSigningMessage(input))).serialized);
}

export interface AgentHttpClientOptions {
  /** HTTP(S) origin, without a path, query, credentials or fragment. */
  baseUrl: string;
  targetPeerId: string;
  /** Keeps key custody with the backend, wallet or external signer. */
  signer: Pick<ethers.Signer, 'getAddress' | 'signMessage'>;
}

/** Configure a signer once. Every call, including a retry, receives a fresh signature and nonce. */
export function createAgentHttpClient(options: AgentHttpClientOptions) {
  const base = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
      || base.pathname !== '/' || base.search || base.hash || !options.targetPeerId) {
    throw new Error('Expected a node HTTP(S) origin and target peer ID');
  }
  return {
    async request(path: string, init: { method?: string; body?: string | Uint8Array; contentType?: string; signal?: AbortSignal } = {}): Promise<Response> {
      const url = new URL(path, base);
      if (url.origin !== base.origin || url.pathname + url.search !== path || url.hash) {
        throw new Error('Request path must stay on the configured node and preserve its exact encoding');
      }
      const body = typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body ?? []);
      const method = init.method ?? 'GET';
      if ((method === 'GET' || method === 'HEAD') && body.length) throw new Error('GET/HEAD cannot carry a body');
      const input: AgentHttpRequest = {
        agentAddress: await options.signer.getAddress(), targetPeerId: options.targetPeerId,
        method, path, contentType: init.contentType ?? (init.body === undefined ? '' : 'application/json'),
        body, timestamp: String(Date.now()), nonce: randomBytes(24).toString('hex'),
      };
      const signature = await options.signer.signMessage(agentHttpSigningMessage(input));
      // Do not forward authentication to redirects or silently change the signed request.
      return fetch(url, { method, headers: headers(input, signature), redirect: 'error', credentials: 'omit',
        signal: init.signal, ...(method === 'GET' || method === 'HEAD' ? {} : { body }) });
    },
  };
}
