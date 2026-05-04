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
 * TL;DR: PLAINTEXT with `securityProtocol` set is the explicit opt-in to
 * verification; absence of `securityProtocol` means no probe.
 *
 * The probe runs IFF the caller supplied credentials (SASL_PLAINTEXT/SASL_SSL
 * with sasl.username/password, or SSL with cert+key, or PLAINTEXT/SASL_SSL
 * with explicit `securityProtocol`). When the request carries no creds and no
 * explicit protocol, the route skips the probe entirely and the resulting
 * KA records `verificationStatus: "unattempted"`.
 *
 * The exception is `securityProtocol: "PLAINTEXT"`: a caller might explicitly
 * advertise PLAINTEXT and ask for verification. In that case we still probe,
 * because reachability against PLAINTEXT is the most permissive case the
 * probe can answer.
 *
 * Exported so unit tests can pin the gate's behaviour without standing up
 * the full daemon HTTP surface.
 */
export function shouldProbe(body: KafkaEndpointRequestBody): boolean {
  if (!body.securityProtocol) return false;
  switch (body.securityProtocol) {
    case 'PLAINTEXT':
      return true;
    case 'SASL_PLAINTEXT':
    case 'SASL_SSL':
      return Boolean(body.sasl?.username && body.sasl?.password);
    case 'SSL':
      return Boolean(
        (body.ssl?.certPem || body.ssl?.certPath) && (body.ssl?.keyPem || body.ssl?.keyPath),
      );
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
