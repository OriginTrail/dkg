import { describe, expect, it } from 'vitest';
import {
  parseSasl,
  parseSecurityProtocol,
  parseSsl,
  shouldProbe,
  type KafkaEndpointRequestBody,
} from '../src/daemon/routes/kafka.js';

// These tests pin the route-level input gate that decides whether the
// opportunistic probe runs. The slice's UX promise: a request with empty-
// string `username` / `password` / PEM material is treated as "no creds
// present" and the registration records `verificationStatus: "unattempted"`,
// not as a probe failure.

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
  it('returns undefined when value is null / non-object', () => {
    expect(parseSasl(null)).toBeUndefined();
    expect(parseSasl('plain')).toBeUndefined();
  });

  it('returns undefined when username or password is empty / blank', () => {
    expect(parseSasl({ username: 'a', password: '' })).toBeUndefined();
    expect(parseSasl({ username: '', password: 'p' })).toBeUndefined();
    expect(parseSasl({ username: '   ', password: 'p' })).toBeUndefined();
    expect(parseSasl({ username: 'a', password: '   ' })).toBeUndefined();
  });

  it('returns undefined when username or password is missing', () => {
    expect(parseSasl({ username: 'a' })).toBeUndefined();
    expect(parseSasl({ password: 'p' })).toBeUndefined();
  });

  it('returns undefined for an unknown mechanism', () => {
    expect(
      parseSasl({ mechanism: 'totp', username: 'a', password: 'p' }),
    ).toBeUndefined();
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
  it('returns undefined for null / non-object', () => {
    expect(parseSsl(null)).toBeUndefined();
    expect(parseSsl('PEM')).toBeUndefined();
  });

  it('returns undefined when every PEM/path is empty/blank', () => {
    expect(parseSsl({ ca: '', cert: '   ', key: '' })).toBeUndefined();
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

  it('drops empty fields and keeps non-empty siblings', () => {
    expect(parseSsl({ ca: '', certPath: '/etc/cert.pem' })).toEqual({
      certPath: '/etc/cert.pem',
    });
  });
});

describe('shouldProbe — empty creds collapse', () => {
  it('SASL_PLAINTEXT with empty password → no probe (parser drops the sasl block)', () => {
    // Mirrors the route's wiring: parseSasl is called first, then the gate.
    const sasl = parseSasl({ username: 'a', password: '' });
    expect(sasl).toBeUndefined();
    const body: KafkaEndpointRequestBody = {
      contextGraphId: 'cg',
      broker: 'b',
      topic: 't',
      messageFormat: 'application/json',
      securityProtocol: 'SASL_PLAINTEXT',
      ...(sasl ? { sasl } : {}),
    };
    expect(shouldProbe(body)).toBe(false);
  });

  it('SASL_SSL with empty username → no probe', () => {
    const sasl = parseSasl({ username: '', password: 'p' });
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

  it('SSL with empty cert/key PEMs → no probe', () => {
    const ssl = parseSsl({ cert: '', key: '   ' });
    expect(ssl).toBeUndefined();
    const body: KafkaEndpointRequestBody = {
      contextGraphId: 'cg',
      broker: 'b',
      topic: 't',
      messageFormat: 'application/json',
      securityProtocol: 'SSL',
      ...(ssl ? { ssl } : {}),
    };
    expect(shouldProbe(body)).toBe(false);
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

  it('SASL_PLAINTEXT with non-empty creds → probe', () => {
    const sasl = parseSasl({ username: 'a', password: 'p' });
    expect(sasl).toBeDefined();
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
});
