import { buildKafkaEndpointUri } from './uri.js';

const KAFKA_ENDPOINT_CONTEXT = {
  dcat: 'http://www.w3.org/ns/dcat#',
  dct: 'http://purl.org/dc/terms/',
  dkg: 'https://ontology.dkg.io/dkg#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
} as const;

/**
 * Verification status hint that lands on the KA as `dkg:verificationStatus`.
 *
 * - `unattempted`: caller did not supply credentials, no probe ran.
 * - `verified`: probe succeeded (topic reachable with the supplied creds).
 * - `failed`: probe ran and failed; only published when the caller passed
 *   `force=true` to override the registration block.
 *
 * The published value is advertised. It is not load-bearing — consumers may
 * choose to re-verify before connecting.
 */
export type KafkaEndpointVerificationStatus =
  | 'unattempted'
  | 'verified'
  | 'failed';

/**
 * Inputs to `buildKafkaEndpointKnowledgeAsset`. Verification fields
 * (`verificationStatus`, `verifiedAt`, `securityProtocol`) are all optional
 * and only land on the KA when the caller opts in.
 */
export interface BuildKafkaEndpointKnowledgeAssetInput {
  owner: string;
  broker: string;
  topic: string;
  messageFormat: string;
  issuedAt: string;
  /**
   * Optional probe outcome to advertise. Out-of-scope: omitting this field
   * keeps the KA shape identical to slice-01.
   */
  verificationStatus?: KafkaEndpointVerificationStatus;
  /** Probe completion timestamp, ISO-8601. Only emitted when the probe ran. */
  verifiedAt?: string;
  /**
   * Advertised auth hint, mirrored from the registration request. Set even
   * when no probe ran; never holds raw credentials.
   */
  securityProtocol?: string;
}

/**
 * Build the JSON-LD knowledge asset for a Kafka topic endpoint. The KA is
 * stable wire output: same inputs always produce the same shape, optional
 * verification fields are appended only when supplied (slice-01 fixtures
 * stay byte-compatible when probing is not opted into).
 */
export function buildKafkaEndpointKnowledgeAsset(input: BuildKafkaEndpointKnowledgeAssetInput) {
  const owner = input.owner.toLowerCase();

  // Optional fields are appended only when present so the KA stays identical
  // to slice-01 when the caller doesn't opt into verification metadata. This
  // keeps the existing golden fixture trivially compatible.
  const optional: Record<string, unknown> = {};
  if (input.verificationStatus) {
    optional['dkg:verificationStatus'] = input.verificationStatus;
  }
  if (input.verifiedAt) {
    optional['dkg:verifiedAt'] = {
      '@value': input.verifiedAt,
      '@type': 'xsd:dateTime',
    };
  }
  if (input.securityProtocol) {
    optional['dkg:securityProtocol'] = input.securityProtocol;
  }

  return {
    '@context': KAFKA_ENDPOINT_CONTEXT,
    '@id': buildKafkaEndpointUri(input),
    '@type': ['dkg:KafkaTopicEndpoint', 'dcat:DataService'],
    'dcat:endpointURL': {
      '@id': `kafka://${input.broker}/${input.topic}`,
    },
    'dkg:broker': input.broker,
    'dkg:topic': input.topic,
    'dkg:messageFormat': input.messageFormat,
    'dct:publisher': {
      '@id': `urn:dkg:agent:${owner}`,
    },
    'dct:issued': {
      '@value': input.issuedAt,
      '@type': 'xsd:dateTime',
    },
    ...optional,
  };
}

const KAFKA_ENDPOINT_REVOCATION_CONTEXT = {
  dkg: 'https://ontology.dkg.io/dkg#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
} as const;

/**
 * The JSON-LD shape produced by `buildKafkaEndpointRevocationMutation`. Captured
 * as a type alias so callers can describe their publisher signature without
 * re-deriving the structural type.
 */
export type KafkaEndpointRevocationMutation = ReturnType<typeof buildKafkaEndpointRevocationMutation>;

/**
 * Build the revocation-mutation fragment for a Kafka endpoint KA. ADR 0004
 * mandates soft-revoke: the existing KA stays in its CG with new
 * `dkg:status "revoked"` + `dkg:revokedAt` triples added. This builder produces
 * just the additive properties (no broker / topic / publisher echo); the
 * caller composes them onto the existing KA's properties before handing the
 * combined document to the V10 update flow, which replaces the KA's full
 * data-graph footprint per `rootEntity`.
 */
export function buildKafkaEndpointRevocationMutation(uri: string, revokedAt: string) {
  return {
    '@context': KAFKA_ENDPOINT_REVOCATION_CONTEXT,
    '@id': uri,
    'dkg:status': 'revoked',
    'dkg:revokedAt': {
      '@value': revokedAt,
      '@type': 'xsd:dateTime',
    },
  };
}
