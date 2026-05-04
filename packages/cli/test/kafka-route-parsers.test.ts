import { describe, expect, it } from 'vitest';
import {
  hasAnyKafkaCredentials,
  KafkaRequestParseError,
  parseSasl,
  parseSecurityProtocol,
  parseSsl,
  shouldProbe,
  validateKafkaAuthConsistency,
  type KafkaEndpointRequestBody,
  type KafkaEndpointVerifyRequestBody,
} from '../src/daemon/parsers/kafka-request.js';

// These tests pin the route-level input gate that decides whether the
// opportunistic probe runs. The slice's UX promise: a request with a
// genuinely-absent `sasl` / `ssl` field results in `verificationStatus:
// "unattempted"`, but a present-but-malformed block produces a HTTP 400 so
// the caller is never silently downgraded into an unverified KA.

describe('parseSecurityProtocol', () => {
  it('uppercases and accepts the four supported protocols', () => {
    expect(parseSecurityProtocol('plaintext')).toBe('PLAINTEXT');
    expect(parseSecurityProtocol('sasl_plaintext')).toBe('SASL_PLAINTEXT');
    expect(parseSecurityProtocol('SASL_SSL')).toBe('SASL_SSL');
    expect(parseSecurityProtocol('SSL')).toBe('SSL');
  });

  it('returns undefined for unknown protocols and non-strings', () => {
    expect(parseSecurityProtocol('PLAINTEX')).toBeUndefined();
    expect(parseSecurityProtocol('rot13')).toBeUndefined();
    expect(parseSecurityProtocol(0)).toBeUndefined();
    expect(parseSecurityProtocol(undefined)).toBeUndefined();
  });
});

describe('parseSasl', () => {
  it('returns undefined when the field is genuinely absent', () => {
    expect(parseSasl(undefined)).toBeUndefined();
    expect(parseSasl(null)).toBeUndefined();
  });

  it('throws on a non-object value', () => {
    expect(() => parseSasl('plain')).toThrow(KafkaRequestParseError);
    expect(() => parseSasl('plain')).toThrow(/"sasl" must be an object/);
    expect(() => parseSasl(42)).toThrow(KafkaRequestParseError);
    expect(() => parseSasl([])).toThrow(KafkaRequestParseError);
  });

  it('throws on missing username or password', () => {
    expect(() => parseSasl({ password: 'p' })).toThrow(/"sasl.username"/);
    expect(() => parseSasl({ username: 'a' })).toThrow(/"sasl.password"/);
  });

  it('throws on empty / whitespace username', () => {
    expect(() => parseSasl({ username: '', password: 'p' })).toThrow(
      /"sasl.username" must be a non-empty string/,
    );
    expect(() => parseSasl({ username: '   ', password: 'p' })).toThrow(
      /"sasl.username"/,
    );
  });

  it('throws on empty / whitespace password', () => {
    expect(() => parseSasl({ username: 'a', password: '' })).toThrow(
      /"sasl.password" must be a non-empty string/,
    );
    expect(() => parseSasl({ username: 'a', password: '   ' })).toThrow(
      /"sasl.password"/,
    );
  });

  it('throws on an unknown mechanism, listing the valid alternatives', () => {
    const fn = () =>
      parseSasl({ mechanism: 'totp', username: 'a', password: 'p' });
    expect(fn).toThrow(KafkaRequestParseError);
    expect(fn).toThrow(/plain, scram-sha-256, scram-sha-512/);
  });

  it('throws on a non-string mechanism', () => {
    expect(() =>
      parseSasl({ mechanism: 42, username: 'a', password: 'p' }),
    ).toThrow(/"sasl.mechanism" must be a string/);
  });

  it('error messages never echo the credential value', () => {
    // Defence in depth: even if the message contained the field name, it
    // must never contain the supplied secret.
    try {
      parseSasl({ username: 'CRED-MARKER-USER', password: '' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(KafkaRequestParseError);
      expect((err as Error).message).not.toContain('CRED-MARKER-USER');
    }
    try {
      parseSasl({ username: 'a', password: 'CRED-MARKER-PASS' });
    } catch {
      // intentionally empty: this branch should not trigger because
      // "CRED-MARKER-PASS" is non-empty and therefore valid.
    }
  });

  it('defaults mechanism to plain and lowercases user input', () => {
    expect(parseSasl({ username: 'a', password: 'p' })).toEqual({
      mechanism: 'plain',
      username: 'a',
      password: 'p',
    });
    expect(
      parseSasl({ mechanism: 'SCRAM-SHA-256', username: 'a', password: 'p' }),
    ).toEqual({ mechanism: 'scram-sha-256', username: 'a', password: 'p' });
  });
});

describe('parseSsl', () => {
  it('returns undefined when the field is genuinely absent', () => {
    expect(parseSsl(undefined)).toBeUndefined();
    expect(parseSsl(null)).toBeUndefined();
  });

  it('throws on a non-object value', () => {
    expect(() => parseSsl('PEM')).toThrow(KafkaRequestParseError);
    expect(() => parseSsl('PEM')).toThrow(/"ssl" must be an object/);
    expect(() => parseSsl([])).toThrow(KafkaRequestParseError);
  });

  it('returns undefined for an empty object (caller intent: no SSL block)', () => {
    expect(parseSsl({})).toBeUndefined();
  });

  it('throws on a non-string `ca`', () => {
    expect(() => parseSsl({ ca: 12345 })).toThrow(/"ssl.ca" must be a non-empty string/);
  });

  it('throws on an empty / whitespace `ca`', () => {
    expect(() => parseSsl({ ca: '' })).toThrow(/"ssl.ca"/);
    expect(() => parseSsl({ ca: '   ' })).toThrow(/"ssl.ca"/);
  });

  it('throws on a non-string `cert`, `key`, `caPath`, `certPath`, or `keyPath`', () => {
    expect(() => parseSsl({ cert: 1 })).toThrow(/"ssl.cert"/);
    expect(() => parseSsl({ key: false })).toThrow(/"ssl.key"/);
    expect(() => parseSsl({ caPath: {} })).toThrow(/"ssl.caPath"/);
    expect(() => parseSsl({ certPath: 0 })).toThrow(/"ssl.certPath"/);
    expect(() => parseSsl({ keyPath: null })).toThrow(/"ssl.keyPath"/);
  });

  it('omitting a field entirely is fine — only present-but-malformed fields throw', () => {
    // A request that only sets `caPath` should pass through cleanly; the
    // other PEM/path fields are simply absent.
    const out = parseSsl({ caPath: '/etc/ca.pem' });
    expect(out).toEqual({ caPath: '/etc/ca.pem' });
  });

  it('throws on a non-boolean `rejectUnauthorized`', () => {
    expect(() => parseSsl({ rejectUnauthorized: 'true' })).toThrow(
      /"ssl.rejectUnauthorized" must be a boolean/,
    );
    expect(() => parseSsl({ rejectUnauthorized: 1 })).toThrow(
      /"ssl.rejectUnauthorized"/,
    );
  });

  it('passes through non-empty inline PEMs and paths', () => {
    const out = parseSsl({
      ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
      cert: '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----',
      key: '-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----',
      caPath: '/etc/ca.pem',
      certPath: '/etc/cert.pem',
      keyPath: '/etc/key.pem',
      rejectUnauthorized: false,
    });
    expect(out).toEqual({
      caPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
      certPem: '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----',
      keyPem: '-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----',
      caPath: '/etc/ca.pem',
      certPath: '/etc/cert.pem',
      keyPath: '/etc/key.pem',
      rejectUnauthorized: false,
    });
  });
});

describe('shouldProbe — valid inputs and explicit absences', () => {
  // These tests now use parseSasl/parseSsl results that are guaranteed valid
  // by the parser (or genuinely absent) — the old "empty creds collapse"
  // path no longer exists; empty creds throw.
  it('SASL_PLAINTEXT with valid creds → probe', () => {
    const sasl = parseSasl({ username: 'a', password: 'p' });
    const body: KafkaEndpointRequestBody = {
      contextGraphId: 'cg',
      broker: 'b',
      topic: 't',
      messageFormat: 'application/json',
      securityProtocol: 'SASL_PLAINTEXT',
      ...(sasl ? { sasl } : {}),
    };
    expect(shouldProbe(body)).toBe(true);
  });

  it('SASL_SSL with no sasl field at all → no probe', () => {
    const sasl = parseSasl(undefined);
    expect(sasl).toBeUndefined();
    const body: KafkaEndpointRequestBody = {
      contextGraphId: 'cg',
      broker: 'b',
      topic: 't',
      messageFormat: 'application/json',
      securityProtocol: 'SASL_SSL',
      ...(sasl ? { sasl } : {}),
    };
    expect(shouldProbe(body)).toBe(false);
  });

  it('SSL with no ssl field → probe (default trust store)', () => {
    // `buildSsl` (in @origintrail-official/dkg-kafka) accepts SSL with no
    // SSL block at all — the kafkajs client falls back to the platform's
    // default trust store. The gate must not be stricter than buildSsl.
    const ssl = parseSsl(undefined);
    expect(ssl).toBeUndefined();
    const body: KafkaEndpointRequestBody = {
      contextGraphId: 'cg',
      broker: 'b',
      topic: 't',
      messageFormat: 'application/json',
      securityProtocol: 'SSL',
      ...(ssl ? { ssl } : {}),
    };
    expect(shouldProbe(body)).toBe(true);
  });

  it('SSL with only caPem → probe (CA-only one-way TLS)', () => {
    const ssl = parseSsl({
      ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    });
    const body: KafkaEndpointRequestBody = {
      contextGraphId: 'cg',
      broker: 'b',
      topic: 't',
      messageFormat: 'application/json',
      securityProtocol: 'SSL',
      ...(ssl ? { ssl } : {}),
    };
    expect(shouldProbe(body)).toBe(true);
  });

  it('SSL with full mTLS material (cert+key) → probe', () => {
    const ssl = parseSsl({
      ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
      cert: '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----',
      key: '-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----',
    });
    const body: KafkaEndpointRequestBody = {
      contextGraphId: 'cg',
      broker: 'b',
      topic: 't',
      messageFormat: 'application/json',
      securityProtocol: 'SSL',
      ...(ssl ? { ssl } : {}),
    };
    expect(shouldProbe(body)).toBe(true);
  });

  it('PLAINTEXT with explicit protocol → probe (no creds needed)', () => {
    const body: KafkaEndpointRequestBody = {
      contextGraphId: 'cg',
      broker: 'b',
      topic: 't',
      messageFormat: 'application/json',
      securityProtocol: 'PLAINTEXT',
    };
    expect(shouldProbe(body)).toBe(true);
  });

  it('No securityProtocol at all → no probe', () => {
    const body: KafkaEndpointRequestBody = {
      contextGraphId: 'cg',
      broker: 'b',
      topic: 't',
      messageFormat: 'application/json',
    };
    expect(shouldProbe(body)).toBe(false);
  });
});

describe('validateKafkaAuthConsistency', () => {
  // Cross-field consistency check between `securityProtocol` and the auth
  // material. The route's per-field parsers validate each field in isolation;
  // this helper closes the protocol/credential mismatch gap so direct HTTP
  // callers cannot smuggle a SASL_SSL request without creds (or PLAINTEXT
  // with creds) past the route and silently land on `verificationStatus:
  // "unattempted"`.

  const baseBody = {
    contextGraphId: 'cg',
    broker: 'b',
    topic: 't',
    messageFormat: 'application/json',
  } as const;

  const validSasl = { mechanism: 'plain', username: 'a', password: 'p' } as const;

  it('SASL_SSL with no sasl block → throws, naming the protocol', () => {
    const body: KafkaEndpointRequestBody = {
      ...baseBody,
      securityProtocol: 'SASL_SSL',
    };
    expect(() => validateKafkaAuthConsistency(body)).toThrow(KafkaRequestParseError);
    expect(() => validateKafkaAuthConsistency(body)).toThrow(/SASL_SSL/);
    expect(() => validateKafkaAuthConsistency(body)).toThrow(/"sasl"/);
  });

  it('SASL_PLAINTEXT with no sasl block → throws, naming the protocol', () => {
    const body: KafkaEndpointRequestBody = {
      ...baseBody,
      securityProtocol: 'SASL_PLAINTEXT',
    };
    expect(() => validateKafkaAuthConsistency(body)).toThrow(KafkaRequestParseError);
    expect(() => validateKafkaAuthConsistency(body)).toThrow(/SASL_PLAINTEXT/);
  });

  it('PLAINTEXT with sasl block present → throws, naming the protocol', () => {
    const body: KafkaEndpointRequestBody = {
      ...baseBody,
      securityProtocol: 'PLAINTEXT',
      sasl: validSasl,
    };
    expect(() => validateKafkaAuthConsistency(body)).toThrow(KafkaRequestParseError);
    expect(() => validateKafkaAuthConsistency(body)).toThrow(/PLAINTEXT/);
    expect(() => validateKafkaAuthConsistency(body)).toThrow(/"sasl"/);
  });

  it('SSL with sasl block present → throws, naming the protocol', () => {
    const body: KafkaEndpointRequestBody = {
      ...baseBody,
      securityProtocol: 'SSL',
      sasl: validSasl,
    };
    expect(() => validateKafkaAuthConsistency(body)).toThrow(KafkaRequestParseError);
    expect(() => validateKafkaAuthConsistency(body)).toThrow(/SSL/);
  });

  it('SASL_SSL with valid sasl block → no throw', () => {
    const body: KafkaEndpointRequestBody = {
      ...baseBody,
      securityProtocol: 'SASL_SSL',
      sasl: validSasl,
    };
    expect(() => validateKafkaAuthConsistency(body)).not.toThrow();
  });

  it('PLAINTEXT with no sasl block → no throw', () => {
    const body: KafkaEndpointRequestBody = {
      ...baseBody,
      securityProtocol: 'PLAINTEXT',
    };
    expect(() => validateKafkaAuthConsistency(body)).not.toThrow();
  });

  it('SSL with no sasl block, optional ssl block present → no throw', () => {
    const body: KafkaEndpointRequestBody = {
      ...baseBody,
      securityProtocol: 'SSL',
      ssl: { caPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----' },
    };
    expect(() => validateKafkaAuthConsistency(body)).not.toThrow();
  });

  it('No securityProtocol declared → no throw (slice-01 wire compat)', () => {
    // Slice-01 callers can omit `securityProtocol` entirely. The route already
    // skips the probe and the KA records `verificationStatus: "unattempted"`.
    // The consistency check must not regress that path.
    const body: KafkaEndpointRequestBody = { ...baseBody };
    expect(() => validateKafkaAuthConsistency(body)).not.toThrow();
  });

  it('No securityProtocol but sasl block present → throws, naming both fields', () => {
    // Without `securityProtocol`, `shouldProbe` returns false and the route
    // would silently drop the supplied auth payload into an `unattempted` KA.
    // Reject this ambiguous misconfig at the gate so the caller sees a 400.
    const body: KafkaEndpointRequestBody = {
      ...baseBody,
      sasl: validSasl,
    };
    expect(() => validateKafkaAuthConsistency(body)).toThrow(KafkaRequestParseError);
    expect(() => validateKafkaAuthConsistency(body)).toThrow(/"sasl"/);
    expect(() => validateKafkaAuthConsistency(body)).toThrow(/"securityProtocol"/);
  });

  it('No securityProtocol but ssl block present → throws, naming both fields', () => {
    // Same silent-downgrade pattern as the sasl case: without a protocol the
    // route would skip the probe and drop the SSL material into an unverified
    // KA. Reject so the caller is forced to declare intent.
    const body: KafkaEndpointRequestBody = {
      ...baseBody,
      ssl: { caPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----' },
    };
    expect(() => validateKafkaAuthConsistency(body)).toThrow(KafkaRequestParseError);
    expect(() => validateKafkaAuthConsistency(body)).toThrow(/"ssl"/);
    expect(() => validateKafkaAuthConsistency(body)).toThrow(/"securityProtocol"/);
  });

  it('No securityProtocol and no sasl/ssl blocks → no throw (slice-01 wire compat preserved)', () => {
    // Regression guard: tightening the no-protocol branch must still permit
    // genuine slice-01 wire-compat requests that send neither auth nor TLS.
    const body: KafkaEndpointRequestBody = { ...baseBody };
    expect(() => validateKafkaAuthConsistency(body)).not.toThrow();
  });
});

describe('hasAnyKafkaCredentials — verify-route precondition gate', () => {
  // ADR 0002: verify with no creds is meaningless. The route uses this
  // helper to reject early with a 400.
  const baseBody: KafkaEndpointVerifyRequestBody = {
    uri: 'urn:dkg:kafka-endpoint:owner:hash',
  };

  it('false when neither sasl nor ssl nor explicit PLAINTEXT', () => {
    expect(hasAnyKafkaCredentials(baseBody)).toBe(false);
  });

  it('true when SASL username + password are both present', () => {
    expect(
      hasAnyKafkaCredentials({
        ...baseBody,
        sasl: { mechanism: 'plain', username: 'alice', password: 'pw' },
      }),
    ).toBe(true);
  });

  it('false when SASL block is present but a credential is empty', () => {
    expect(
      hasAnyKafkaCredentials({
        ...baseBody,
        // Note the parser would normally drop these to undefined; we test the
        // helper directly to pin the inner check.
        sasl: { mechanism: 'plain', username: '', password: 'pw' },
      }),
    ).toBe(false);
  });

  it('true when an SSL inline PEM is present (any of caPem/certPem/keyPem)', () => {
    expect(
      hasAnyKafkaCredentials({
        ...baseBody,
        ssl: { caPem: 'pem' },
      }),
    ).toBe(true);
  });

  it('true when an SSL filesystem path is present (any of caPath/certPath/keyPath)', () => {
    expect(
      hasAnyKafkaCredentials({
        ...baseBody,
        ssl: { keyPath: '/etc/key.pem' },
      }),
    ).toBe(true);
  });

  it('false when ssl is empty object', () => {
    expect(hasAnyKafkaCredentials({ ...baseBody, ssl: {} })).toBe(false);
  });

  it('true when securityProtocol is "PLAINTEXT" alone (probes for reachability)', () => {
    expect(
      hasAnyKafkaCredentials({
        ...baseBody,
        securityProtocol: 'PLAINTEXT',
      }),
    ).toBe(true);
  });

  it('false when only an empty securityProtocol of SSL is set without cert/key', () => {
    expect(
      hasAnyKafkaCredentials({
        ...baseBody,
        securityProtocol: 'SSL',
      }),
    ).toBe(false);
  });
});
