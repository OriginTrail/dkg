import { jsonLdToQuads, type JsonLdContent } from '@origintrail-official/dkg-agent';
import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { jsonResponse, readBody, safeDecodeURIComponent, validateRequiredContextGraphId } from '../http-utils.js';
import {
  hasAnyKafkaCredentials,
  isNonEmptyString,
  KafkaRequestParseError,
  parseSasl,
  parseSecurityProtocol,
  parseSsl,
  shouldProbe,
  validateKafkaAuthConsistency,
  type KafkaEndpointRequestBody,
  type KafkaEndpointVerifyRequestBody,
} from '../parsers/kafka-request.js';
import type { RequestContext } from './context.js';
import {
  getKafkaEndpoint,
  KafkaEndpointProbeFailedError,
  listKafkaEndpoints,
  probe as kafkaProbe,
  registerKafkaEndpoint,
  revokeKafkaEndpoint,
  toKafkaEndpointProbeOutcome,
  verifyKafkaEndpoint,
  type KafkaEndpointListStatus,
  type KafkaEndpointPublisher,
  type KafkaEndpointQueryEngine,
  type KafkaProbeOptions,
  type ProbeResult,
} from '@origintrail-official/dkg-kafka';

const ENDPOINT_BASE_PATH = '/api/kafka/endpoint';

const VALID_LIST_STATUSES: ReadonlySet<KafkaEndpointListStatus> = new Set([
  'active',
  'revoked',
  'all',
]);

export async function handleKafkaRoutes(ctx: RequestContext): Promise<void> {
  const { req, path } = ctx;

  // POST /api/kafka/endpoint — register
  if (req.method === 'POST' && path === ENDPOINT_BASE_PATH) {
    return handleRegister(ctx);
  }

  // POST /api/kafka/endpoint/verify — re-verify
  if (req.method === 'POST' && path === `${ENDPOINT_BASE_PATH}/verify`) {
    return handleVerify(ctx);
  }

  // GET /api/kafka/endpoint?contextGraphId=X[&status=...] — list
  if (req.method === 'GET' && path === ENDPOINT_BASE_PATH) {
    return handleList(ctx);
  }

  // GET /api/kafka/endpoint/<urlencoded-uri> — single fetch
  if (req.method === 'GET' && path.startsWith(`${ENDPOINT_BASE_PATH}/`)) {
    return handleGetByUri(ctx);
  }

  // DELETE /api/kafka/endpoint/<urlencoded-uri> — soft-revoke
  if (req.method === 'DELETE' && path.startsWith(`${ENDPOINT_BASE_PATH}/`)) {
    return handleRevoke(ctx);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a `KafkaEndpointPublisher` adapter for a route's `agent`. `publish`
 * goes through `agent.publish` with the slice 01 envelope (`{ public: ka }`);
 * `update` resolves the URI to its V10 kcId via the meta graph and calls the
 * publisher's full-replace update flow with quads converted from the JSON-LD
 * KA. The kafka package never sees kcIds.
 */
function buildKafkaEndpointPublisher(
  ctx: RequestContext,
): KafkaEndpointPublisher {
  const { agent } = ctx;
  return {
    async publish(cgId, content) {
      await agent.publish(
        cgId,
        { public: content } as Record<string, unknown>,
      );
    },
    async update(cgId, uri, content) {
      const kcId = await resolveKcIdForUri(ctx, cgId, uri);
      if (kcId === null) {
        // The kafka-package side already verified the KA exists via the
        // queryEngine read; missing kcId here means the meta graph and the
        // data graph are out of sync, which should not happen on a healthy
        // node. Fail loudly so the operator can investigate.
        throw new Error(
          `Kafka endpoint ${uri} is present in CG "${cgId}" data graph but ` +
            `has no kcId in the corresponding _meta graph (cannot resolve V10 update target)`,
        );
      }
      const envelope: JsonLdContent = { public: content as object };
      const { publicQuads } = await jsonLdToQuads(envelope);
      await agent.update(kcId, cgId, publicQuads);
    },
  };
}

/**
 * Build a `KafkaEndpointQueryEngine` adapter that delegates to `agent.query`.
 * The kafka package's SPARQL already wraps every BGP in `GRAPH ?g`, so the
 * daemon engine's auto-wrap is a no-op — the query runs against the per-CG
 * named data graph as intended.
 */
function buildKafkaEndpointQueryEngine(
  ctx: RequestContext,
): KafkaEndpointQueryEngine {
  const { agent } = ctx;
  return {
    async query(sparql: string, contextGraphId: string) {
      const result = await agent.query(sparql, { contextGraphId });
      // `agent.query()` returns `{ bindings: [...] }` (the optional `type`
      // discriminator is only set on a couple of legacy paths — see the
      // slice 04 e2e fix for the same gotcha). Default to an empty array so
      // callers never have to discriminate.
      const bindings = (result?.bindings ?? []) as Array<Record<string, string>>;
      return { bindings };
    },
  };
}

const DKG_ONTOLOGY = 'http://dkg.io/ontology/';

/**
 * Resolve the V10 kcId (a.k.a. batchId) for an endpoint URI by querying the
 * CG's `_meta` graph. The `_meta` graph stores every published KA's
 * `dkg:rootEntity` → `dkg:partOf` → `dkg:batchId` chain (see
 * `packages/publisher/src/metadata.ts → generateConfirmedMetadata`).
 *
 * Returns `null` when no KA / KC is registered for the URI.
 */
async function resolveKcIdForUri(
  ctx: RequestContext,
  contextGraphId: string,
  uri: string,
): Promise<bigint | null> {
  const { agent } = ctx;
  const metaGraph = contextGraphMetaUri(contextGraphId);
  // We query the `_meta` graph directly (no `contextGraphId` option) because
  // the daemon engine's auto-wrap targets the data graph; the meta graph
  // lives at a different URI. Explicit `GRAPH <metaUri>` is the canonical
  // pattern (see `packages/publisher/src/metadata.ts` line 377).
  const sparql = `
    SELECT ?batchId WHERE {
      GRAPH <${metaGraph}> {
        ?ka <${DKG_ONTOLOGY}rootEntity> <${uri}> ;
            <${DKG_ONTOLOGY}partOf> ?kc .
        ?kc <${DKG_ONTOLOGY}batchId> ?batchId .
      }
    }
    LIMIT 1
  `;
  const result = await agent.query(sparql);
  const bindings = (result?.bindings ?? []) as Array<Record<string, unknown>>;
  if (bindings.length === 0) return null;
  const raw = bindings[0]['batchId'];
  // `agent.query` returns bindings either as plain strings (`"42"^^<...>`) or
  // SPARQL-JSON `{value, type, datatype}` objects depending on the wire
  // format. Handle both.
  const valueStr = typeof raw === 'string'
    ? stripTypedLiteral(raw)
    : (raw as { value?: string } | undefined)?.value;
  if (!valueStr) return null;
  try {
    return BigInt(valueStr);
  } catch {
    return null;
  }
}

function stripTypedLiteral(value: string): string {
  const m = value.match(/^"(.*)"(?:\^\^<.*>)?$/s);
  return m ? m[1] : value;
}

// ─── handlers ────────────────────────────────────────────────────────────────

async function handleRegister(ctx: RequestContext): Promise<void> {
  const { req, res, url, requestAgentAddress } = ctx;

  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON in request body' });
  }

  const raw = parsed as Record<string, unknown>;
  const { contextGraphId, broker, topic, messageFormat } = raw;

  if (!validateRequiredContextGraphId(contextGraphId, res)) {
    return;
  }
  const targetContextGraphId = contextGraphId as string;
  if (!isNonEmptyString(broker)) {
    return jsonResponse(res, 400, { error: '"broker" must be a non-empty string' });
  }
  if (!isNonEmptyString(topic)) {
    return jsonResponse(res, 400, { error: '"topic" must be a non-empty string' });
  }
  if (!isNonEmptyString(messageFormat)) {
    return jsonResponse(res, 400, { error: '"messageFormat" must be a non-empty string' });
  }

  const securityProtocol = parseSecurityProtocol(raw.securityProtocol);
  if (raw.securityProtocol !== undefined && !securityProtocol) {
    return jsonResponse(res, 400, {
      error: '"securityProtocol" must be one of PLAINTEXT, SASL_PLAINTEXT, SASL_SSL, SSL',
    });
  }

  // `parseSasl` / `parseSsl` throw `KafkaRequestParseError` on present-but-
  // malformed payloads (wrong type, unknown mechanism, non-string PEM, ...).
  // `validateKafkaAuthConsistency` throws on protocol/credential mismatch
  // (e.g. SASL_SSL with no sasl block, PLAINTEXT with sasl present). Both
  // translate to HTTP 400 so the caller learns about the misconfig up front,
  // instead of getting a confusing kafkajs auth failure later or — worse —
  // a `verificationStatus: "unattempted"` registration that silently
  // dropped the broken auth block. Error messages are sanitized by the
  // parser; safe to forward verbatim.
  let reqBody: KafkaEndpointRequestBody;
  try {
    const sasl = parseSasl(raw.sasl);
    const ssl = parseSsl(raw.ssl);
    reqBody = {
      contextGraphId: targetContextGraphId,
      broker,
      topic,
      messageFormat,
      securityProtocol,
      sasl,
      ssl,
    };
    validateKafkaAuthConsistency(reqBody);
  } catch (err) {
    if (err instanceof KafkaRequestParseError) {
      return jsonResponse(res, 400, { error: err.publicMessage });
    }
    throw err;
  }

  // `?force=true` overrides a non-verified probe outcome. We honor `1`
  // and `true` (case-insensitive) as truthy; any other value is treated
  // as false. The flag is only consulted when a probe ran AND failed.
  const forceParam = (url.searchParams.get('force') ?? '').trim().toLowerCase();
  const force = forceParam === 'true' || forceParam === '1';

  const publisher = buildKafkaEndpointPublisher(ctx);

  let probeResult: ProbeResult | undefined;
  if (shouldProbe(reqBody) && reqBody.securityProtocol) {
    const probeOpts: KafkaProbeOptions = {
      brokers: [reqBody.broker],
      topic: reqBody.topic,
      securityProtocol: reqBody.securityProtocol,
      sasl: reqBody.sasl,
      ssl: reqBody.ssl,
    };
    // `probe()` returns network/auth failures as structured results, but
    // throws on ill-formed input (e.g. SSL with no cert/key, unreadable PEM
    // path). Translate those into a 400 — they are caller errors, not
    // unexpected daemon faults. The error message is always a safe,
    // credential-free string composed in the kafka package.
    try {
      probeResult = await kafkaProbe(probeOpts);
    } catch (err) {
      return jsonResponse(res, 400, {
        error:
          err instanceof Error
            ? `Invalid Kafka probe options: ${err.message}`
            : 'Invalid Kafka probe options',
      });
    }
  }

  try {
    const result = await registerKafkaEndpoint({
      contextGraphId: targetContextGraphId,
      owner: requestAgentAddress.toLowerCase(),
      broker,
      topic,
      messageFormat,
      publisher,
      securityProtocol: reqBody.securityProtocol,
      probe: probeResult ? toKafkaEndpointProbeOutcome(probeResult) : undefined,
      force,
    });

    return jsonResponse(res, 200, result);
  } catch (err) {
    if (err instanceof KafkaEndpointProbeFailedError) {
      // Surface the probe outcome (sans credentials) so the CLI / API client
      // can render a meaningful failure. The `verificationStatus` reflects
      // what would have been written had the caller passed `force=true`.
      // The probe error string is part of the typed outcome — already
      // classified to a kafkajs class name, never carries credential
      // substrings.
      //
      // `probeStatus` and `probeError` are emitted at the top level so a CLI
      // client can render them without having to drill into the `probe`
      // sub-object. The nested `probe` block is retained for backwards
      // compatibility with any caller that already reads `probe.status` /
      // `probe.probedAt`.
      return jsonResponse(res, 422, {
        error: err.message,
        probeStatus: err.outcome.status,
        probeError: err.outcome.error,
        probe: {
          status: err.outcome.status,
          probedAt: err.outcome.probedAt,
        },
      });
    }
    throw err;
  }
}

async function handleList(ctx: RequestContext): Promise<void> {
  const { res, url } = ctx;
  const contextGraphId = url.searchParams.get('contextGraphId');
  if (!validateRequiredContextGraphId(contextGraphId, res)) return;

  const statusParam = url.searchParams.get('status');
  const status = (statusParam ?? 'active') as KafkaEndpointListStatus;
  if (!VALID_LIST_STATUSES.has(status)) {
    return jsonResponse(res, 400, {
      error: '"status" must be one of active, revoked, all',
    });
  }

  const queryEngine = buildKafkaEndpointQueryEngine(ctx);
  try {
    const result = await listKafkaEndpoints({
      contextGraphId: contextGraphId as string,
      queryEngine,
      status,
    });
    return jsonResponse(res, 200, result);
  } catch (err) {
    return jsonResponse(res, 500, {
      error: err instanceof Error ? err.message : 'Failed to list Kafka endpoints',
    });
  }
}

async function handleGetByUri(ctx: RequestContext): Promise<void> {
  const { res, url, path } = ctx;
  const uri = extractEndpointUri(ctx);
  if (uri === null) return; // response already sent
  const contextGraphId = url.searchParams.get('contextGraphId');
  if (!validateRequiredContextGraphId(contextGraphId, res)) return;

  // Defensive guard: if the caller hits a sub-path beyond `/<uri>` (e.g.
  // `/<uri>/something`), the URI extractor still treats it as a single segment
  // because the uri itself contains colons but no slashes. Reject any
  // unexpected trailing segment to avoid silent misroute.
  const remainder = path.slice(`${ENDPOINT_BASE_PATH}/`.length);
  if (remainder.includes('/')) {
    return jsonResponse(res, 404, { error: 'Not found' });
  }

  const queryEngine = buildKafkaEndpointQueryEngine(ctx);
  try {
    const result = await getKafkaEndpoint({
      contextGraphId: contextGraphId as string,
      uri,
      queryEngine,
    });
    if (!result) {
      return jsonResponse(res, 404, {
        error: `Kafka endpoint ${uri} not found in context graph "${contextGraphId}"`,
      });
    }
    return jsonResponse(res, 200, result);
  } catch (err) {
    return jsonResponse(res, 500, {
      error: err instanceof Error ? err.message : 'Failed to fetch Kafka endpoint',
    });
  }
}

async function handleRevoke(ctx: RequestContext): Promise<void> {
  const { res, url } = ctx;
  const uri = extractEndpointUri(ctx);
  if (uri === null) return;
  const contextGraphId = url.searchParams.get('contextGraphId');
  if (!validateRequiredContextGraphId(contextGraphId, res)) return;

  const queryEngine = buildKafkaEndpointQueryEngine(ctx);
  const publisher = buildKafkaEndpointPublisher(ctx);
  try {
    const result = await revokeKafkaEndpoint({
      contextGraphId: contextGraphId as string,
      uri,
      queryEngine,
      publisher,
    });
    return jsonResponse(res, 200, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to revoke Kafka endpoint';
    if (/not found/i.test(msg)) {
      return jsonResponse(res, 404, { error: msg });
    }
    return jsonResponse(res, 500, { error: msg });
  }
}

async function handleVerify(ctx: RequestContext): Promise<void> {
  const { req, res } = ctx;

  const rawBody = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON in request body' });
  }
  const raw = parsed as Record<string, unknown>;

  const { contextGraphId } = raw;
  if (!validateRequiredContextGraphId(contextGraphId, res)) return;

  const uri = raw.uri;
  if (!isNonEmptyString(uri)) {
    return jsonResponse(res, 400, { error: '"uri" must be a non-empty string' });
  }

  const securityProtocol = parseSecurityProtocol(raw.securityProtocol);
  if (raw.securityProtocol !== undefined && !securityProtocol) {
    return jsonResponse(res, 400, {
      error: '"securityProtocol" must be one of PLAINTEXT, SASL_PLAINTEXT, SASL_SSL, SSL',
    });
  }

  const brokerOverride = raw.broker;
  if (brokerOverride !== undefined && !isNonEmptyString(brokerOverride)) {
    return jsonResponse(res, 400, { error: '"broker" must be a non-empty string when provided' });
  }
  const topicOverride = raw.topic;
  if (topicOverride !== undefined && !isNonEmptyString(topicOverride)) {
    return jsonResponse(res, 400, { error: '"topic" must be a non-empty string when provided' });
  }

  // Slice 04: `parseSasl` / `parseSsl` throw `KafkaRequestParseError` on
  // present-but-malformed payloads, and `validateKafkaAuthConsistency`
  // rejects protocol/credential mismatch (e.g. sasl block with no
  // securityProtocol, sasl block paired with SSL, ...). Mirror the
  // register flow so verify gets the same fail-fast input contract.
  let verifyBody: KafkaEndpointVerifyRequestBody;
  try {
    const sasl = parseSasl(raw.sasl);
    const ssl = parseSsl(raw.ssl);
    verifyBody = {
      uri,
      broker: brokerOverride as string | undefined,
      topic: topicOverride as string | undefined,
      securityProtocol,
      sasl,
      ssl,
    };
    // The shape-consistency check only reads `securityProtocol` / `sasl` /
    // `ssl` — the broker/topic/messageFormat fields it nominally expects are
    // unread. Pass a minimal projection that satisfies the required-field
    // contract; broker/topic stay as defaults the verify route uses
    // separately.
    validateKafkaAuthConsistency({
      contextGraphId: contextGraphId as string,
      broker: verifyBody.broker ?? '',
      topic: verifyBody.topic ?? '',
      messageFormat: '',
      securityProtocol: verifyBody.securityProtocol,
      sasl: verifyBody.sasl,
      ssl: verifyBody.ssl,
    });
  } catch (err) {
    if (err instanceof KafkaRequestParseError) {
      return jsonResponse(res, 400, { error: err.publicMessage });
    }
    throw err;
  }

  const queryEngine = buildKafkaEndpointQueryEngine(ctx);
  const publisher = buildKafkaEndpointPublisher(ctx);

  // The verify verb requires creds. ADR 0002 distinguishes register
  // (unattempted is acceptable when no creds) from verify (whose contract is
  // "tell me what the broker says, write it down"). Without any creds at all
  // — neither SASL/SSL material nor an explicit PLAINTEXT advertisement —
  // there is no probe to run; reject as 400.
  if (!hasAnyKafkaCredentials(verifyBody)) {
    return jsonResponse(res, 400, {
      error:
        'Re-verify requires credentials: pass sasl (username/password), ssl (cert/key), ' +
        'or securityProtocol="PLAINTEXT". To register without verifying, use POST /api/kafka/endpoint.',
    });
  }

  // Fetch the existing KA so we can default broker/topic/securityProtocol
  // from its recorded values when the caller didn't override. ADR-recommended
  // behaviour: callers should be able to re-verify with just creds + uri.
  const existing = await getKafkaEndpoint({
    contextGraphId: contextGraphId as string,
    uri,
    queryEngine,
  });
  if (!existing) {
    return jsonResponse(res, 404, {
      error: `Kafka endpoint ${uri} not found in context graph "${contextGraphId}"`,
    });
  }

  const probeBroker = (verifyBody.broker ?? existing.broker) as string;
  const probeTopic = (verifyBody.topic ?? existing.topic) as string;
  const probeSecurityProtocol =
    (verifyBody.securityProtocol ?? existing.securityProtocol) as
      | KafkaProbeOptions['securityProtocol']
      | undefined;
  if (!probeSecurityProtocol) {
    return jsonResponse(res, 400, {
      error:
        '"securityProtocol" must be supplied (none recorded on the existing KA, and none in the request body)',
    });
  }

  const probeOpts: KafkaProbeOptions = {
    brokers: [probeBroker],
    topic: probeTopic,
    securityProtocol: probeSecurityProtocol,
    sasl: verifyBody.sasl,
    ssl: verifyBody.ssl,
  };

  let probeResult: ProbeResult;
  try {
    probeResult = await kafkaProbe(probeOpts);
  } catch (err) {
    return jsonResponse(res, 400, {
      error:
        err instanceof Error
          ? `Invalid Kafka probe options: ${err.message}`
          : 'Invalid Kafka probe options',
    });
  }

  try {
    const result = await verifyKafkaEndpoint({
      contextGraphId: contextGraphId as string,
      uri,
      queryEngine,
      publisher,
      probe: toKafkaEndpointProbeOutcome(probeResult),
    });
    return jsonResponse(res, 200, {
      ...result,
      probe: {
        status: probeResult.status,
        probedAt: probeResult.probedAt,
      },
      ...(probeResult.error ? { probeError: probeResult.error } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to verify Kafka endpoint';
    if (/not found/i.test(msg)) {
      return jsonResponse(res, 404, { error: msg });
    }
    return jsonResponse(res, 500, { error: msg });
  }
}

/**
 * Extract the URL-encoded URI from a `/api/kafka/endpoint/<urlencoded-uri>`
 * path. Returns `null` if the path is malformed (and a 400 has already been
 * sent on the response). The `urn:dkg:kafka-endpoint:…` scheme contains
 * colons that must round-trip through `encodeURIComponent` /
 * `decodeURIComponent` cleanly.
 */
function extractEndpointUri(ctx: RequestContext): string | null {
  const { res, path } = ctx;
  const encoded = path.slice(`${ENDPOINT_BASE_PATH}/`.length);
  if (!encoded || encoded.startsWith('?')) {
    jsonResponse(res, 400, { error: 'Missing endpoint URI in path' });
    return null;
  }
  const decoded = safeDecodeURIComponent(encoded, res);
  if (decoded === null) return null; // safeDecodeURIComponent already sent 400
  if (!decoded.startsWith('urn:dkg:kafka-endpoint:')) {
    jsonResponse(res, 400, {
      error: '"uri" must be a urn:dkg:kafka-endpoint: URI',
    });
    return null;
  }
  return decoded;
}
