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
import { verifyTokenScope, type Scope } from '../../auth.js';
import type { RequestContext } from './context.js';
import {
  getKafkaEndpoint,
  isValidKafkaEndpointUri,
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

/**
 * Per-route scope guard. Returns true when the caller's bearer token
 * carries `scope` (or wildcard `*`); when false, a 403 (NOT 401) has
 * already been written to the response — caller must early-return.
 *
 * 403 distinguishes "valid token, wrong permission" from 401's "no /
 * invalid token". The httpAuthGuard at the top of the request pipeline
 * already enforces 401; by the time a kafka handler runs we know the
 * token is valid, so any rejection here is a scope mismatch.
 *
 * No `WWW-Authenticate` header — that header is reserved for 401
 * responses by RFC 7235; sending it on a 403 confuses clients about
 * whether to re-prompt for credentials.
 *
 * When `auth.enabled = false` the guard short-circuits to true (Codex
 * bug 1). `httpAuthGuard` already bypasses auth in that mode, so a
 * scope check that ignored the flag would 403 requests that used to
 * succeed unauthenticated — a regression for every operator running
 * with auth disabled (typical dev/test setup).
 */
function requireScope(ctx: RequestContext, scope: Scope): boolean {
  if (!ctx.authEnabled) return true;
  if (verifyTokenScope(ctx.requestToken, scope, ctx.tokenStore)) return true;
  jsonResponse(ctx.res, 403, {
    error: `Token lacks required scope: ${scope}`,
  });
  return false;
}

export async function handleKafkaRoutes(ctx: RequestContext): Promise<void> {
  const { req, path } = ctx;

  // POST /api/kafka/endpoint — register (write)
  if (req.method === 'POST' && path === ENDPOINT_BASE_PATH) {
    if (!requireScope(ctx, 'kafka:endpoint:write')) return;
    return handleRegister(ctx);
  }

  // POST /api/kafka/endpoint/verify — re-verify (write — mutates the KA)
  if (req.method === 'POST' && path === `${ENDPOINT_BASE_PATH}/verify`) {
    if (!requireScope(ctx, 'kafka:endpoint:write')) return;
    return handleVerify(ctx);
  }

  // GET /api/kafka/endpoint?contextGraphId=X[&status=...] — list (read)
  if (req.method === 'GET' && path === ENDPOINT_BASE_PATH) {
    if (!requireScope(ctx, 'kafka:endpoint:read')) return;
    return handleList(ctx);
  }

  // GET /api/kafka/endpoint/<urlencoded-uri> — single fetch (read)
  if (req.method === 'GET' && path.startsWith(`${ENDPOINT_BASE_PATH}/`)) {
    if (!requireScope(ctx, 'kafka:endpoint:read')) return;
    return handleGetByUri(ctx);
  }

  // DELETE /api/kafka/endpoint/<urlencoded-uri> — soft-revoke (write)
  if (req.method === 'DELETE' && path.startsWith(`${ENDPOINT_BASE_PATH}/`)) {
    if (!requireScope(ctx, 'kafka:endpoint:write')) return;
    return handleRevoke(ctx);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a `KafkaEndpointPublisher` adapter for a route's `agent`. Both
 * `publish` and `update` delegate to the agent's URI-keyed JSON-LD overloads
 * (`agent.publish(cgId, content)` and `agent.update(uri, cgId, content)`),
 * which encapsulate the kcId lookup + JSON-LD → quads conversion. The kafka
 * package — and this adapter — never see kcIds.
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
      await agent.update(uri, cgId, { public: content as object });
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
  const { res, url } = ctx;
  const uri = extractEndpointUri(ctx);
  if (uri === null) return; // response already sent
  const contextGraphId = url.searchParams.get('contextGraphId');
  if (!validateRequiredContextGraphId(contextGraphId, res)) return;

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
  // Same strict validation as the path-based verbs (`extractEndpointUri`).
  // Without this, the URI lands in a SPARQL IRI position via
  // `getKafkaEndpoint` / `agent.update` — see review C2.
  if (!isValidKafkaEndpointUri(uri)) {
    return jsonResponse(res, 400, {
      error:
        '"uri" must match urn:dkg:kafka-endpoint:<owner>:<sha256-hex-64>',
    });
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

  // Parse-only step: `parseSasl` / `parseSsl` throw `KafkaRequestParseError`
  // on present-but-malformed payloads (wrong type, unknown mechanism,
  // non-string PEM, …). Shape-consistency and "any creds at all" gates run
  // LATER, after we've loaded the existing KA — the verify route is documented
  // to default `broker`, `topic`, and `securityProtocol` from the recorded
  // values, and the gates need to see those effective inputs (Bug 1
  // regression: running them on the bare body 400'd legitimate
  // "URI + sasl" requests because `securityProtocol` was undefined before
  // defaulting, and 400'd URI-only re-verifies of stored PLAINTEXT KAs).
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
  } catch (err) {
    if (err instanceof KafkaRequestParseError) {
      return jsonResponse(res, 400, { error: err.publicMessage });
    }
    throw err;
  }

  const queryEngine = buildKafkaEndpointQueryEngine(ctx);
  const publisher = buildKafkaEndpointPublisher(ctx);

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

  // Now that defaulting is done, run the shape-consistency check and the
  // creds-required gate against the EFFECTIVE values the probe will see.
  // `validateKafkaAuthConsistency` catches sasl-without-protocol etc. once
  // the protocol has fallen back from `existing.securityProtocol`;
  // `hasAnyKafkaCredentials` accepts a stored PLAINTEXT advertisement as
  // sufficient (per ADR 0002).
  const effectiveBody: KafkaEndpointVerifyRequestBody = {
    ...verifyBody,
    broker: probeBroker,
    topic: probeTopic,
    securityProtocol: probeSecurityProtocol,
  };
  try {
    validateKafkaAuthConsistency({
      contextGraphId: contextGraphId as string,
      broker: probeBroker,
      topic: probeTopic,
      messageFormat: existing.messageFormat,
      securityProtocol: probeSecurityProtocol,
      sasl: verifyBody.sasl,
      ssl: verifyBody.ssl,
    });
  } catch (err) {
    if (err instanceof KafkaRequestParseError) {
      return jsonResponse(res, 400, { error: err.publicMessage });
    }
    throw err;
  }

  // The verify verb requires creds. ADR 0002 distinguishes register
  // (unattempted is acceptable when no creds) from verify (whose contract is
  // "tell me what the broker says, write it down"). Without any creds at all
  // — neither SASL/SSL material nor an explicit (or recorded) PLAINTEXT
  // advertisement — there is no probe to run; reject as 400.
  if (!hasAnyKafkaCredentials(effectiveBody)) {
    return jsonResponse(res, 400, {
      error:
        'Re-verify requires credentials: pass sasl (username/password), ssl (cert/key), ' +
        'or securityProtocol="PLAINTEXT" (or re-verify a stored PLAINTEXT endpoint). ' +
        'To register without verifying, use POST /api/kafka/endpoint.',
    });
  }

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
      // I6 consequential: pass the already-fetched KA so the package layer
      // skips its own re-read.
      existing,
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
 * path. Returns `null` if the path is malformed (and a 4xx has already been
 * sent on the response). The `urn:dkg:kafka-endpoint:…` scheme contains
 * colons that must round-trip through `encodeURIComponent` /
 * `decodeURIComponent` cleanly.
 *
 * Sub-paths beyond `/<uri>` (e.g. `/<uri>/something`) are rejected as 404 —
 * a URN never contains an unencoded `/`, so an extra path segment means the
 * route is undefined.
 *
 * Validation goes through `isValidKafkaEndpointUri` (the kafka package's
 * strict regex on `urn:dkg:kafka-endpoint:<owner>:<sha256-hex-64>`). A loose
 * `startsWith` check would have left every URI interpolation site downstream
 * exposed to SPARQL injection — see review C1.
 */
function extractEndpointUri(ctx: RequestContext): string | null {
  const { res, path } = ctx;
  const encoded = path.slice(`${ENDPOINT_BASE_PATH}/`.length);
  if (!encoded || encoded.startsWith('?')) {
    jsonResponse(res, 400, { error: 'Missing endpoint URI in path' });
    return null;
  }
  // The encoded URI must be a single path segment. An unencoded `/` indicates
  // either a sub-path (no such route) or a caller that forgot to URL-encode.
  // 404 is the right code: the path doesn't map to a defined route.
  if (encoded.includes('/')) {
    jsonResponse(res, 404, { error: 'Not found' });
    return null;
  }
  const decoded = safeDecodeURIComponent(encoded, res);
  if (decoded === null) return null; // safeDecodeURIComponent already sent 400
  if (!isValidKafkaEndpointUri(decoded)) {
    jsonResponse(res, 400, {
      error:
        '"uri" must match urn:dkg:kafka-endpoint:<owner>:<sha256-hex-64>',
    });
    return null;
  }
  return decoded;
}
