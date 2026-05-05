import { createHash } from 'node:crypto';

/**
 * Identity tuple for a Kafka topic endpoint URI: the (owner, broker, topic)
 * triple is what the URI uniquely names.
 */
export interface KafkaEndpointIdentity {
  owner: string;
  broker: string;
  topic: string;
}

function hashBrokerAndTopic(broker: string, topic: string): string {
  return createHash('sha256')
    .update(`${broker.toLowerCase()}|${topic}`)
    .digest('hex');
}

/**
 * Build the deterministic URI for a Kafka topic endpoint. Owner is
 * lowercased; (broker, topic) are sha256-hashed so the URI is stable across
 * topology rewrites and casing variations.
 */
export function buildKafkaEndpointUri(identity: KafkaEndpointIdentity): string {
  const owner = identity.owner.toLowerCase();
  const hash = hashBrokerAndTopic(identity.broker, identity.topic);
  return `urn:dkg:kafka-endpoint:${owner}:${hash}`;
}

/**
 * Strict shape of a Kafka endpoint URI: `urn:dkg:kafka-endpoint:<owner>:<sha256-hex-64>`.
 *
 * - Owner must be one or more lowercase alphanumerics plus `.`, `_`, `-`
 *   (no SPARQL-IRI-breaking chars: no `<`, `>`, `"`, `\`, `{`, `}`, `|`, `^`,
 *   backtick, whitespace, control chars).
 * - Hash must be exactly 64 lowercase hex digits (sha256 output of
 *   `${broker}|${topic}`; see `hashBrokerAndTopic`).
 *
 * Co-located with the URI builder so the producer and the validator can never
 * drift apart. Used as the **single defence** against SPARQL injection at
 * every URI interpolation site (route handlers + kafka-package SPARQL).
 */
const KAFKA_ENDPOINT_URI_RE = /^urn:dkg:kafka-endpoint:[a-z0-9._-]+:[0-9a-f]{64}$/;

/**
 * Predicate form: `true` iff `value` is a syntactically valid Kafka endpoint
 * URI. Returns `false` for non-strings (callers may hand us `unknown` from
 * untrusted JSON parses).
 */
export function isValidKafkaEndpointUri(value: string): boolean {
  if (typeof value !== 'string') return false;
  return KAFKA_ENDPOINT_URI_RE.test(value);
}

/**
 * Assertion form: throws on invalid input, returns the URI unchanged on
 * valid input. The throw is the "fail closed" path used at every SPARQL
 * interpolation site so a missed prefix check elsewhere can never lead to
 * an unsanitised IRI landing in a SPARQL query.
 *
 * The error message intentionally does NOT echo the offending URI — that
 * would let a malformed payload land in logs and tooling that may not
 * sanitise downstream. Callers that need to surface the bad value to the
 * end user (e.g. an HTTP route) should construct their own message.
 */
export function assertValidKafkaEndpointUri(value: string): string {
  if (!isValidKafkaEndpointUri(value)) {
    throw new Error(
      `Invalid Kafka endpoint URI: must match ` +
        `urn:dkg:kafka-endpoint:<owner>:<sha256-hex-64>`,
    );
  }
  return value;
}
