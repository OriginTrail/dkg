/**
 * Slice 06 — pure unit tests for `token-store.ts`.
 *
 * No I/O. The token-store module is intentionally pure (parse + serialize
 * + lookup); the real fs touches happen in `auth.ts`. Tests cover:
 *   - legacy-only files (every line lacks a TAB)
 *   - scoped-only files
 *   - mixed files (legacy + scoped + scoped-with-name + full record)
 *   - malformed lines (skipped, not crashing)
 *   - round-trip determinism (parse → serialize → parse)
 *   - lookup helpers (prefix collision fallback, public-record sanitization)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  parseTokenFile,
  serializeTokenStore,
  lookupTokenRecord,
  toPublicRecord,
  tokenPrefix,
  setTokenRecord,
  deleteTokenRecord,
  type TokenRecord,
} from '../src/token-store.js';

// ───────────────────────────────────────────────────────────────────────────
// parser: legacy / scoped / mixed
// ───────────────────────────────────────────────────────────────────────────

describe('parseTokenFile — legacy-only', () => {
  it('parses a single legacy token line as scopes="*"', () => {
    const { store } = parseTokenFile('legacy-token-aaaaaaaaaaaaa\n');
    expect(store.size).toBe(1);
    const r = [...store.values()][0]!;
    expect(r.fullToken).toBe('legacy-token-aaaaaaaaaaaaa');
    expect(r.scopes).toBe('*');
    expect(r.name).toBeUndefined();
    expect(r.createdAt).toBeUndefined();
    expect(r.prefix).toBe('legacy-t');
  });

  it('parses multiple legacy lines, preserves comments + blank lines', () => {
    const raw = `# DKG node API token — treat this like a password
alphalegacy-token-1aaaaaaaa

# secondary
betalegacy-token-2bbbbbbbb
`;
    const { store, preserved } = parseTokenFile(raw);
    expect(store.size).toBe(2);
    expect([...store.values()].every((r) => r.scopes === '*')).toBe(true);
    expect(preserved.length).toBe(3); // header comment, blank, secondary comment
  });
});

describe('parseTokenFile — scoped-only', () => {
  it('parses scopes from a comma-separated list', () => {
    const { store } = parseTokenFile('tk-aaaaaaaaaaaaaaaa\tkafka:endpoint:read,kafka:endpoint:write\n');
    const r = [...store.values()][0]!;
    expect(r.scopes).toEqual(['kafka:endpoint:read', 'kafka:endpoint:write']);
  });

  it('parses an explicit "*" scope as full access', () => {
    const { store } = parseTokenFile('tk-bbbbbbbbbbbbbbbb\t*\n');
    const r = [...store.values()][0]!;
    expect(r.scopes).toBe('*');
  });

  it('parses scopes + name', () => {
    const { store } = parseTokenFile('tk-cccccccccccccccc\tkafka:endpoint:read\tcatchup-bot\n');
    const r = [...store.values()][0]!;
    expect(r.scopes).toEqual(['kafka:endpoint:read']);
    expect(r.name).toBe('catchup-bot');
    expect(r.createdAt).toBeUndefined();
  });

  it('parses a full record (scopes + name + createdAt)', () => {
    const raw = 'tk-dddddddddddddddd\tkafka:endpoint:read\tcatchup-bot\t2026-05-04T12:00:00.000Z\n';
    const { store } = parseTokenFile(raw);
    const r = [...store.values()][0]!;
    expect(r.scopes).toEqual(['kafka:endpoint:read']);
    expect(r.name).toBe('catchup-bot');
    expect(r.createdAt).toBe('2026-05-04T12:00:00.000Z');
  });
});

describe('parseTokenFile — mixed', () => {
  it('parses mixed legacy + scoped lines in the same file', () => {
    const raw = `# old
legacy-aaaaaaaaaaaaaaaaaaaaa
scoped-bbbbbbbbbbbbbbbbbbbbb\tkafka:endpoint:read
named-ccccccccccccccccccccc\tkafka:endpoint:write\tcatchup
full-ddddddddddddddddddddd\t*\troot\t2026-05-04T12:00:00.000Z
`;
    const { store } = parseTokenFile(raw);
    expect(store.size).toBe(4);
    const records = [...store.values()];
    expect(records[0]!.scopes).toBe('*');
    expect(records[0]!.name).toBeUndefined();
    expect(records[1]!.scopes).toEqual(['kafka:endpoint:read']);
    expect(records[2]!.name).toBe('catchup');
    expect(records[3]!.scopes).toBe('*');
    expect(records[3]!.createdAt).toBe('2026-05-04T12:00:00.000Z');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// parser: malformed inputs
// ───────────────────────────────────────────────────────────────────────────

describe('parseTokenFile — malformed lines', () => {
  it('skips lines with empty token field, warning sink fires', () => {
    const warnings: string[] = [];
    const { store } = parseTokenFile('\tkafka:endpoint:read\nvalid-token-aaaaaaaaaaaaaaa\n', {
      onWarning: (m) => warnings.push(m),
    });
    expect(store.size).toBe(1);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('empty token');
  });

  it('skips lines with empty scopes field (token + bare TAB)', () => {
    const warnings: string[] = [];
    const { store } = parseTokenFile('tk-eeeeeeeeeeeeeeee\t\nvalid-token-bbbbbbbbbbb\n', {
      onWarning: (m) => warnings.push(m),
    });
    expect(store.size).toBe(1);
    expect(warnings[0]).toContain('bad scopes field');
  });

  it('skips lines with too many tab fields (>4)', () => {
    const warnings: string[] = [];
    const raw = 'tk-fffffffffffffffff\tkafka:endpoint:read\tname\t2026-05-04T12:00:00.000Z\textra\n';
    const { store } = parseTokenFile(raw, { onWarning: (m) => warnings.push(m) });
    expect(store.size).toBe(0);
    expect(warnings[0]).toContain('too many tab-separated fields');
  });

  it('skips lines with disallowed scope characters (whitespace/special)', () => {
    const warnings: string[] = [];
    const { store } = parseTokenFile('tk-gggggggggggggggg\tbad scope with space\n', {
      onWarning: (m) => warnings.push(m),
    });
    expect(store.size).toBe(0);
    expect(warnings[0]).toContain('bad scopes field');
  });

  it('skips lines that mix `*` with explicit scopes (privilege-escalation guard)', () => {
    const warnings: string[] = [];
    const { store } = parseTokenFile('tk-hhhhhhhhhhhhhhhh\t*,kafka:endpoint:read\n', {
      onWarning: (m) => warnings.push(m),
    });
    expect(store.size).toBe(0);
    expect(warnings[0]).toContain('bad scopes field');
  });

  it('keeps the first record on prefix collision and warns', () => {
    const warnings: string[] = [];
    const raw = `firstcollideZZZZZ\nfirstcollideQQQQQ\n`;
    const { store } = parseTokenFile(raw, { onWarning: (m) => warnings.push(m) });
    expect(store.size).toBe(1);
    expect([...store.values()][0]!.fullToken).toBe('firstcollideZZZZZ');
    expect(warnings[0]).toContain('duplicate token prefix');
  });

  it('does not crash on empty file', () => {
    const { store, preserved } = parseTokenFile('');
    expect(store.size).toBe(0);
    expect(preserved.length).toBe(0);
  });

  it('does not crash on file with only comments/blank lines', () => {
    const { store, preserved } = parseTokenFile('# just a comment\n\n# another\n');
    expect(store.size).toBe(0);
    expect(preserved.length).toBe(3);
  });

  it('handles CRLF-terminated lines', () => {
    const { store } = parseTokenFile('legacy-crlf-token-aaa\r\nscoped-crlf-bbb\tkafka:endpoint:read\r\n');
    expect(store.size).toBe(2);
    const records = [...store.values()];
    expect(records[0]!.fullToken).toBe('legacy-crlf-token-aaa');
    expect(records[1]!.scopes).toEqual(['kafka:endpoint:read']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// serializer + round-trip
// ───────────────────────────────────────────────────────────────────────────

describe('serializeTokenStore', () => {
  it('round-trips a legacy-only file byte-identically', () => {
    const raw = `# DKG node API token — treat this like a password
legacy-tok-aaaaaaaaaaaaaaaaaa
`;
    const parsed = parseTokenFile(raw);
    const out = serializeTokenStore(parsed);
    expect(out).toBe(raw);
  });

  it('round-trips a fully-formed scoped file byte-identically', () => {
    const raw = `# header
tok-aaaaaaaaaaaaaaaaaaaaa\tkafka:endpoint:read\tbot\t2026-05-04T12:00:00.000Z

# trailing comment
tok-bbbbbbbbbbbbbbbbbbbbb\t*\troot\t2026-05-04T12:01:00.000Z
`;
    const parsed = parseTokenFile(raw);
    const out = serializeTokenStore(parsed);
    expect(out).toBe(raw);
  });

  it('emits a single-field line for a `*`-scope record with no name/createdAt', () => {
    const out = serializeTokenStore({
      store: new Map([
        ['legacy-x', {
          prefix: 'legacy-x',
          fullToken: 'legacy-xxxx',
          scopes: '*' as const,
        }],
      ]),
      preserved: [],
    });
    expect(out).toBe('legacy-xxxx\n');
  });

  it('emits scopes+empty-name when only createdAt is set on a scoped record', () => {
    // Edge case: the parser exposes name=undefined, createdAt=string — the
    // serializer must keep the createdAt by emitting an empty name field
    // so the field-count survives.
    const out = serializeTokenStore({
      store: new Map([
        ['scope-on', {
          prefix: 'scope-on',
          fullToken: 'scope-on-token',
          scopes: ['kafka:endpoint:read'],
          createdAt: '2026-05-04T12:00:00.000Z',
        }],
      ]),
      preserved: [],
    });
    expect(out).toBe('scope-on-token\tkafka:endpoint:read\t\t2026-05-04T12:00:00.000Z\n');
  });

  it('round-trips an empty file', () => {
    const out = serializeTokenStore({ store: new Map(), preserved: [] });
    expect(out).toBe('');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// lookup helpers
// ───────────────────────────────────────────────────────────────────────────

describe('lookupTokenRecord', () => {
  it('returns the record for a known token', () => {
    const { store } = parseTokenFile('the-token-aaaaaaaaaaaaaa\tkafka:endpoint:read\n');
    const r = lookupTokenRecord('the-token-aaaaaaaaaaaaaa', store);
    expect(r?.fullToken).toBe('the-token-aaaaaaaaaaaaaa');
  });

  it('returns undefined for an unknown token', () => {
    const { store } = parseTokenFile('the-token-aaaaaaaaaaaaaa\n');
    expect(lookupTokenRecord('not-stored', store)).toBeUndefined();
    expect(lookupTokenRecord(undefined, store)).toBeUndefined();
  });

  it('falls back to linear scan on prefix collision', () => {
    // Force a manual store with two records sharing a prefix. The parser
    // would warn-and-skip the second; the lookup helper must still find a
    // legitimate insertion (e.g. via setTokenRecord overriding).
    const store = new Map<string, TokenRecord>();
    store.set('prefix01', { prefix: 'prefix01', fullToken: 'prefix01-XXXX', scopes: '*' });
    // Intentional second-record-with-same-prefix in a wrong key (wouldn't
    // happen via parser but represents the collision condition).
    store.set('prefix02', { prefix: 'prefix01', fullToken: 'prefix01-YYYY', scopes: ['kafka:endpoint:read'] });
    const r = lookupTokenRecord('prefix01-YYYY', store);
    expect(r?.scopes).toEqual(['kafka:endpoint:read']);
  });
});

describe('toPublicRecord', () => {
  it('drops the fullToken', () => {
    const r: TokenRecord = {
      prefix: 'pr',
      fullToken: 'long-secret-stuff',
      scopes: ['kafka:endpoint:read'],
      name: 'bot',
      createdAt: '2026-05-04T12:00:00.000Z',
    };
    const pub = toPublicRecord(r);
    expect((pub as any).fullToken).toBeUndefined();
    expect(pub.prefix).toBe('pr');
    expect(pub.scopes).toEqual(['kafka:endpoint:read']);
    expect(pub.name).toBe('bot');
    expect(pub.createdAt).toBe('2026-05-04T12:00:00.000Z');
  });

  it('elides undefined name/createdAt instead of emitting them', () => {
    const r: TokenRecord = { prefix: 'pr', fullToken: 'x', scopes: '*' };
    const pub = toPublicRecord(r);
    expect(Object.keys(pub).sort()).toEqual(['prefix', 'scopes']);
  });
});

describe('store mutation helpers', () => {
  it('setTokenRecord adds and replaces by prefix', () => {
    const store = new Map<string, TokenRecord>();
    setTokenRecord(store, { prefix: 'aa', fullToken: 'aaa-1', scopes: '*' });
    expect(store.size).toBe(1);
    setTokenRecord(store, { prefix: 'aa', fullToken: 'aaa-2', scopes: ['x:y'] });
    expect(store.size).toBe(1);
    expect(store.get('aa')!.fullToken).toBe('aaa-2');
  });

  it('deleteTokenRecord removes by prefix and reports presence', () => {
    const store = new Map<string, TokenRecord>();
    setTokenRecord(store, { prefix: 'aa', fullToken: 'aaa', scopes: '*' });
    expect(deleteTokenRecord(store, 'aa')).toBe(true);
    expect(deleteTokenRecord(store, 'aa')).toBe(false);
  });
});

describe('tokenPrefix', () => {
  it('returns the first 8 characters', () => {
    expect(tokenPrefix('abcdefghij')).toBe('abcdefgh');
  });

  it('returns the whole token if shorter than 8 chars', () => {
    expect(tokenPrefix('short')).toBe('short');
  });
});
