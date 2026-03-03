import { sha256, ed25519Sign, ed25519Verify } from '@dkg/core';
import type { SessionConfig, SessionMember, AKAEventType } from './types.js';

const encoder = new TextEncoder();

/**
 * RFC 8785 JSON Canonicalization Scheme.
 * Produces deterministic JSON by sorting keys recursively
 * and using minimal numeric representation.
 */
export function canonicalJsonEncode(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalJsonEncode(v));
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJsonEncode((value as Record<string, unknown>)[k])}`);
    return `{${pairs.join(',')}}`;
  }
  return String(value);
}

export function sha256Hex(data: Uint8Array): string {
  return Array.from(sha256(data))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function sha256String(str: string): string {
  return sha256Hex(encoder.encode(str));
}

export function computeConfigHash(config: Omit<SessionConfig, 'configHash' | 'status'>): string {
  const hashable = {
    sessionId: config.sessionId,
    paranetId: config.paranetId,
    appId: config.appId,
    createdBy: config.createdBy,
    createdAt: config.createdAt,
    membership: config.membership.map((m) => ({
      displayName: m.displayName,
      peerId: m.peerId,
      pubKey: Array.from(m.pubKey),
      role: m.role,
    })),
    membershipRoot: config.membershipRoot,
    quorumPolicy: config.quorumPolicy,
    reducer: config.reducer,
    genesisStateHash: config.genesisStateHash,
    roundTimeout: config.roundTimeout,
    maxRounds: config.maxRounds,
  };
  return sha256String(canonicalJsonEncode(hashable));
}

export function computeMembershipRoot(members: SessionMember[]): string {
  const sorted = [...members].sort((a, b) => a.peerId.localeCompare(b.peerId));
  const encoded = canonicalJsonEncode(
    sorted.map((m) => ({
      displayName: m.displayName,
      peerId: m.peerId,
      pubKey: Array.from(m.pubKey),
      role: m.role,
    })),
  );
  return sha256String(encoded);
}

export function computeSessionId(
  paranetId: string,
  creatorPeerId: string,
  createdAt: string,
  nonce: string,
): string {
  return sha256String(`${paranetId}${creatorPeerId}${createdAt}${nonce}`);
}

export function computeInputSetHash(inputs: Uint8Array[]): string {
  const encoded = canonicalJsonEncode(inputs.map((i) => Array.from(i)));
  return sha256String(encoded);
}

export function computeStateHash(stateBytes: Uint8Array): string {
  return sha256Hex(stateBytes);
}

export function computeTurnCommitment(
  sessionId: string,
  round: number,
  prevStateHash: string,
  inputSetHash: string,
  nextStateHash: string,
  reducerVersion: string,
  membershipRoot: string,
): string {
  return sha256String(
    `${sessionId}|${round}|${prevStateHash}|${inputSetHash}|${nextStateHash}|${reducerVersion}|${membershipRoot}`,
  );
}

export interface SigningContext {
  domain: string;
  network: string;
  paranetId: string;
  sessionId: string;
  round: number;
  type: AKAEventType;
}

function buildSigningPayload(context: SigningContext, payload: unknown): Uint8Array {
  const canonical = canonicalJsonEncode({
    domain: context.domain,
    network: context.network,
    paranetId: context.paranetId,
    payload,
    round: context.round,
    sessionId: context.sessionId,
    type: context.type,
  });
  return encoder.encode(canonical);
}

export async function signAKAPayload(
  context: SigningContext,
  payload: unknown,
  secretKey: Uint8Array,
): Promise<Uint8Array> {
  const message = buildSigningPayload(context, payload);
  return ed25519Sign(message, secretKey);
}

export async function verifyAKASignature(
  context: SigningContext,
  payload: unknown,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  const message = buildSigningPayload(context, payload);
  return ed25519Verify(signature, message, publicKey);
}
