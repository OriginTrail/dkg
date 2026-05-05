import {
  buildKafkaEndpointKnowledgeAsset,
  type KafkaEndpointVerificationStatus,
} from './ka-builder.js';
import type { ProbeResult } from './kafka-probe.js';
import { assertValidKafkaEndpointUri, buildKafkaEndpointUri } from './uri.js';

/**
 * The JSON-LD shape produced by `buildKafkaEndpointKnowledgeAsset` and handed
 * to the publisher. Captured as a type alias so callers can describe their
 * publisher signature without re-deriving the structural type.
 */
export type KafkaEndpointKnowledgeAsset = ReturnType<typeof buildKafkaEndpointKnowledgeAsset>;

/**
 * Dependency-inversion boundary: the kafka package needs something that can
 * publish a JSON-LD knowledge asset. The package hands the bare KA across this
 * interface; envelope wrapping (e.g. `{ public: ... }`) belongs to the caller.
 *
 * `update` is the V10 mutation flow: the caller resolves the URI to the
 * underlying KC identifier and replaces the KA's data-graph footprint with the
 * supplied (full) KA. The kafka package never sees kcIds; URI is the stable
 * identity it works with. See ADR 0004 — soft-revoke and re-verify both go
 * through `update`, not `publish` (publish would either fail with "already
 * published" or create a duplicate KA at a new kcId, neither of which fits the
 * registry's mutate-in-place contract).
 */
export interface KafkaEndpointPublisher {
  publish(
    contextGraphId: string,
    knowledgeAsset: KafkaEndpointKnowledgeAsset,
  ): Promise<unknown>;
  update(
    contextGraphId: string,
    uri: string,
    knowledgeAsset: KafkaEndpointKnowledgeAsset,
  ): Promise<unknown>;
}

/**
 * Dependency-inversion boundary for SPARQL queries the kafka package needs.
 * The thin shape mirrors the daemon's `agent.query` surface — the kafka
 * package only needs SELECT bindings keyed off a context-graph scope.
 *
 * Bindings are returned in the daemon's wire shape: each value is a quoted
 * literal (`"foo"^^xsd:dateTime`) or angle-bracketed IRI (`<urn:dkg:…>`).
 * Stripping those delimiters is the kafka package's job (see
 * `stripQuotedLiteral` / `stripIriDelimiters`), so callers can plug in any
 * SPARQL HTTP client without pre-parsing.
 */
export interface KafkaEndpointQueryEngine {
  query(
    sparql: string,
    contextGraphId: string,
  ): Promise<{ bindings: Array<Record<string, string>> }>;
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

/**
 * Inputs to `registerKafkaEndpoint`. Captures the endpoint identity, the
 * publisher to use, and the optional probe outcome the route handler ran on
 * the caller's behalf (per ADR 0002).
 */
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

/**
 * Outcome of a successful `registerKafkaEndpoint` call: the endpoint URI, the
 * target context graph, and the verification status that was advertised on
 * the published KA.
 */
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

/**
 * Build and publish a Kafka topic endpoint KA into the named context graph.
 * Consumes the route's probe decision (if any) per ADR 0002, applies the
 * `force` override, and throws `KafkaEndpointProbeFailedError` when a
 * non-verified probe runs without `force=true`.
 */
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
    verifiedAt,
    securityProtocol: input.securityProtocol,
  });

  await input.publisher.publish(input.contextGraphId, knowledgeAsset);

  return {
    uri,
    contextGraphId: input.contextGraphId,
    verificationStatus,
    verifiedAt,
  };
}

/**
 * Convert a kafka-probe result into the endpoint registration probe-outcome shape.
 * The endpoint contract intentionally exposes a narrower view than the probe (no
 * credential-adjacent fields, no broker connection details).
 */
export function toKafkaEndpointProbeOutcome(result: ProbeResult): KafkaEndpointProbeOutcome {
  return {
    status: result.status,
    probedAt: result.probedAt,
    ...(result.error ? { error: result.error } : {}),
  };
}

// ─── slice 05: list / get / revoke / verify ────────────────────────────────

const KAFKA_ENDPOINT_PREFIXES = `
  PREFIX dcat: <http://www.w3.org/ns/dcat#>
  PREFIX dct: <http://purl.org/dc/terms/>
  PREFIX dkg: <https://ontology.dkg.io/dkg#>
`;

/**
 * Selection columns reused by both list and single-fetch SPARQL. Centralised
 * so the binding-row parser (`parseEndpointRow`) and the SPARQL it consumes
 * never drift apart.
 */
const KAFKA_ENDPOINT_BGP = `
  ?endpoint a dkg:KafkaTopicEndpoint, dcat:DataService ;
    dkg:broker ?broker ;
    dkg:topic ?topic ;
    dkg:messageFormat ?messageFormat ;
    dct:publisher ?publisher ;
    dct:issued ?issued ;
    dcat:endpointURL ?endpointUrl .
  OPTIONAL { ?endpoint dkg:verificationStatus ?verificationStatus }
  OPTIONAL { ?endpoint dkg:verifiedAt ?verifiedAt }
  OPTIONAL { ?endpoint dkg:securityProtocol ?securityProtocol }
  OPTIONAL { ?endpoint dkg:status ?status }
  OPTIONAL { ?endpoint dkg:revokedAt ?revokedAt }
`;

/**
 * Status filter for `listKafkaEndpoints`. The default `'active'` excludes
 * revoked KAs — that's the load-bearing safe default discussed in the slice
 * 05 ticket. Returning revoked endpoints by default would be a silent-default
 * bug.
 */
export type KafkaEndpointListStatus = 'active' | 'revoked' | 'all';

/** Read-only view of an endpoint KA, returned by both list and single-fetch. */
export interface KafkaEndpointSummary {
  uri: string;
  contextGraphId: string;
  broker: string;
  topic: string;
  messageFormat: string;
  publisher: string;
  endpointUrl: string;
  issued: string;
  verificationStatus?: string;
  verifiedAt?: string;
  securityProtocol?: string;
  /** Present only on revoked KAs (`"revoked"`). Absent on active ones. */
  status?: string;
  /** Present only on revoked KAs. ISO-8601 timestamp. */
  revokedAt?: string;
}

export interface ListKafkaEndpointsInput {
  contextGraphId: string;
  queryEngine: KafkaEndpointQueryEngine;
  /** Defaults to `'active'`. */
  status?: KafkaEndpointListStatus;
}

export interface ListKafkaEndpointsResult {
  contextGraphId: string;
  status: KafkaEndpointListStatus;
  endpoints: KafkaEndpointSummary[];
}

export interface GetKafkaEndpointInput {
  contextGraphId: string;
  uri: string;
  queryEngine: KafkaEndpointQueryEngine;
}

export type GetKafkaEndpointResult = KafkaEndpointSummary;

export interface RevokeKafkaEndpointInput {
  contextGraphId: string;
  uri: string;
  queryEngine: KafkaEndpointQueryEngine;
  publisher: KafkaEndpointPublisher;
  /** ISO-8601. Defaults to `new Date().toISOString()`. */
  revokedAt?: string;
}

export interface RevokeKafkaEndpointResult {
  uri: string;
  contextGraphId: string;
  status: 'revoked';
  revokedAt: string;
}

export interface VerifyKafkaEndpointInput {
  contextGraphId: string;
  uri: string;
  queryEngine: KafkaEndpointQueryEngine;
  publisher: KafkaEndpointPublisher;
  /**
   * Probe outcome the route handler ran on the caller's behalf. Required —
   * verifying without a probe is meaningless (the verb's whole point is
   * "tell me what the broker says, write it down"). The route enforces the
   * "creds present" precondition before invoking this function.
   */
  probe: KafkaEndpointProbeOutcome;
  /**
   * Pre-fetched existing KA snapshot. When supplied, this function skips
   * its own `getKafkaEndpoint` read — useful for routes that already need
   * the existing KA to compute effective probe inputs (broker / topic /
   * securityProtocol defaulting), so they don't pay for a second SPARQL
   * round-trip. When omitted, the function fetches the KA itself, same as
   * before.
   */
  existing?: KafkaEndpointSummary;
}

export interface VerifyKafkaEndpointResult {
  uri: string;
  contextGraphId: string;
  verificationStatus: KafkaEndpointVerificationStatus;
  verifiedAt: string;
}

/**
 * List Kafka endpoint KAs in a context graph, with optional status filter.
 * Defaults to `status='active'` — revoked KAs are excluded from the default
 * listing (see ADR 0004 / slice 05 ticket).
 */
export async function listKafkaEndpoints(
  input: ListKafkaEndpointsInput,
): Promise<ListKafkaEndpointsResult> {
  const status: KafkaEndpointListStatus = input.status ?? 'active';
  const sparql = `
    ${KAFKA_ENDPOINT_PREFIXES}
    SELECT ?endpoint ?broker ?topic ?messageFormat ?publisher ?endpointUrl ?issued
           ?verificationStatus ?verifiedAt ?securityProtocol ?status ?revokedAt
    WHERE {
      GRAPH ?g {
        ${KAFKA_ENDPOINT_BGP}
        ${statusFilterClause(status)}
      }
    }
  `;
  const { bindings } = await input.queryEngine.query(sparql, input.contextGraphId);
  const endpoints = bindings.map((row) => parseEndpointRow(row, input.contextGraphId));
  return { contextGraphId: input.contextGraphId, status, endpoints };
}

/**
 * Fetch a single Kafka endpoint KA by URI, regardless of revocation state.
 * Returns `null` when no matching KA exists in the requested CG. The status
 * filter from `listKafkaEndpoints` does NOT apply here — by design, callers
 * may need to inspect a revoked KA (e.g. for a "show me what was deleted"
 * UX, or to re-verify a revoked endpoint).
 */
export async function getKafkaEndpoint(
  input: GetKafkaEndpointInput,
): Promise<GetKafkaEndpointResult | null> {
  // Defence-in-depth: validate the URI before it lands in a SPARQL IRI
  // position, even though the route adapter already validates. The package
  // does not trust its callers — anyone wiring up a custom adapter (tests,
  // future agents) gets the same protection.
  const uri = assertValidKafkaEndpointUri(input.uri);
  const sparql = `
    ${KAFKA_ENDPOINT_PREFIXES}
    SELECT ?broker ?topic ?messageFormat ?publisher ?endpointUrl ?issued
           ?verificationStatus ?verifiedAt ?securityProtocol ?status ?revokedAt
    WHERE {
      GRAPH ?g {
        BIND(<${uri}> AS ?endpoint)
        ${KAFKA_ENDPOINT_BGP}
      }
    }
    LIMIT 1
  `;
  const { bindings } = await input.queryEngine.query(sparql, input.contextGraphId);
  if (bindings.length === 0) return null;
  return parseEndpointRow({ ...bindings[0], endpoint: `<${uri}>` }, input.contextGraphId);
}

/**
 * Soft-revoke a Kafka endpoint KA. ADR 0004 mandates mutate-by-add-only:
 * the existing KA stays in its CG, with `dkg:status "revoked"` +
 * `dkg:revokedAt` triples added. We read the current properties, compose them
 * with the revocation mutation, and hand the FULL new KA to the V10 update
 * flow (not delete+recreate — that would lose provenance).
 *
 * Idempotent: a second revoke succeeds and re-stamps `dkg:revokedAt` to the
 * fresh timestamp. The KA is queryable via `getKafkaEndpoint` after revoke.
 */
export async function revokeKafkaEndpoint(
  input: RevokeKafkaEndpointInput,
): Promise<RevokeKafkaEndpointResult> {
  const revokedAt = input.revokedAt ?? new Date().toISOString();
  const existing = await getKafkaEndpoint({
    contextGraphId: input.contextGraphId,
    uri: input.uri,
    queryEngine: input.queryEngine,
  });
  if (!existing) {
    throw new Error(
      `Kafka endpoint ${input.uri} not found in context graph "${input.contextGraphId}"`,
    );
  }

  const newKa = composeKafkaEndpointKnowledgeAsset(existing, {
    status: 'revoked',
    revokedAt,
  });

  await input.publisher.update(input.contextGraphId, input.uri, newKa);

  return {
    uri: input.uri,
    contextGraphId: input.contextGraphId,
    status: 'revoked',
    revokedAt,
  };
}

/**
 * Re-verify an existing Kafka endpoint KA: refresh `verifiedAt` +
 * `verificationStatus` from a fresh probe outcome, leaving every other
 * property (including any prior revocation) intact.
 *
 * Probe semantics mirror register: `verified` → `verificationStatus="verified"`,
 * `failed`/`unreachable` → collapse to `"failed"` on the wire (the granular
 * distinction stays in route-level diagnostics). Failure is recorded on the
 * KA, not surfaced as an error — the verb's contract is "tell me what the
 * broker says, write it down" (ADR 0002).
 */
export async function verifyKafkaEndpoint(
  input: VerifyKafkaEndpointInput,
): Promise<VerifyKafkaEndpointResult> {
  // Reuse the caller's pre-fetched KA snapshot when available — every
  // production caller (the verify route) already needs `existing` to
  // compute the effective probe inputs (broker / topic / securityProtocol
  // defaulting from the recorded values), so re-fetching here would be a
  // wasted round-trip. When `existing` is omitted we fall back to the
  // self-fetching path so direct unit-test callers don't have to thread
  // the snapshot through.
  const existing =
    input.existing ??
    (await getKafkaEndpoint({
      contextGraphId: input.contextGraphId,
      uri: input.uri,
      queryEngine: input.queryEngine,
    }));
  if (!existing) {
    throw new Error(
      `Kafka endpoint ${input.uri} not found in context graph "${input.contextGraphId}"`,
    );
  }

  const verificationStatus: KafkaEndpointVerificationStatus =
    input.probe.status === 'verified' ? 'verified' : 'failed';
  const verifiedAt = input.probe.probedAt;

  const newKa = composeKafkaEndpointKnowledgeAsset(existing, {
    verificationStatus,
    verifiedAt,
  });

  await input.publisher.update(input.contextGraphId, input.uri, newKa);

  return {
    uri: input.uri,
    contextGraphId: input.contextGraphId,
    verificationStatus,
    verifiedAt,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function statusFilterClause(status: KafkaEndpointListStatus): string {
  switch (status) {
    case 'active':
      // Cleanest filter shape: most endpoints have no `dkg:status` property at
      // all, so FILTER NOT EXISTS positively excludes only the revoked rows
      // without forcing every active row to bind a `?status` variable.
      return `FILTER NOT EXISTS { ?endpoint dkg:status "revoked" }`;
    case 'revoked':
      return `?endpoint dkg:status "revoked" .`;
    case 'all':
      return '';
  }
}

/**
 * Compose a full Kafka endpoint KA from existing properties + a partial
 * mutation (the revocation or re-verify additions). The V10 update flow is a
 * full replace per `rootEntity`, so we cannot send a delta — every existing
 * property must be re-emitted in the new KA, with mutated fields overlaid.
 */
function composeKafkaEndpointKnowledgeAsset(
  existing: KafkaEndpointSummary,
  overlay: {
    verificationStatus?: KafkaEndpointVerificationStatus;
    verifiedAt?: string;
    securityProtocol?: string;
    status?: string;
    revokedAt?: string;
  },
): KafkaEndpointKnowledgeAsset {
  const verificationStatus =
    (overlay.verificationStatus ?? existing.verificationStatus) as
      | KafkaEndpointVerificationStatus
      | undefined;
  const verifiedAt = overlay.verifiedAt ?? existing.verifiedAt;
  const securityProtocol = overlay.securityProtocol ?? existing.securityProtocol;
  const status = overlay.status ?? existing.status;
  const revokedAt = overlay.revokedAt ?? existing.revokedAt;

  const owner = ownerFromPublisherUri(existing.publisher);

  // Reuse the canonical builder so every property echoes the exact same
  // shape as the original `register` flow (typed xsd:dateTime literals,
  // sorted optionals appended at the tail). Then overlay revocation fields
  // — those aren't part of the register builder's contract.
  const baseKa = buildKafkaEndpointKnowledgeAsset({
    owner,
    broker: existing.broker,
    topic: existing.topic,
    messageFormat: existing.messageFormat,
    issuedAt: existing.issued,
    verificationStatus,
    verifiedAt,
    securityProtocol,
  });

  const composed: Record<string, unknown> = { ...baseKa };
  if (status) {
    composed['dkg:status'] = status;
  }
  if (revokedAt) {
    composed['dkg:revokedAt'] = {
      '@value': revokedAt,
      '@type': 'xsd:dateTime',
    };
  }
  return composed as KafkaEndpointKnowledgeAsset;
}

function ownerFromPublisherUri(publisher: string): string {
  // Owner URIs have the shape `urn:dkg:agent:<address>` (canonical) or, for
  // legacy / cross-network callers, `did:dkg:agent:<address>`. The builder
  // re-lower-cases the address; we just need to extract it.
  if (publisher.startsWith('urn:dkg:agent:')) {
    return publisher.slice('urn:dkg:agent:'.length);
  }
  if (publisher.startsWith('did:dkg:agent:')) {
    return publisher.slice('did:dkg:agent:'.length);
  }
  // Defensive fallback: hand the raw string through. The builder lower-cases
  // it, which is the safe default for any URN-shaped publisher we haven't
  // explicitly handled yet.
  return publisher;
}

function parseEndpointRow(
  row: Record<string, string>,
  contextGraphId: string,
): KafkaEndpointSummary {
  const summary: KafkaEndpointSummary = {
    uri: stripIriDelimiters(row.endpoint ?? ''),
    contextGraphId,
    broker: stripQuotedLiteral(row.broker ?? ''),
    topic: stripQuotedLiteral(row.topic ?? ''),
    messageFormat: stripQuotedLiteral(row.messageFormat ?? ''),
    publisher: stripIriDelimiters(row.publisher ?? ''),
    endpointUrl: stripIriDelimiters(row.endpointUrl ?? ''),
    issued: stripQuotedLiteral(row.issued ?? ''),
  };
  if (row.verificationStatus) {
    summary.verificationStatus = stripQuotedLiteral(row.verificationStatus);
  }
  if (row.verifiedAt) summary.verifiedAt = stripQuotedLiteral(row.verifiedAt);
  if (row.securityProtocol) {
    summary.securityProtocol = stripQuotedLiteral(row.securityProtocol);
  }
  if (row.status) summary.status = stripQuotedLiteral(row.status);
  if (row.revokedAt) summary.revokedAt = stripQuotedLiteral(row.revokedAt);
  return summary;
}

function stripQuotedLiteral(value: string): string {
  // Match the daemon's wire shape: `"value"^^<typeIri>` or bare `"value"`.
  // The /s flag handles literals with embedded newlines (rare for this KA
  // shape but cheap defence).
  const typed = value.match(/^"(.*)"(?:\^\^<.*>)?$/s);
  return typed ? typed[1] : value;
}

function stripIriDelimiters(value: string): string {
  if (value.startsWith('<') && value.endsWith('>')) {
    return value.slice(1, -1);
  }
  return value;
}
