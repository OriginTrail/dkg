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

export function parseSasl(value: unknown): KafkaSaslCredentials | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  // Empty-string username/password must collapse to "no creds present" so the
  // `shouldProbe` gate skips the probe and the registration records
  // `verificationStatus: "unattempted"`. Letting an empty password through
  // would result in a confusing kafkajs auth failure downstream.
  if (!isNonEmptyString(v.username) || !isNonEmptyString(v.password)) return undefined;
  const mechanism = typeof v.mechanism === 'string' ? v.mechanism.toLowerCase() : 'plain';
  if (!VALID_SASL_MECHANISMS.has(mechanism as KafkaSaslCredentials['mechanism'])) {
    return undefined;
  }
  return {
    mechanism: mechanism as KafkaSaslCredentials['mechanism'],
    username: v.username,
    password: v.password,
  };
}

export function parseSsl(value: unknown): KafkaSslMaterial | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  // Empty-string PEMs / paths collapse to "absent". An empty inline PEM would
  // make kafkajs reject the connection; an empty path would make `readFile`
  // throw ENOENT. Either case is more useful as a skipped probe than a
  // confusing failure mode.
  const out: KafkaSslMaterial = {};
  if (isNonEmptyString(v.ca)) out.caPem = v.ca;
  if (isNonEmptyString(v.cert)) out.certPem = v.cert;
  if (isNonEmptyString(v.key)) out.keyPem = v.key;
  if (isNonEmptyString(v.caPath)) out.caPath = v.caPath;
  if (isNonEmptyString(v.certPath)) out.certPath = v.certPath;
  if (isNonEmptyString(v.keyPath)) out.keyPath = v.keyPath;
  if (typeof v.rejectUnauthorized === 'boolean') {
    out.rejectUnauthorized = v.rejectUnauthorized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
