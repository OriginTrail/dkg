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
