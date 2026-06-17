import { describe, it, expect } from 'vitest';
import { SharedModelClient } from '../../src/shared-model/client.js';
import { DailyQuota } from '../../src/shared-model/quota.js';
import { decideSharedModelAuthorization } from '../../src/shared-model/authorize.js';
import {
  encodeInvokeRequest,
  decodeInvokeRequest,
  encodeInvokeResponse,
  decodeInvokeResponse,
} from '../../src/shared-model/wire.js';

describe('shared-model MVP (offline)', () => {
  it('mock provider returns a deterministic completion (no network/key)', async () => {
    const client = new SharedModelClient();
    const out = await client.complete({ provider: 'mock', model: 'demo' }, [{ role: 'user', content: 'hello world' }]);
    expect(out.model).toBe('demo');
    expect(out.content).toContain('hello world');
  });

  it('authorizes a member, under quota, with provider + grant', () => {
    expect(
      decideSharedModelAuthorization({ enabled: true, providerConfigured: true, isMember: true, quotaOk: true, promptOk: true }),
    ).toEqual({ ok: true });
  });

  it('denies non-members, disabled grants, oversized prompts, and over-quota', () => {
    expect(decideSharedModelAuthorization({ enabled: true, providerConfigured: true, isMember: false, quotaOk: true, promptOk: true }).ok).toBe(false);
    expect(decideSharedModelAuthorization({ enabled: false, providerConfigured: true, isMember: true, quotaOk: true, promptOk: true }).ok).toBe(false);
    expect(decideSharedModelAuthorization({ enabled: true, providerConfigured: true, isMember: true, quotaOk: true, promptOk: false }).ok).toBe(false);
    expect(decideSharedModelAuthorization({ enabled: true, providerConfigured: true, isMember: true, quotaOk: false, promptOk: true }).ok).toBe(false);
    expect(decideSharedModelAuthorization({ enabled: true, providerConfigured: false, isMember: true, quotaOk: true, promptOk: true }).ok).toBe(false);
  });

  it('caps requests per member per day', () => {
    const q = new DailyQuota(2);
    expect(q.allow('member-a')).toBe(true);
    expect(q.allow('member-a')).toBe(true);
    expect(q.allow('member-a')).toBe(false);
    expect(q.allow('member-b')).toBe(true); // independent bucket
  });

  it('round-trips request and response over the wire', () => {
    const req = { contextGraphId: 'cg1', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 64 };
    expect(decodeInvokeRequest(encodeInvokeRequest(req))).toEqual({
      contextGraphId: 'cg1',
      messages: req.messages,
      maxTokens: 64,
      temperature: undefined,
    });
    const res = { ok: true, content: 'x', model: 'demo' };
    expect(decodeInvokeResponse(encodeInvokeResponse(res))).toEqual({ ok: true, content: 'x', model: 'demo', denied: undefined });
  });

  it('rejects malformed wire payloads', () => {
    expect(() => decodeInvokeRequest(new TextEncoder().encode('{"messages":[]}'))).toThrow();
    expect(() => decodeInvokeRequest(new TextEncoder().encode('{"contextGraphId":"x","messages":[{"role":"nope","content":"a"}]}'))).toThrow();
  });
});
