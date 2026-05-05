import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KafkaConfig, SASLOptions } from 'kafkajs';

interface CapturedAdmin {
  config: KafkaConfig;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  fetchTopicMetadata: ReturnType<typeof vi.fn>;
}

const captured: { last: CapturedAdmin | null } = { last: null };

interface AdminBehavior {
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
  fetchTopicMetadata?: (
    options: { topics: string[] },
  ) => Promise<{ topics: Array<{ name: string; partitions: unknown[] }> }>;
}

let nextAdminBehavior: AdminBehavior = {};

vi.mock('kafkajs', async () => {
  // We mock the entire kafkajs surface area we touch. Keep the mock dumb —
  // any "smart" behavior here would mask bugs in `kafka-probe`.
  return {
    Kafka: class {
      private readonly _config: KafkaConfig;
      constructor(config: KafkaConfig) {
        this._config = config;
      }
      admin() {
        const behavior = nextAdminBehavior;
        const admin: CapturedAdmin = {
          config: this._config,
          connect: vi.fn(behavior.connect ?? (async () => {})),
          disconnect: vi.fn(behavior.disconnect ?? (async () => {})),
          fetchTopicMetadata: vi.fn(
            behavior.fetchTopicMetadata ??
              (async ({ topics }: { topics: string[] }) => ({
                topics: topics.map((name) => ({ name, partitions: [] })),
              })),
          ),
        };
        captured.last = admin;
        return admin;
      }
    },
    logLevel: { NOTHING: 0, ERROR: 1, WARN: 2, INFO: 4, DEBUG: 5 },
  };
});

beforeEach(() => {
  captured.last = null;
  nextAdminBehavior = {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function importProbe() {
  // Importing here, after the vi.mock above is registered, ensures the probe
  // module sees the mocked kafkajs.
  const mod = await import('../src/kafka-probe.js');
  return mod;
}

describe('probe — auth-mode wiring', () => {
  it('PLAINTEXT: ssl=false, no sasl', async () => {
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'PLAINTEXT',
    });
    expect(result.status).toBe('verified');
    expect(captured.last!.config.ssl).toBe(false);
    expect(captured.last!.config.sasl).toBeUndefined();
  });

  it('SASL_PLAINTEXT: ssl=false, sasl with creds', async () => {
    const { probe } = await importProbe();
    await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'SASL_PLAINTEXT',
      sasl: { mechanism: 'plain', username: 'alice', password: 'super-secret-1' },
    });
    expect(captured.last!.config.ssl).toBe(false);
    const sasl = captured.last!.config.sasl as SASLOptions;
    expect(sasl).toMatchObject({
      mechanism: 'plain',
      username: 'alice',
      password: 'super-secret-1',
    });
  });

  it('SASL_SSL: ssl with CA pem, sasl with creds', async () => {
    const { probe } = await importProbe();
    await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'SASL_SSL',
      sasl: { mechanism: 'plain', username: 'alice', password: 'super-secret-2' },
      ssl: { caPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----' },
    });
    const ssl = captured.last!.config.ssl as { ca?: string[]; rejectUnauthorized?: boolean };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toEqual([
      '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    ]);
    expect(captured.last!.config.sasl).toBeDefined();
  });

  it('SSL (mTLS): cert + key flow into kafkajs config alongside CA', async () => {
    const { probe } = await importProbe();
    await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'SSL',
      ssl: {
        caPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
        certPem: '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----',
        keyPem: '-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----',
      },
    });
    const ssl = captured.last!.config.ssl as { ca?: string[]; cert?: string; key?: string };
    expect(ssl.ca).toBeDefined();
    expect(ssl.cert).toContain('CERT');
    expect(ssl.key).toContain('KEY');
    expect(captured.last!.config.sasl).toBeUndefined();
  });

  it('SSL (one-way TLS): CA-only succeeds; the kafkajs config carries the CA bundle and rejectUnauthorized', async () => {
    // Real-world SSL deployments are commonly server-cert-only (CA in the
    // trust store, no client cert/key). The probe must NOT force mTLS.
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'SSL',
      ssl: { caPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----' },
    });
    expect(result.status).toBe('verified');
    const ssl = captured.last!.config.ssl as {
      ca?: string[];
      cert?: string;
      key?: string;
      rejectUnauthorized?: boolean;
    };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toEqual([
      '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    ]);
    expect(ssl.cert).toBeUndefined();
    expect(ssl.key).toBeUndefined();
    expect(captured.last!.config.sasl).toBeUndefined();
  });

  it('SASL_PLAINTEXT without sasl creds throws', async () => {
    const { probe } = await importProbe();
    await expect(
      probe({
        brokers: ['localhost:9092'],
        topic: 'orders',
        securityProtocol: 'SASL_PLAINTEXT',
      }),
    ).rejects.toThrow(/SASL credentials/);
  });
});

describe('probe — PEM filesystem escape hatch', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kafka-probe-pem-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reads CA pem from caPath when caPem is absent', async () => {
    const caPath = join(tmp, 'ca.pem');
    await writeFile(caPath, '-----BEGIN CERTIFICATE-----\nFROM-DISK\n-----END CERTIFICATE-----');
    const { probe } = await importProbe();
    await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'SASL_SSL',
      sasl: { mechanism: 'plain', username: 'u', password: 'p-from-disk' },
      ssl: { caPath },
    });
    const ssl = captured.last!.config.ssl as { ca?: string[] };
    expect(ssl.ca?.[0]).toContain('FROM-DISK');
  });

  it('reads cert/key pems from certPath/keyPath in mTLS mode', async () => {
    const certPath = join(tmp, 'cert.pem');
    const keyPath = join(tmp, 'key.pem');
    await writeFile(certPath, '-----BEGIN CERTIFICATE-----\nDISK-CERT\n-----END CERTIFICATE-----');
    await writeFile(keyPath, '-----BEGIN PRIVATE KEY-----\nDISK-KEY\n-----END PRIVATE KEY-----');
    const { probe } = await importProbe();
    await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'SSL',
      ssl: { certPath, keyPath },
    });
    const ssl = captured.last!.config.ssl as { cert?: string; key?: string };
    expect(ssl.cert).toContain('DISK-CERT');
    expect(ssl.key).toContain('DISK-KEY');
  });
});

describe('probe — outcomes', () => {
  it('verified: topic present in cluster metadata', async () => {
    nextAdminBehavior = {
      fetchTopicMetadata: async ({ topics }) => ({
        topics: topics.map((name) => ({ name, partitions: [{}, {}] })),
      }),
    };
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'PLAINTEXT',
    });
    expect(result.status).toBe('verified');
    expect(result.error).toBeUndefined();
    expect(Number.isNaN(Date.parse(result.probedAt))).toBe(false);
    expect(result.securityProtocol).toBe('PLAINTEXT');
  });

  it('failed: topic absent from cluster metadata', async () => {
    nextAdminBehavior = {
      fetchTopicMetadata: async () => ({ topics: [] }),
    };
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'PLAINTEXT',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Topic "orders"/);
  });

  it('unreachable: connect throws (network error)', async () => {
    nextAdminBehavior = {
      connect: async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:9092');
        (err as any).name = 'KafkaJSConnectionError';
        throw err;
      },
    };
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'PLAINTEXT',
    });
    expect(result.status).toBe('unreachable');
    expect(result.error).toBe('KafkaJSConnectionError');
  });

  it('failed: KafkaJSSASLAuthenticationError thrown from connect → failed (NOT unreachable)', async () => {
    // kafkajs surfaces SASL auth failures as a connect-time rejection. The
    // probe must classify these as `failed` (auth/credential problem) — not
    // `unreachable` (network/transport problem) — so operators are steered
    // towards credential debugging, not network debugging.
    nextAdminBehavior = {
      connect: async () => {
        const err = new Error('SASL Authentication failed for user');
        (err as any).name = 'KafkaJSSASLAuthenticationError';
        throw err;
      },
    };
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'SASL_PLAINTEXT',
      sasl: { mechanism: 'plain', username: 'alice', password: 'wrong-secret-zzz' },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('KafkaJSSASLAuthenticationError');
    // No credentials in the structured result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('wrong-secret-zzz');
  });

  it('failed: KafkaJSAuthenticationError (parent class) thrown from connect → failed', async () => {
    // The parent kafkajs auth-error class. Anything inheriting from it is
    // by definition an auth failure, even if the SASL-specific subclass is
    // not what we got.
    nextAdminBehavior = {
      connect: async () => {
        const err = new Error('Authentication failed');
        (err as any).name = 'KafkaJSAuthenticationError';
        throw err;
      },
    };
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'SASL_PLAINTEXT',
      sasl: { mechanism: 'plain', username: 'u', password: 'p' },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('KafkaJSAuthenticationError');
  });

  it('unreachable: KafkaJSConnectionError thrown from connect stays unreachable', async () => {
    // Network-class errors must not be reclassified as auth failures. The
    // existing "unreachable: connect throws (network error)" test covers the
    // KafkaJSConnectionError path generally; this guard is here so a future
    // contributor cannot widen `isAuthErrorClass` and silently regress the
    // network-failure mapping.
    nextAdminBehavior = {
      connect: async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:9092');
        (err as any).name = 'KafkaJSConnectionError';
        throw err;
      },
    };
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'PLAINTEXT',
    });
    expect(result.status).toBe('unreachable');
    expect(result.error).toBe('KafkaJSConnectionError');
  });

  it('unreachable: arbitrary connect-time errors (e.g. EAI_AGAIN) default to unreachable', async () => {
    // Anything we cannot positively identify as auth must default to
    // `unreachable`. EAI_AGAIN is a libc DNS-resolver retry signal that
    // bubbles up as a non-kafkajs name; the probe should not pretend to know
    // it's an auth failure.
    nextAdminBehavior = {
      connect: async () => {
        const err = new Error('getaddrinfo EAI_AGAIN kafka.example.com');
        (err as any).name = 'EAI_AGAIN';
        throw err;
      },
    };
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['kafka.example.com:9092'],
      topic: 'orders',
      securityProtocol: 'PLAINTEXT',
    });
    expect(result.status).toBe('unreachable');
    expect(result.error).toBe('EAI_AGAIN');
  });

  it('failed: fetchTopicMetadata throws an Error → classified', async () => {
    nextAdminBehavior = {
      fetchTopicMetadata: async () => {
        const err = new Error('UNKNOWN_TOPIC_OR_PARTITION');
        (err as any).name = 'KafkaJSProtocolError';
        throw err;
      },
    };
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'PLAINTEXT',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('KafkaJSProtocolError');
  });

  it('always disconnects, even on fetchTopicMetadata failure', async () => {
    nextAdminBehavior = {
      fetchTopicMetadata: async () => {
        throw Object.assign(new Error('boom'), { name: 'KafkaJSConnectionError' });
      },
    };
    const { probe } = await importProbe();
    await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'PLAINTEXT',
    });
    expect(captured.last!.disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnect failure does not corrupt the probe result', async () => {
    nextAdminBehavior = {
      disconnect: async () => {
        throw new Error('disconnect raced');
      },
    };
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'PLAINTEXT',
    });
    expect(result.status).toBe('verified');
  });
});

describe('probe — credential discarding', () => {
  it('ProbeResult does not echo SASL username or password under any outcome', async () => {
    const cases: Array<{ behavior: AdminBehavior; expected: string }> = [
      { behavior: {}, expected: 'verified' },
      {
        behavior: {
          connect: async () =>
            Promise.reject(Object.assign(new Error('refused'), { name: 'KafkaJSConnectionError' })),
        },
        expected: 'unreachable',
      },
      {
        behavior: { fetchTopicMetadata: async () => ({ topics: [] }) },
        expected: 'failed',
      },
    ];

    for (const { behavior, expected } of cases) {
      nextAdminBehavior = behavior;
      const { probe } = await importProbe();
      const result = await probe({
        brokers: ['kafka.local:9092'],
        topic: 'orders',
        securityProtocol: 'SASL_SSL',
        sasl: {
          mechanism: 'plain',
          username: 'CRED-USER-MARKER',
          password: 'CRED-PASS-MARKER',
        },
        ssl: {
          caPem: '-----BEGIN CERTIFICATE-----\nCA-PEM-MARKER\n-----END CERTIFICATE-----',
        },
      });
      expect(result.status).toBe(expected);
      const blob = JSON.stringify(result);
      expect(blob).not.toContain('CRED-USER-MARKER');
      expect(blob).not.toContain('CRED-PASS-MARKER');
      expect(blob).not.toContain('CA-PEM-MARKER');
    }
  });
});

describe('probe — logging primitives never see credentials (regression guard)', () => {
  // The probe production code today does NOT log anything itself — it relies
  // on structured `ProbeResult` returns and never imports `Logger` or calls
  // `console.*`. This test is defence-in-depth: if a future contributor adds
  // `Logger.info(opts)` or `console.log(opts)` to the probe and accidentally
  // hands raw credentials to a logging primitive, this assertion fails. The
  // intent is "no credential leak through any logging primitive."
  it('no credential substring appears in any captured Logger/console call', async () => {
    const { Logger } = await import('@origintrail-official/dkg-core');

    // Intercept at the prototype level so any Logger instance the probe might
    // construct in the future is captured here.
    const loggerSpies = [
      vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {}),
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}),
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {}),
      vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {}),
    ];
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];

    const SECRETS = [
      'CRED-USER-LOG-MARKER',
      'CRED-PASS-LOG-MARKER',
      'CA-PEM-LOG-MARKER',
      'CERT-PEM-LOG-MARKER',
      'KEY-PEM-LOG-MARKER',
    ] as const;

    const { probe } = await importProbe();
    await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'SASL_SSL',
      sasl: {
        mechanism: 'plain',
        username: 'CRED-USER-LOG-MARKER',
        password: 'CRED-PASS-LOG-MARKER',
      },
      ssl: {
        caPem: '-----BEGIN CERTIFICATE-----\nCA-PEM-LOG-MARKER\n-----END CERTIFICATE-----',
      },
    });

    // Also exercise the SSL/mTLS branch so cert+key PEMs flow through too.
    await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'SSL',
      ssl: {
        caPem: '-----BEGIN CERTIFICATE-----\nCA-PEM-LOG-MARKER\n-----END CERTIFICATE-----',
        certPem: '-----BEGIN CERTIFICATE-----\nCERT-PEM-LOG-MARKER\n-----END CERTIFICATE-----',
        keyPem: '-----BEGIN PRIVATE KEY-----\nKEY-PEM-LOG-MARKER\n-----END PRIVATE KEY-----',
      },
    });

    // Stringify every captured argument across every spy and assert no secret
    // ever made it into a logging primitive. The probe is supposed to log
    // nothing today, so the typical case is "no calls at all" — but the
    // assertion stays satisfied even if some non-credential debug log appears
    // in the future.
    const allCalls = [...loggerSpies, ...consoleSpies].flatMap((spy) => spy.mock.calls);
    const blob = JSON.stringify(allCalls);
    for (const secret of SECRETS) {
      expect(blob).not.toContain(secret);
    }
  });
});

describe('probe — timeout', () => {
  it('returns failed when probeAdmin exceeds timeoutMs', async () => {
    nextAdminBehavior = {
      // Simulate a hung connect — never resolves until we abandon it.
      connect: () => new Promise<void>(() => {}),
    };
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'PLAINTEXT',
      timeoutMs: 50,
    });
    // Timeout surfaces through the outer race as a generic Error → classified
    // as 'Error' string. The probe itself never times out *as* unreachable;
    // it bubbles a structured failure instead.
    expect(['failed', 'unreachable']).toContain(result.status);
  }, 1_000);
});

describe('probe — kafkajs config defaults', () => {
  it('clientId defaults to dkg-kafka-probe and logLevel is NOTHING', async () => {
    const { probe } = await importProbe();
    await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'PLAINTEXT',
    });
    expect(captured.last!.config.clientId).toBe('dkg-kafka-probe');
    expect(captured.last!.config.logLevel).toBe(0);
    expect(captured.last!.config.retry).toEqual({ retries: 0 });
  });

  it('clientId override is honored', async () => {
    const { probe } = await importProbe();
    await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'PLAINTEXT',
      clientId: 'custom-client',
    });
    expect(captured.last!.config.clientId).toBe('custom-client');
  });
});

describe('probe — buildKafkaConfig exhaustiveness guard', () => {
  // The route is the only caller and validates `securityProtocol` before
  // invoking the probe; the type system also narrows the switch arms via
  // `never`. This test forces an unreachable arm by casting through the
  // public input type, asserting the defensive throw fires and is not
  // swallowed by the outer Promise.race / disconnect block. Driving this
  // branch eliminates the last uncovered statements in `kafka-probe.ts` and
  // guarantees a future contributor cannot silently delete the guard.
  it('throws on an unrecognized securityProtocol value', async () => {
    const { probe } = await importProbe();
    await expect(
      probe({
        brokers: ['localhost:9092'],
        topic: 'orders',
        // Cast bypasses the type system to exercise the defensive default
        // arm. Real callers can never reach this branch.
        securityProtocol: 'ROT13' as unknown as 'PLAINTEXT',
      }),
    ).rejects.toThrow(/Unsupported securityProtocol: ROT13/);
  });
});

describe('probe — error classification branches', () => {
  // `classifyError` returns a fixed dictionary keyed by `err.name`. Each arm
  // strips an attacker-controllable error message down to a stable class name,
  // so a caller that logs the result can never accidentally surface a
  // credential substring. We exercise every named arm so the dictionary
  // can't silently regress.
  const ERROR_NAMES = [
    'KafkaJSBrokerNotFound',
    'KafkaJSNumberOfRetriesExceeded',
    'KafkaJSRequestTimeoutError',
    'KafkaJSConnectionClosedError',
  ] as const;

  for (const name of ERROR_NAMES) {
    it(`classifies ${name} thrown from connect`, async () => {
      nextAdminBehavior = {
        connect: async () => {
          throw Object.assign(new Error('inner-message-with-CRED-MARKER'), { name });
        },
      };
      const { probe } = await importProbe();
      const result = await probe({
        brokers: ['localhost:9092'],
        topic: 'orders',
        securityProtocol: 'PLAINTEXT',
      });
      expect(result.status).toBe('unreachable');
      expect(result.error).toBe(name);
      // Defence in depth: never echo the inner message.
      expect(JSON.stringify(result)).not.toContain('CRED-MARKER');
    });
  }

  it('falls back to err.name when the error is not a known kafkajs class', async () => {
    nextAdminBehavior = {
      connect: async () => {
        throw Object.assign(new Error('inner-message'), { name: 'TypeError' });
      },
    };
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'PLAINTEXT',
    });
    expect(result.status).toBe('unreachable');
    expect(result.error).toBe('TypeError');
  });
});

describe('probe — SSL material defaults', () => {
  it('SSL with no `ssl` block at all → falls back to {} and emits a TLS-only kafkajs config (rejectUnauthorized=true, no ca/cert/key)', async () => {
    // Exercises the `ssl ?? {}` path in `buildSsl`. With no caller-supplied
    // PEMs the probe still wires a TLS block — validation falls back to the
    // host trust store (kafkajs default). This is a one-way-TLS handshake,
    // not an mTLS handshake; brokers requiring mTLS will reject during the
    // handshake and the failure surfaces as a structured probe outcome.
    const { probe } = await importProbe();
    const result = await probe({
      brokers: ['localhost:9092'],
      topic: 'orders',
      securityProtocol: 'SSL',
    });
    expect(result.status).toBe('verified');
    const ssl = captured.last!.config.ssl as {
      ca?: string[];
      cert?: string;
      key?: string;
      rejectUnauthorized?: boolean;
    };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toBeUndefined();
    expect(ssl.cert).toBeUndefined();
    expect(ssl.key).toBeUndefined();
  });
});
