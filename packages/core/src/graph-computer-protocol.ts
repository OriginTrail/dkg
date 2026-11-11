import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalizeJson, type CanonicalJsonValue } from './canonical-json.js';

const utf8 = new TextEncoder();
export const protocolSha256 = (value: string | Uint8Array): string => bytesToHex(sha256(typeof value === 'string' ? utf8.encode(value) : value));

/** Browser-safe canonical input snapshot used by signed v4 requests and retry handles. */
export function canonicalProgramInputs(value: unknown): string {
  if (!Array.isArray(value)) throw new TypeError('inputs must be a JSON array');
  return canonicalizeJson(value as CanonicalJsonValue, { maxBytes: 65536, maxDepth: 20 });
}

export function boundOperationInvocationScope(request: {
  version: 3 | 4; contextGraphId: string; operationIri: string; invocationId: string; inputs?: unknown[];
}, targetPeerId: string): string {
  return `dkg.semantic-runtime.bound-operation.v${request.version}:` + protocolSha256(JSON.stringify([
    request.version, 'bound-operation', request.contextGraphId, request.operationIri, request.invocationId.toLowerCase(), targetPeerId,
    ...(request.version === 4 ? [protocolSha256(canonicalProgramInputs(request.inputs))] : []),
  ]));
}

export const AGENT_DELEGATION_ABI_TYPES = ['string', 'string', 'address', 'string', 'string', 'uint256', 'uint256'] as const;
export function agentDelegationAbiValues(payload: {
  agentAddress: string; scope: string; issuedAtMs: number; expiresAtMs?: number; delegateePeerId?: string; delegateeOpKey?: string;
}): Array<string | number> {
  return ['dkg.agent-delegation.v2', payload.scope, payload.agentAddress.toLowerCase(), payload.delegateePeerId ?? '',
    payload.delegateeOpKey?.toLowerCase() ?? '', Math.trunc(payload.issuedAtMs), Math.trunc(payload.expiresAtMs ?? 0)];
}

export interface AgentHttpSigningInput {
  agentAddress: string; targetPeerId: string; method: string; path: string;
  contentType: string; body: Uint8Array; timestamp: string; nonce: string;
}
/** Exact HTTP wire preimage. Callers retain address checksum validation and signer custody. */
export function agentHttpRequestSigningMessage(input: AgentHttpSigningInput): string {
  if (!/^0x[0-9a-f]{40}$/i.test(input.agentAddress) || !/^[A-Z]+$/.test(input.method)
    || !input.path.startsWith('/') || input.path.startsWith('//') || /[\r\n#]/.test(input.path)
    || !input.targetPeerId || /[\r\n]/.test(input.targetPeerId + input.contentType)
    || !/^(0|[1-9][0-9]{0,15})$/.test(input.timestamp) || !Number.isSafeInteger(Number(input.timestamp))
    || !/^[0-9a-f]{32,64}$/.test(input.nonce)) throw new Error('Invalid agent HTTP signing input');
  return JSON.stringify(['DKG-HTTP-REQUEST-V1', input.agentAddress.toLowerCase(), input.targetPeerId,
    input.method, input.path, input.contentType, protocolSha256(input.body), input.timestamp, input.nonce]);
}
