// kafka-probe.ts — opportunistic broker reachability probe.
//
// ADR 0001 (kafka package writes metadata only): this module is a one-shot
// ADMIN call. It opens a connection, fetches topic metadata, and disconnects.
// No consumer, no group ID, no offset tracking, no long-lived broker state.
// Resist any urge to grow this into a smarter primitive — the probe is meant
// to answer one yes/no question (is the topic reachable with these creds?)
// and nothing more.
//
// kafkajs version is pinned in `package.json` (`kafkajs@2.2.4`) — chosen as
// the first runtime dependency on this package. kafkajs 2.x is the actively
// maintained line; the Admin API exposes `fetchTopicMetadata({ topics })`,
// which is the named operation the spec calls `describeTopics`.
//
// Credentials passed in are scoped to a single execution. The function never
// stores them on a closure outliving its own promise, never returns them,
// never logs them, and never persists them. The `ProbeResult` deliberately
// omits any credential strings.

import { readFile } from 'node:fs/promises';
import {
  Kafka,
  logLevel,
  type Admin,
  type KafkaConfig,
  type SASLOptions,
} from 'kafkajs';

/** Supported Kafka broker security/auth modes. */
export type SecurityProtocol =
  | 'PLAINTEXT'
  | 'SASL_PLAINTEXT'
  | 'SASL_SSL'
  | 'SSL';

/**
 * TLS material for SSL/SASL_SSL broker connections. PEMs accepted inline or
 * via filesystem paths (escape hatch).
 */
export interface KafkaSslMaterial {
  /** PEM string (CA bundle). Preferred. */
  caPem?: string;
  /** PEM string (mTLS client cert). Required for SSL mTLS. */
  certPem?: string;
  /** PEM string (mTLS client key). Required for SSL mTLS. */
  keyPem?: string;
  /**
   * Filesystem-path escape hatch. The daemon host must have the PEMs
   * pre-staged at these paths and readable by the daemon process. Inline PEMs
   * are preferred; this exists for caller convenience and is read at probe
   * time only.
   */
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  /** Mirror of kafkajs `tls.rejectUnauthorized`. Defaults to `true`. */
  rejectUnauthorized?: boolean;
}

/** SASL credentials for authenticated broker connections. */
export interface KafkaSaslCredentials {
  /** SASL mechanism. kafkajs accepts lowercase identifiers. */
  mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  username: string;
  password: string;
}

/**
 * Inputs to a one-shot Kafka admin probe. Credentials are passed once to
 * kafkajs and never returned, logged, or stored.
 */
export interface KafkaProbeOptions {
  brokers: string[];
  topic: string;
  securityProtocol: SecurityProtocol;
  sasl?: KafkaSaslCredentials;
  ssl?: KafkaSslMaterial;
  /** kafkajs client identifier (logged on the broker side). */
  clientId?: string;
  /** Hard timeout for the entire probe call. Defaults to 5_000 ms. */
  timeoutMs?: number;
}

/** Discriminator for the probe outcome. See {@link ProbeResult}. */
export type ProbeStatus = 'verified' | 'failed' | 'unreachable';

/**
 * Structured outcome of a probe call. Network/auth failures are encoded as
 * `status` ≠ `'verified'`; the probe never throws on broker errors.
 */
export interface ProbeResult {
  status: ProbeStatus;
  /** Echoed for the KA. Not a credential. */
  securityProtocol: SecurityProtocol;
  /** ISO-8601 timestamp recorded immediately before disconnect. */
  probedAt: string;
  /** Sanitized error description. NEVER contains credential substrings. */
  error?: string;
}

// Wall-clock ceiling for the entire probe round-trip. The kafkajs internal
// `connectionTimeout` (2_000) + `requestTimeout` (3_000) below should fit
// inside this budget; if you raise either, raise this too. See the kafkajs
// config block in `buildKafkaConfig` for the split rationale.
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CLIENT_ID = 'dkg-kafka-probe';

/**
 * Runs a one-shot Kafka admin probe to verify a broker + topic combination.
 *
 * Network and auth failures are returned as structured results
 * (`{ status: 'failed' | 'unreachable', error, ... }`).
 *
 * Throws ONLY on ill-formed input options:
 *   - `securityProtocol` requires SASL but `opts.sasl` is missing,
 *   - `securityProtocol === 'SSL'` but no client cert/key was supplied,
 *   - a PEM filesystem path is unreadable,
 *   - `securityProtocol` is not one of the four supported values.
 *
 * Callers (the route handler) are expected to validate input shape before
 * invoking the probe; broker reachability is the function's domain.
 *
 * Credentials supplied in `opts` are passed once to the kafkajs admin client
 * and never returned, logged, or persisted on the closure beyond the
 * function's local scope. The `ProbeResult` deliberately omits any
 * credential strings.
 */
export async function probe(opts: KafkaProbeOptions): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const config = await buildKafkaConfig(opts);

  const kafka = new Kafka(config);
  const admin: Admin = kafka.admin();

  let result: RawProbeOutcome;
  try {
    result = await runWithTimeout(probeAdmin(admin, opts.topic), timeoutMs);
  } catch (err) {
    // The only path that throws here is `runWithTimeout` racing against a
    // hung `probeAdmin` call. Map it onto a structured failure so callers
    // never have to discriminate "thrown vs returned" from this function.
    result = { status: 'failed', error: classifyError(err) };
  }

  try {
    return {
      status: result.status,
      securityProtocol: opts.securityProtocol,
      probedAt: new Date().toISOString(),
      error: result.error,
    };
  } finally {
    // Best-effort disconnect. If the connection never came up, kafkajs
    // tolerates a no-op disconnect — but we swallow any throw here so the
    // probe always returns a structured result instead of leaking.
    try {
      await admin.disconnect();
    } catch {
      // intentionally swallowed: a probe failure already drove this branch
    }
  }
}

/** @internal */
interface RawProbeOutcome {
  status: ProbeStatus;
  error?: string;
}

async function probeAdmin(admin: Admin, topic: string): Promise<RawProbeOutcome> {
  try {
    await admin.connect();
  } catch (err) {
    return { status: 'unreachable', error: classifyError(err) };
  }

  try {
    const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
    const found = metadata.topics.some((t) => t.name === topic);
    if (!found) {
      return { status: 'failed', error: `Topic "${topic}" not present in cluster metadata` };
    }
    return { status: 'verified' };
  } catch (err) {
    return { status: 'failed', error: classifyError(err) };
  }
}

/**
 * kafkajs surfaces typed errors with stable `name` values (KafkaJSConnectionError,
 * KafkaJSSASLAuthenticationError, etc.). We strip free-form messages to a
 * fixed dictionary plus the error class name; this keeps any accidentally-leaked
 * credential substrings out of the result.
 */
function classifyError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? 'Error';
  // kafkajs' UNKNOWN_TOPIC_OR_PARTITION protocol error class is the canonical
  // "topic doesn't exist" signal we hit through fetchTopicMetadata.
  if (name === 'KafkaJSProtocolError') return 'KafkaJSProtocolError';
  if (name === 'KafkaJSConnectionError') return 'KafkaJSConnectionError';
  if (name === 'KafkaJSConnectionClosedError') return 'KafkaJSConnectionClosedError';
  if (name === 'KafkaJSBrokerNotFound') return 'KafkaJSBrokerNotFound';
  if (name === 'KafkaJSSASLAuthenticationError') return 'KafkaJSSASLAuthenticationError';
  if (name === 'KafkaJSNumberOfRetriesExceeded') return 'KafkaJSNumberOfRetriesExceeded';
  if (name === 'KafkaJSRequestTimeoutError') return 'KafkaJSRequestTimeoutError';
  return name;
}

async function buildKafkaConfig(opts: KafkaProbeOptions): Promise<KafkaConfig> {
  const base: KafkaConfig = {
    brokers: opts.brokers,
    clientId: opts.clientId ?? DEFAULT_CLIENT_ID,
    // Silence kafkajs' built-in logger entirely. We deliberately don't pipe it
    // into our own logger because kafkajs occasionally embeds connection
    // details in its log payloads, and this probe must never emit credentials.
    logLevel: logLevel.NOTHING,
    // Split timeouts that fail fast on different failure modes:
    //   `connectionTimeout` — TCP/TLS reach (unreachable broker → quick fail)
    //   `requestTimeout`    — slow broker response after the connection is up
    // Their sum (5_000 ms) deliberately matches `DEFAULT_TIMEOUT_MS` so the
    // outer `runWithTimeout` only fires on a kafkajs hang that ignores both
    // inner clocks.
    connectionTimeout: 2_000,
    requestTimeout: 3_000,
    // Disable retries — a single probe attempt is intentional. Retries would
    // multiply the wall-clock cost of `unreachable` outcomes and obscure the
    // fact that the broker isn't reachable.
    retry: { retries: 0 },
  };

  switch (opts.securityProtocol) {
    case 'PLAINTEXT':
      return { ...base, ssl: false };
    case 'SASL_PLAINTEXT':
      return { ...base, ssl: false, sasl: requireSasl(opts) };
    case 'SASL_SSL':
      return { ...base, ssl: await buildSsl(opts.ssl, false), sasl: requireSasl(opts) };
    case 'SSL':
      return { ...base, ssl: await buildSsl(opts.ssl, true) };
    default: {
      const exhaustive: never = opts.securityProtocol;
      throw new Error(`Unsupported securityProtocol: ${String(exhaustive)}`);
    }
  }
}

function requireSasl(opts: KafkaProbeOptions): SASLOptions {
  if (!opts.sasl) {
    throw new Error(`securityProtocol "${opts.securityProtocol}" requires SASL credentials`);
  }
  return {
    mechanism: opts.sasl.mechanism,
    username: opts.sasl.username,
    password: opts.sasl.password,
  };
}

/** @internal */
interface SslConnectionOptions {
  rejectUnauthorized: boolean;
  ca?: string[];
  cert?: string;
  key?: string;
}

async function buildSsl(
  ssl: KafkaSslMaterial | undefined,
  requireMtls: boolean,
): Promise<SslConnectionOptions> {
  const material = ssl ?? {};
  const ca = await loadOptionalPem(material.caPem, material.caPath);
  const cert = await loadOptionalPem(material.certPem, material.certPath);
  const key = await loadOptionalPem(material.keyPem, material.keyPath);

  if (requireMtls && (!cert || !key)) {
    throw new Error('SSL mTLS requires both client cert and key (inline or via path)');
  }

  const tlsOpts: SslConnectionOptions = {
    rejectUnauthorized: material.rejectUnauthorized ?? true,
  };
  if (ca) tlsOpts.ca = [ca];
  if (cert) tlsOpts.cert = cert;
  if (key) tlsOpts.key = key;
  return tlsOpts;
}

async function loadOptionalPem(
  inline: string | undefined,
  path: string | undefined,
): Promise<string | undefined> {
  if (inline && inline.trim().length > 0) return inline;
  if (path && path.trim().length > 0) {
    return readFile(path, 'utf8');
  }
  return undefined;
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Kafka probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
