import type {
  SharedModelInvokeRequest,
  SharedModelInvokeResponse,
  SharedModelMessage,
  SharedModelRole,
} from './types.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const ROLES: SharedModelRole[] = ['system', 'user', 'assistant'];

export function encodeInvokeRequest(req: SharedModelInvokeRequest): Uint8Array {
  return enc.encode(JSON.stringify(req));
}

export function decodeInvokeRequest(bytes: Uint8Array): SharedModelInvokeRequest {
  const o = JSON.parse(dec.decode(bytes)) as Partial<SharedModelInvokeRequest>;
  if (!o || typeof o.contextGraphId !== 'string' || !Array.isArray(o.messages)) {
    throw new Error('invalid SharedModelInvokeRequest');
  }
  const messages: SharedModelMessage[] = o.messages.map((m) => {
    const mm = m as Partial<SharedModelMessage>;
    if (!mm || typeof mm.content !== 'string' || !ROLES.includes(mm.role as SharedModelRole)) {
      throw new Error('invalid message in SharedModelInvokeRequest');
    }
    return { role: mm.role as SharedModelRole, content: mm.content };
  });
  // `agentAddress` is OPTIONAL on the wire but, when present, must be a string;
  // a non-string claim is a malformed request (reject rather than coerce, so a
  // bogus type can never be silently dropped and then default to the union).
  if (o.agentAddress !== undefined && typeof o.agentAddress !== 'string') {
    throw new Error('invalid agentAddress in SharedModelInvokeRequest');
  }
  return {
    contextGraphId: o.contextGraphId,
    messages,
    maxTokens: typeof o.maxTokens === 'number' ? o.maxTokens : undefined,
    temperature: typeof o.temperature === 'number' ? o.temperature : undefined,
    agentAddress: o.agentAddress,
  };
}

export function encodeInvokeResponse(res: SharedModelInvokeResponse): Uint8Array {
  return enc.encode(JSON.stringify(res));
}

export function decodeInvokeResponse(bytes: Uint8Array): SharedModelInvokeResponse {
  const o = JSON.parse(dec.decode(bytes)) as Partial<SharedModelInvokeResponse>;
  if (!o || typeof o.ok !== 'boolean') throw new Error('invalid SharedModelInvokeResponse');
  return { ok: o.ok, denied: o.denied, content: o.content, model: o.model };
}
