import { createHash, createPublicKey, verify } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { ethers } from 'ethers';

export const AGENT_HTTP_MAX_AGE_MS = 60_000;
export const AGENT_HTTP_CLOCK_SKEW_MS = 5_000;
export const AGENT_HTTP_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const AGENT_HTTP_HEADERS = 'Authorization, Content-Type';
export const AGENT_HTTP_JWT_TYPE = 'dkg-agent-http+jwt';

export interface AgentHttpRequest {
  agentAddress: string;
  method: string;
  /** The receiving node's physical peer ID, not a caller-supplied Host header. */
  targetPeerId: string;
  /** Exact origin-form request target, including the original query string. */
  path: string;
  contentType: string;
  body: Uint8Array;
  timestamp: string;
  nonce: string;
}

/** Client-side ES256K JWT. The JWK contains only the public key, never key material. */
export function signAgentHttpJwt(input: AgentHttpRequest, signingKey: ethers.SigningKey): string {
  if (ethers.computeAddress(signingKey.publicKey).toLowerCase() !== input.agentAddress.toLowerCase()) {
    throw new Error('Signing key does not match the claimed agent');
  }
  const publicBytes = Buffer.from(signingKey.publicKey.slice(4), 'hex');
  const protectedHeader = {
    alg: 'ES256K', typ: AGENT_HTTP_JWT_TYPE,
    jwk: { kty: 'EC', crv: 'secp256k1', x: publicBytes.subarray(0, 32).toString('base64url'), y: publicBytes.subarray(32).toString('base64url') },
  };
  const iat = Math.floor(Number(input.timestamp) / 1000);
  const claims = {
    iss: ethers.getAddress(input.agentAddress), aud: input.targetPeerId, iat, exp: iat + AGENT_HTTP_MAX_AGE_MS / 1000,
    jti: input.nonce, method: input.method, path: input.path, contentType: input.contentType,
    bodySha256: createHash('sha256').update(input.body).digest('hex'),
  };
  const signingInput = [protectedHeader, claims].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  // ethers uses deterministic ECDSA; JOSE ES256K uses SHA-256 and the 64-byte R || S encoding.
  const signature = signingKey.sign('0x' + createHash('sha256').update(signingInput).digest('hex'));
  return signingInput + '.' + Buffer.from(signature.r.slice(2) + signature.s.slice(2), 'hex').toString('base64url');
}

function decodeBase64Url(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64url');
  if (!/^[A-Za-z0-9_-]+$/.test(value) || bytes.toString('base64url') !== value) throw new Error('Invalid base64url');
  return bytes;
}

function exactFields(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length || fields.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('Invalid JWT fields');
  }
}

/** This profile accepts no algorithm negotiation, remote JWKs, private JWKs or generic session JWTs. */
function verifyJwt(token: string) {
  try {
    if (token.length > 4096) throw new Error('JWT too large');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid compact JWS');
    const protectedHeader: unknown = JSON.parse(decodeBase64Url(parts[0]).toString('utf8'));
    exactFields(protectedHeader, ['alg', 'typ', 'jwk']);
    if (protectedHeader.alg !== 'ES256K' || protectedHeader.typ !== AGENT_HTTP_JWT_TYPE) throw new Error('Wrong JWT type/algorithm');
    const jwk = protectedHeader.jwk;
    exactFields(jwk, ['kty', 'crv', 'x', 'y']);
    if (jwk.kty !== 'EC' || jwk.crv !== 'secp256k1' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('Wrong key type');
    const x = decodeBase64Url(jwk.x); const y = decodeBase64Url(jwk.y);
    if (x.length !== 32 || y.length !== 32) throw new Error('Wrong coordinate size');
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'secp256k1', x: jwk.x, y: jwk.y }, format: 'jwk' });
    const signature = decodeBase64Url(parts[2]);
    if (signature.length !== 64 || !verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)) {
      throw new Error('Invalid signature');
    }
    const claims: unknown = JSON.parse(decodeBase64Url(parts[1]).toString('utf8'));
    exactFields(claims, ['iss', 'aud', 'iat', 'exp', 'jti', 'method', 'path', 'contentType', 'bodySha256']);
    if (typeof claims.iss !== 'string' || !ethers.isAddress(claims.iss)
        || typeof claims.aud !== 'string' || typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat)
        || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp)
        || typeof claims.jti !== 'string' || !/^[0-9a-f]{32,64}$/.test(claims.jti)
        || typeof claims.method !== 'string' || typeof claims.path !== 'string' || typeof claims.contentType !== 'string'
        || typeof claims.bodySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(claims.bodySha256)) throw new Error('Invalid claims');
    const agentAddress = ethers.computeAddress('0x04' + x.toString('hex') + y.toString('hex'));
    if (claims.iss.toLowerCase() !== agentAddress.toLowerCase()) throw new Error('Issuer does not own public key');
    return { agentAddress, aud: claims.aud, issuedAt: claims.iat * 1000, expiresAt: claims.exp * 1000,
      nonce: claims.jti, method: claims.method, path: claims.path, contentType: claims.contentType, bodySha256: claims.bodySha256 };
  } catch {
    throw new AgentHttpAuthenticationError('AGENT_HTTP_SIGNATURE_INVALID');
  }
}

export interface AgentHttpNonceStore {
  /** Atomic and durable: true only for the first acceptance of this nonce. */
  claim(target: string, address: string, nonce: string, expiresAt: number, now: number): boolean;
}

export interface AgentHttpAuthOptions {
  targetPeerId: string;
  operatorAgentAddresses: readonly string[];
  nonces: AgentHttpNonceStore;
}

export class AgentHttpAuthenticationError extends Error {
  constructor(readonly code: string, readonly status = 401) { super(code); }
}

export function normalizeOperatorAgentAddresses(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((address) => typeof address !== 'string' || !ethers.isAddress(address))) {
    throw new Error('auth.operatorAgentAddresses must be an array of agent wallet addresses');
  }
  return Object.freeze([...new Set(value.map((address: string) => ethers.getAddress(address)))]);
}

export function hasAgentHttpCredentials(req: IncomingMessage): boolean {
  return /^DKG-Agent(?:\s|$)/i.test(req.headers.authorization ?? '');
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  const occurrences = req.rawHeaders?.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length ?? 0;
  if (typeof value !== 'string' || occurrences > 1) throw new AgentHttpAuthenticationError('AGENT_HTTP_HEADERS_INVALID');
  return value;
}

/** Complete verification before dispatch, including routes which never read their body. */
export async function authenticateAgentHttpRequest(
  req: IncomingMessage, options: AgentHttpAuthOptions,
): Promise<{ agentAddress: string; nodeOperator: boolean }> {
  const authorization = header(req, 'authorization');
  if (!authorization.startsWith('DKG-Agent ')) throw new AgentHttpAuthenticationError('AGENT_HTTP_SIGNATURE_INVALID');
  const proof = verifyJwt(authorization.slice('DKG-Agent '.length));
  const { agentAddress, issuedAt, expiresAt, nonce } = proof;
  const targetPeerId = proof.aud;
  if (!options.targetPeerId || targetPeerId !== options.targetPeerId) throw new AgentHttpAuthenticationError('AGENT_HTTP_TARGET_MISMATCH');
  const path = req.url ?? '';
  const method = req.method ?? '';
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n#]/.test(path) || !/^[A-Z]+$/.test(method)) {
    throw new AgentHttpAuthenticationError('AGENT_HTTP_TARGET_INVALID');
  }
  const contentType = req.headers['content-type'] === undefined ? '' : header(req, 'content-type');
  if (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') {
    throw new AgentHttpAuthenticationError('AGENT_HTTP_CONTENT_ENCODING_UNSUPPORTED', 415);
  }
  const fresh = () => {
    const now = Date.now();
    if (issuedAt > now + AGENT_HTTP_CLOCK_SKEW_MS || expiresAt <= now
        || expiresAt <= issuedAt || expiresAt - issuedAt > AGENT_HTTP_MAX_AGE_MS) {
      throw new AgentHttpAuthenticationError('AGENT_HTTP_EXPIRED');
    }
    return now;
  };
  fresh();
  const body = await readSignedBody(req);
  if (proof.method !== method || proof.path !== path || proof.contentType !== contentType
      || proof.bodySha256 !== createHash('sha256').update(body).digest('hex')) {
    throw new AgentHttpAuthenticationError('AGENT_HTTP_REQUEST_MISMATCH');
  }
  const now = fresh(); // A slow body must not extend the freshness window.
  let accepted: boolean;
  try { accepted = options.nonces.claim(targetPeerId, agentAddress.toLowerCase(), nonce, expiresAt, now); }
  catch { throw new AgentHttpAuthenticationError('AGENT_HTTP_NONCE_STORE_UNAVAILABLE', 503); }
  if (!accepted) throw new AgentHttpAuthenticationError('AGENT_HTTP_REPLAY');
  (req as IncomingMessage & { __dkgPrebufferedBody: Buffer }).__dkgPrebufferedBody = body;
  return {
    agentAddress,
    nodeOperator: options.operatorAgentAddresses.some((address) => address.toLowerCase() === agentAddress.toLowerCase()),
  };
}

function readSignedBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: AgentHttpAuthenticationError) => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', aborted); req.off('aborted', aborted);
      if (error) { req.resume(); reject(error); } else resolve(Buffer.concat(chunks, size));
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > AGENT_HTTP_MAX_BODY_BYTES) finish(new AgentHttpAuthenticationError('AGENT_HTTP_BODY_TOO_LARGE', 413));
      else chunks.push(bytes);
    };
    const end = () => finish();
    const aborted = () => finish(new AgentHttpAuthenticationError('AGENT_HTTP_BODY_INCOMPLETE'));
    const timer = setTimeout(() => finish(new AgentHttpAuthenticationError('AGENT_HTTP_BODY_TIMEOUT', 408)), 30_000);
    timer.unref();
    req.on('data', data); req.once('end', end); req.once('error', aborted); req.once('aborted', aborted);
    if (req.aborted || req.destroyed) aborted();
    else if (req.readableEnded) end();
  });
}
