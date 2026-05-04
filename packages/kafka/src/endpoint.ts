import {
  buildKafkaEndpointKnowledgeAsset,
  type KafkaEndpointVerificationStatus,
} from './ka-builder.js';
import { buildKafkaEndpointUri } from './uri.js';

/**
 * Dependency-inversion boundary: the kafka package needs something that can
 * publish a JSON-LD knowledge asset. The package hands the bare KA across this
 * interface; envelope wrapping (e.g. `{ public: ... }`) belongs to the caller.
 */
export type KafkaEndpointKnowledgeAsset = ReturnType<typeof buildKafkaEndpointKnowledgeAsset>;

export interface KafkaEndpointPublisher {
  publish(
    contextGraphId: string,
    knowledgeAsset: KafkaEndpointKnowledgeAsset,
  ): Promise<unknown>;
}

/**
 * Probe outcome handed to `registerKafkaEndpoint`. The probe is run by the
 * caller (the route handler). This package's pure layer never opens Kafka
 * connections of its own — see ADR 0001/0002. The shape mirrors the public
 * `ProbeResult` from `kafka-probe.ts` minus its surface-irrelevant
 * `securityProtocol` echo (the route already knows that and passes it
 * directly via `RegisterKafkaEndpointInput.securityProtocol`).
 */
export interface KafkaEndpointProbeOutcome {
  status: 'verified' | 'failed' | 'unreachable';
  /** ISO-8601 timestamp recorded at probe completion. */
  probedAt: string;
  /**
   * Sanitized error description from the underlying probe (already classified
   * to a stable kafkajs error class name — never carries credential
   * substrings). Present on `failed` / `unreachable` outcomes; absent on
   * `verified`.
   */
  error?: string;
}

export interface RegisterKafkaEndpointInput {
  contextGraphId: string;
  owner: string;
  broker: string;
  topic: string;
  messageFormat: string;
  issuedAt?: string;
  publisher: KafkaEndpointPublisher;
  /**
   * Advertised broker auth hint, mirrored to the KA as `dkg:securityProtocol`.
   * Set whenever the request specified one — even if no probe ran.
   */
  securityProtocol?: string;
  /**
   * Probe outcome from the route handler. `undefined` means "no probe ran"
   * (creds were absent in the request). When defined, the registration
   * decision rules below apply.
   */
  probe?: KafkaEndpointProbeOutcome;
  /**
   * Caller's `?force=true` override. Only consulted when `probe.status` is
   * not `verified`. Without `force`, a non-verified probe causes the
   * registration to throw — the route translates that to HTTP 4xx.
   */
  force?: boolean;
}

export interface RegisterKafkaEndpointResult {
  uri: string;
  contextGraphId: string;
  verificationStatus: KafkaEndpointVerificationStatus;
  /** Probe completion timestamp, present whenever a probe ran. */
  verifiedAt?: string;
}

/**
 * Thrown when a probe failed and the caller did not pass `force=true`. The
 * route translates this into a 4xx response. We use a typed error so route
 * handlers can branch on `instanceof` instead of stringly-typed checks.
 */
export class KafkaEndpointProbeFailedError extends Error {
  constructor(public readonly outcome: KafkaEndpointProbeOutcome) {
    super(
      `Kafka endpoint probe ${outcome.status} at ${outcome.probedAt}; ` +
        `pass force=true to register anyway`,
    );
    this.name = 'KafkaEndpointProbeFailedError';
  }
}

export async function registerKafkaEndpoint(
  input: RegisterKafkaEndpointInput,
): Promise<RegisterKafkaEndpointResult> {
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const uri = buildKafkaEndpointUri(input);

  // ADR 0002: opportunistic verification.
  //
  //   probe absent              → status: unattempted, no verifiedAt
  //   probe verified            → status: verified, verifiedAt = probedAt
  //   probe failed/unreachable  → throw unless caller forced us
  //   probe failed + force=true → status: failed, verifiedAt = probedAt
  //
  // The route is the only caller; it owns the decision tree about whether
  // to invoke the probe at all. We just consume its result.
  let verificationStatus: KafkaEndpointVerificationStatus;
  let verifiedAt: string | undefined;
  if (!input.probe) {
    verificationStatus = 'unattempted';
  } else if (input.probe.status === 'verified') {
    verificationStatus = 'verified';
    verifiedAt = input.probe.probedAt;
  } else {
    if (!input.force) {
      throw new KafkaEndpointProbeFailedError(input.probe);
    }
    verificationStatus = 'failed';
    verifiedAt = input.probe.probedAt;
  }

  const knowledgeAsset = buildKafkaEndpointKnowledgeAsset({
    owner: input.owner,
    broker: input.broker,
    topic: input.topic,
    messageFormat: input.messageFormat,
    issuedAt,
    verificationStatus,
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(input.securityProtocol ? { securityProtocol: input.securityProtocol } : {}),
  });

  await input.publisher.publish(input.contextGraphId, knowledgeAsset);

  return {
    uri,
    contextGraphId: input.contextGraphId,
    verificationStatus,
    ...(verifiedAt ? { verifiedAt } : {}),
  };
}
