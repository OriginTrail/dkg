import { describe, expect, it } from 'vitest';
import { redactRpcUrl } from '../src/ui/lib/redactRpcUrl.js';

describe('redactRpcUrl (BUG-012)', () => {
  it('returns empty string for nullish input (caller may render "" without a Field row)', () => {
    expect(redactRpcUrl(null)).toBe('');
    expect(redactRpcUrl(undefined)).toBe('');
    expect(redactRpcUrl('')).toBe('');
  });

  it('redacts QuickNode-style hex token segment', () => {
    const original = 'https://greatest-greatest-sound.base-sepolia.quiknode.pro/664a23a04122d3fa485778b9141bc92e17293c73/';
    const redacted = redactRpcUrl(original);
    expect(redacted).not.toContain('664a23a04122d3fa485778b9141bc92e17293c73');
    expect(redacted).toContain('quiknode.pro');
    expect(redacted).toContain('***');
  });

  it('redacts Infura v3 path token but keeps the version segment', () => {
    const original = 'https://mainnet.infura.io/v3/abcdef0123456789abcdef0123456789';
    const redacted = redactRpcUrl(original);
    expect(redacted).toContain('infura.io');
    expect(redacted).toContain('/v3/');
    expect(redacted).not.toContain('abcdef0123456789abcdef0123456789');
  });

  it('redacts Alchemy /v2/ path token but keeps host', () => {
    const original = 'https://eth-mainnet.alchemyapi.io/v2/abcdef0123456789abcdef0123456789';
    const redacted = redactRpcUrl(original);
    expect(redacted).toContain('alchemyapi.io');
    expect(redacted).toContain('/v2/');
    expect(redacted).not.toContain('abcdef0123456789abcdef0123456789');
  });

  it('keeps short path segments untouched (e.g. /eth, /goerli)', () => {
    const original = 'https://example.com/eth';
    const redacted = redactRpcUrl(original);
    expect(redacted).toBe('https://example.com/eth');
  });

  it('redacts `?key=` / `?token=` query parameters', () => {
    const redacted = redactRpcUrl('https://rpc.example.com/?key=abcdef0123456789');
    expect(redacted).toContain('rpc.example.com');
    expect(redacted).not.toContain('abcdef0123456789');
    expect(redacted).toMatch(/key=\*+/);
  });

  it('preserves a non-secret query parameter', () => {
    const redacted = redactRpcUrl('https://rpc.example.com/?chain=base');
    expect(redacted).toBe('https://rpc.example.com/?chain=base');
  });

  it('still scrubs hex tokens out of a malformed URL string (defence in depth)', () => {
    const malformed = 'not-a-url-664a23a04122d3fa485778b9141bc92e17293c73-trailing';
    const redacted = redactRpcUrl(malformed);
    expect(redacted).not.toContain('664a23a04122d3fa485778b9141bc92e17293c73');
  });

  it('strips HTTP basic-auth credentials baked into the URL (user:pass@host)', () => {
    const original = 'https://tenant1234:s3cr3t-shared-token@rpc.example.com/path';
    const redacted = redactRpcUrl(original);
    expect(redacted).not.toContain('s3cr3t-shared-token');
    expect(redacted).not.toContain('tenant1234');
    expect(redacted).not.toContain('@rpc.example.com');
    expect(redacted).toContain('rpc.example.com');
  });

  it('strips a username-only credential (user@host with no password) — the username alone identifies the tenant', () => {
    const original = 'https://tenantonly@rpc.example.com/v1/abcdef0123456789abcdef0123456789';
    const redacted = redactRpcUrl(original);
    expect(redacted).not.toContain('tenantonly');
    expect(redacted).not.toContain('tenantonly@');
    expect(redacted).toContain('rpc.example.com');
    expect(redacted).not.toContain('abcdef0123456789abcdef0123456789');
  });
});
