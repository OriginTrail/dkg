import {
  type KafkaSaslCredentials,
  type KafkaSslMaterial,
  type SecurityProtocol,
} from '@origintrail-official/dkg-kafka';

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const VALID_PROTOCOLS: ReadonlySet<SecurityProtocol> = new Set([
  'PLAINTEXT',
  'SASL_PLAINTEXT',
  'SASL_SSL',
  'SSL',
]);

const VALID_SASL_MECHANISMS: ReadonlySet<KafkaSaslCredentials['mechanism']> = new Set([
  'plain',
  'scram-sha-256',
  'scram-sha-512',
]);

/**
 * Thrown by `parseSasl` / `parseSsl` when the caller supplied a `sasl` or
 * `ssl` block that is structurally present but malformed (wrong type, unknown
 * mechanism, empty username, non-string PEM, ...). The route handler catches
 * this class and translates it into HTTP 400.
 *
 * The `publicMessage` is intentionally a sanitized error string — it names
 * the offending field and (where helpful) the valid alternatives, but never
 * echoes credential values. Safe to send to the caller in the 400 body.
 */
export class KafkaRequestParseError extends Error {
  constructor(public readonly publicMessage: string) {
    super(publicMessage);
    this.name = 'KafkaRequestParseError';
  }
}

export interface KafkaEndpointRequestBody {
  contextGraphId: string;
  broker: string;
  topic: string;
  messageFormat: string;
  securityProtocol?: SecurityProtocol;
  sasl?: KafkaSaslCredentials;
  ssl?: KafkaSslMaterial;
}

/**
 * `dependsOnProbe` — opportunistic verification per ADR 0002.
 *
 * TL;DR: setting `securityProtocol` is the explicit opt-in to verification;
 * its absence means no probe.
 *
 * The probe runs whenever `securityProtocol` is set AND the caller supplied
 * the inputs that protocol logically needs:
 *
 *  - `PLAINTEXT`: always probe (reachability is the most permissive answer).
 *  - `SSL`: always probe — `buildSsl` accepts mTLS material, a CA-only
 *    bundle, or no SSL block at all (default trust store), so the probe
 *    runs in all three shapes. Forcing cert+key here would be inconsistent
 *    with the kafka-package contract.
 *  - `SASL_PLAINTEXT` / `SASL_SSL`: probe only when both `sasl.username` and
 *    `sasl.password` are present — they are the credentials being verified.
 *
 * When no `securityProtocol` is set the route skips the probe entirely and
 * the resulting KA records `verificationStatus: "unattempted"`.
 *
 * Exported so unit tests can pin the gate's behaviour without standing up
 * the full daemon HTTP surface.
 */
export function shouldProbe(body: KafkaEndpointRequestBody): boolean {
  if (!body.securityProtocol) return false;
  switch (body.securityProtocol) {
    case 'PLAINTEXT':
    case 'SSL':
      return true;
    case 'SASL_PLAINTEXT':
    case 'SASL_SSL':
      return Boolean(body.sasl?.username && body.sasl?.password);
    default:
      return false;
  }
}

export function parseSecurityProtocol(value: unknown): SecurityProtocol | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.toUpperCase();
  return VALID_PROTOCOLS.has(upper as SecurityProtocol)
    ? (upper as SecurityProtocol)
    : undefined;
}

/**
 * Cross-field consistency check between `securityProtocol` and the auth
 * material. Mirrors the CLI's fail-fast logic so direct HTTP callers also
 * fail fast instead of getting silent `unattempted` registrations.
 *
 * Throws `KafkaRequestParseError` on mismatch; returns void on consistency.
 *
 * Slice-01 wire compatibility: when no `securityProtocol` is declared we do
 * not enforce anything — the route already skips the probe and the KA records
 * `verificationStatus: "unattempted"`.
 */
export function validateKafkaAuthConsistency(body: KafkaEndpointRequestBody): void {
  const sp = body.securityProtocol;
  if (!sp) {
    // No protocol declared — slice-01 wire compat allows this for plain,
    // unauthenticated requests. But auth/TLS blocks require a protocol
    // declaration; sending them without one is ambiguous misconfig.
    if (body.sasl !== undefined) {
      throw new KafkaRequestParseError(
        `"sasl" must not be set without "securityProtocol"`,
      );
    }
    if (body.ssl !== undefined) {
      throw new KafkaRequestParseError(
        `"ssl" must not be set without "securityProtocol"`,
      );
    }
    return;
  }
  const requiresSasl = sp === 'SASL_PLAINTEXT' || sp === 'SASL_SSL';
  const hasSasl = body.sasl !== undefined;
  if (requiresSasl && !hasSasl) {
    throw new KafkaRequestParseError(
      `"securityProtocol" "${sp}" requires a "sasl" block with username and password`,
    );
  }
  if (!requiresSasl && hasSasl) {
    throw new KafkaRequestParseError(
      `"sasl" must not be set when "securityProtocol" is "${sp}"`,
    );
  }
}

/**
 * Parse a SASL block from the request body.
 *
 * Returns `undefined` when the field is genuinely absent (`null` / `undefined`
 * / missing). Throws `KafkaRequestParseError` when the field is present but
 * malformed — e.g. wrong type, unknown mechanism, empty username/password.
 * Empty strings are treated as misconfiguration, not as "no creds": a caller
 * that wants no SASL block should omit the field entirely.
 *
 * Error messages name the offending field and (for unknown mechanisms) the
 * valid alternatives; they never echo credential values.
 */
export function parseSasl(value: unknown): KafkaSaslCredentials | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new KafkaRequestParseError('"sasl" must be an object');
  }
  const v = value as Record<string, unknown>;

  if (!isNonEmptyString(v.username)) {
    throw new KafkaRequestParseError('"sasl.username" must be a non-empty string');
  }
  if (!isNonEmptyString(v.password)) {
    throw new KafkaRequestParseError('"sasl.password" must be a non-empty string');
  }

  let mechanism: KafkaSaslCredentials['mechanism'] = 'plain';
  if (v.mechanism !== undefined) {
    if (typeof v.mechanism !== 'string') {
      throw new KafkaRequestParseError('"sasl.mechanism" must be a string');
    }
    const lower = v.mechanism.toLowerCase();
    if (!VALID_SASL_MECHANISMS.has(lower as KafkaSaslCredentials['mechanism'])) {
      throw new KafkaRequestParseError(
        '"sasl.mechanism" must be one of plain, scram-sha-256, scram-sha-512',
      );
    }
    mechanism = lower as KafkaSaslCredentials['mechanism'];
  }

  return {
    mechanism,
    username: v.username,
    password: v.password,
  };
}

/**
 * Parse an SSL block from the request body.
 *
 * Returns `undefined` when the field is genuinely absent (`null` / `undefined`
 * / missing) OR when the caller passed `ssl: {}` (no recognized field set —
 * functionally equivalent to no SSL block). Throws `KafkaRequestParseError`
 * when the field is present but malformed — wrong outer type, non-string
 * PEM/path, non-boolean `rejectUnauthorized`.
 *
 * Error messages name the offending field; they never echo PEM contents.
 */
export function parseSsl(value: unknown): KafkaSslMaterial | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new KafkaRequestParseError('"ssl" must be an object');
  }
  const v = value as Record<string, unknown>;

  const out: KafkaSslMaterial = {};
  assignStringField(v, 'ca', out, 'caPem', 'ssl.ca');
  assignStringField(v, 'cert', out, 'certPem', 'ssl.cert');
  assignStringField(v, 'key', out, 'keyPem', 'ssl.key');
  assignStringField(v, 'caPath', out, 'caPath', 'ssl.caPath');
  assignStringField(v, 'certPath', out, 'certPath', 'ssl.certPath');
  assignStringField(v, 'keyPath', out, 'keyPath', 'ssl.keyPath');

  if (v.rejectUnauthorized !== undefined) {
    if (typeof v.rejectUnauthorized !== 'boolean') {
      throw new KafkaRequestParseError('"ssl.rejectUnauthorized" must be a boolean');
    }
    out.rejectUnauthorized = v.rejectUnauthorized;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

// Common assignment helper: `srcKey` is what the caller sent, `dstKey` is
// the kafkajs-shaped field on `KafkaSslMaterial`. Throws on wrong type or
// empty string; "field genuinely absent" is the only path that leaves `dst`
// untouched.
function assignStringField(
  src: Record<string, unknown>,
  srcKey: string,
  dst: KafkaSslMaterial,
  dstKey: keyof KafkaSslMaterial,
  publicName: string,
): void {
  const raw = src[srcKey];
  if (raw === undefined) return;
  if (!isNonEmptyString(raw)) {
    throw new KafkaRequestParseError(`"${publicName}" must be a non-empty string`);
  }
  // The keys we route to are all `string | undefined` on KafkaSslMaterial
  // except `rejectUnauthorized` (handled separately above), so the cast is
  // safe — the function is only called with string-typed destination keys.
  (dst as unknown as Record<string, string>)[dstKey as string] = raw;
}

/**
 * Re-verify request body shape. URI is required; broker / topic /
 * securityProtocol may be omitted, in which case the route falls back to the
 * existing KA's values. Credentials follow the same parser conventions as
 * the register flow.
 *
 * Per ADR 0002: verify with NO credentials at all is meaningless (the verb's
 * whole point is "check what the broker says"). The route enforces that
 * precondition via `hasAnyKafkaCredentials`; this parser only normalises
 * shapes. Slice 04's `validateKafkaAuthConsistency` already runs separately
 * on every register/verify body and rejects shape mismatches (e.g. a `sasl`
 * block paired with `securityProtocol: "SSL"`).
 */
export interface KafkaEndpointVerifyRequestBody {
  uri: string;
  broker?: string;
  topic?: string;
  securityProtocol?: SecurityProtocol;
  sasl?: KafkaSaslCredentials;
  ssl?: KafkaSslMaterial;
}

/**
 * Returns true iff the parsed body carries at least one credential surface
 * the probe can act on. Used by the verify route to enforce the ADR 0002
 * precondition: re-verify with no creds is meaningless and gets a 400.
 *
 * Differs from `validateKafkaAuthConsistency` (slice 04): that helper rejects
 * shape mismatches between `securityProtocol` and the auth blocks; this one
 * checks "is there *anything* the probe can act on", which is a verify-only
 * concern (register accepts no-creds and writes `unattempted`).
 */
export function hasAnyKafkaCredentials(body: KafkaEndpointVerifyRequestBody): boolean {
  if (body.sasl?.username && body.sasl?.password) return true;
  if (body.ssl) {
    const s = body.ssl;
    if (s.caPem || s.certPem || s.keyPem || s.caPath || s.certPath || s.keyPath) {
      return true;
    }
  }
  // PLAINTEXT is the one explicit-protocol-without-creds case the probe
  // accepts (mirrors `shouldProbe`). Verify with PLAINTEXT and no creds is
  // meaningful — it asks "is the broker reachable at all".
  if (body.securityProtocol === 'PLAINTEXT') return true;
  return false;
}
