import type { IncomingMessage } from 'node:http';

import { ethers } from 'ethers';
import { agentHttpSigningMessage, AGENT_HTTP_HEADER_NAMES } from './agent-http-signing.js';

export const AGENT_HTTP_MAX_AGE_MS = 60_000;
export const AGENT_HTTP_CLOCK_SKEW_MS = 5_000;
export const AGENT_HTTP_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const AGENT_HTTP_HEADERS = ['Authorization', 'Content-Type', ...AGENT_HTTP_HEADER_NAMES].join(', ');

export interface AgentHttpNonceStore {
  /** Atomic and durable: true only for the first acceptance of this nonce. */
  claim(target: string, address: string, nonce: string, expiresAt: number, now: number): boolean;
}

export interface AgentHttpAuthOptions {
  targetPeerId: string;
  operatorAgentAddresses: readonly string[];
  /**
   * Whether `address` is an agent this node knows as a signer of this request, usually a registered
   * agent (custodial or self-sovereign); see `isKnownAgentKeySigner`. Only these agents and the operator
   * agents may sign requests; any other key is refused before its body is read.
   */
  isRegisteredAgent: (address: string) => boolean | Promise<boolean>;
  nonces: AgentHttpNonceStore;
}

/** The route where the recipient of an encryption enrollment signs before this node records its agent. */
export const ENCRYPTION_ENROLLMENT_ACTIVATION_PATH = '/api/agent/encryption-enrollments/activate';

/**
 * Whether this node knows `address` as a signer of a request to `path`: an agent registered here
 * (custodial or self-sovereign), or, on the enrollment activation route only, the recipient of an
 * unexpired encryption enrollment that an explicit node operator prepared here. Activation is what
 * records that recipient as an agent.
 */
export function isKnownAgentKeySigner(
  agent: {
    getLocalAgentMode(address: string): unknown;
    hasPendingEncryptionKeyEnrollment(address: string): Promise<boolean>;
  },
  address: string,
  path: string,
): boolean | Promise<boolean> {
  if (agent.getLocalAgentMode(address) !== undefined) return true;
  return path === ENCRYPTION_ENROLLMENT_ACTIVATION_PATH && agent.hasPendingEncryptionKeyEnrollment(address);
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
  return /^DKG-Agent(?:\s|$)/i.test(req.headers.authorization ?? '')
    || AGENT_HTTP_HEADER_NAMES.some((name) => req.headers[name] !== undefined);
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
  const signature = authorization.slice('DKG-Agent '.length);
  const claimedAddress = header(req, 'x-dkg-agent-address');
  const targetPeerId = header(req, 'x-dkg-agent-target');
  const timestamp = header(req, 'x-dkg-agent-timestamp');
  const nonce = header(req, 'x-dkg-agent-nonce');
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || !ethers.isAddress(claimedAddress)
      || !/^(0|[1-9][0-9]{0,15})$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))
      || !/^[0-9a-f]{32,64}$/.test(nonce)) {
    throw new AgentHttpAuthenticationError('AGENT_HTTP_SIGNATURE_INVALID');
  }
  const issuedAt = Number(timestamp);
  const expiresAt = issuedAt + AGENT_HTTP_MAX_AGE_MS;
  if (!options.targetPeerId || targetPeerId !== options.targetPeerId) throw new AgentHttpAuthenticationError('AGENT_HTTP_TARGET_MISMATCH');
  const path = req.url ?? '';
  const method = req.method ?? '';
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n#]/.test(path) || !/^[A-Z]+$/.test(method)) {
    throw new AgentHttpAuthenticationError('AGENT_HTTP_TARGET_INVALID');
  }
  // Only an agent this node knows may sign. The claimed address is checked before the body is read,
  // so an unknown key buffers no body and claims no nonce; the signature check below then proves the
  // signer is the claimed address.
  const isOperatorAgent = (address: string) =>
    options.operatorAgentAddresses.some((operator) => operator.toLowerCase() === address.toLowerCase());
  const knownAgent = async (address: string) => isOperatorAgent(address) || await options.isRegisteredAgent(address);
  if (!await knownAgent(claimedAddress)) throw new AgentHttpAuthenticationError('AGENT_HTTP_AGENT_UNKNOWN');
  const contentType = req.headers['content-type'] === undefined ? '' : header(req, 'content-type');
  if (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') {
    throw new AgentHttpAuthenticationError('AGENT_HTTP_CONTENT_ENCODING_UNSUPPORTED', 415);
  }
  const fresh = () => {
    const now = Date.now();
    if (issuedAt > now + AGENT_HTTP_CLOCK_SKEW_MS || expiresAt <= now) {
      throw new AgentHttpAuthenticationError('AGENT_HTTP_EXPIRED');
    }
    return now;
  };
  fresh();
  const body = await readSignedBody(req);
  let agentAddress: string;
  try {
    const message = agentHttpSigningMessage({ agentAddress: claimedAddress, targetPeerId, method, path, contentType, body, timestamp, nonce });
    agentAddress = ethers.verifyMessage(message, signature);
    if (agentAddress.toLowerCase() !== claimedAddress.toLowerCase()) throw new Error('Signer mismatch');
  } catch {
    throw new AgentHttpAuthenticationError('AGENT_HTTP_SIGNATURE_INVALID');
  }
  // An agent removed while its body was uploading is refused too.
  if (!await knownAgent(agentAddress)) throw new AgentHttpAuthenticationError('AGENT_HTTP_AGENT_UNKNOWN');
  const now = fresh(); // A slow body must not extend the freshness window.
  let accepted: boolean;
  try { accepted = options.nonces.claim(targetPeerId, agentAddress.toLowerCase(), nonce, expiresAt, now); }
  catch { throw new AgentHttpAuthenticationError('AGENT_HTTP_NONCE_STORE_UNAVAILABLE', 503); }
  if (!accepted) throw new AgentHttpAuthenticationError('AGENT_HTTP_REPLAY');
  (req as IncomingMessage & { __dkgPrebufferedBody: Buffer }).__dkgPrebufferedBody = body;
  return { agentAddress, nodeOperator: isOperatorAgent(agentAddress) };
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
