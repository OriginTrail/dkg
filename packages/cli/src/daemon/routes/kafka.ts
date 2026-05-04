import { jsonResponse, readBody, validateRequiredContextGraphId } from '../http-utils.js';
import type { RequestContext } from './context.js';
import {
  KafkaEndpointProbeFailedError,
  probe as kafkaProbe,
  registerKafkaEndpoint,
  type KafkaEndpointPublisher,
  type KafkaProbeOptions,
  type KafkaProbeSaslCredentials,
  type KafkaProbeSslMaterial,
  type ProbeResult,
  type SecurityProtocol,
} from '@origintrail-official/dkg-kafka';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const VALID_PROTOCOLS: ReadonlySet<SecurityProtocol> = new Set([
  'PLAINTEXT',
  'SASL_PLAINTEXT',
  'SASL_SSL',
  'SSL',
]);

const VALID_SASL_MECHANISMS: ReadonlySet<KafkaProbeSaslCredentials['mechanism']> = new Set([
  'plain',
  'scram-sha-256',
  'scram-sha-512',
]);

interface KafkaEndpointRequestBody {
  contextGraphId: string;
  broker: string;
  topic: string;
  messageFormat: string;
  securityProtocol?: SecurityProtocol;
  sasl?: KafkaProbeSaslCredentials;
  ssl?: KafkaProbeSslMaterial;
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
 */
function shouldProbe(body: KafkaEndpointRequestBody): boolean {
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

function parseSecurityProtocol(value: unknown): SecurityProtocol | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.toUpperCase();
  return VALID_PROTOCOLS.has(upper as SecurityProtocol)
    ? (upper as SecurityProtocol)
    : undefined;
}

function parseSasl(value: unknown): KafkaProbeSaslCredentials | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.username !== 'string' || typeof v.password !== 'string') return undefined;
  const mechanism = typeof v.mechanism === 'string' ? v.mechanism.toLowerCase() : 'plain';
  if (!VALID_SASL_MECHANISMS.has(mechanism as KafkaProbeSaslCredentials['mechanism'])) {
    return undefined;
  }
  return {
    mechanism: mechanism as KafkaProbeSaslCredentials['mechanism'],
    username: v.username,
    password: v.password,
  };
}

function parseSsl(value: unknown): KafkaProbeSslMaterial | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const out: KafkaProbeSslMaterial = {};
  if (typeof v.ca === 'string') out.caPem = v.ca;
  if (typeof v.cert === 'string') out.certPem = v.cert;
  if (typeof v.key === 'string') out.keyPem = v.key;
  if (typeof v.caPath === 'string') out.caPath = v.caPath;
  if (typeof v.certPath === 'string') out.certPath = v.certPath;
  if (typeof v.keyPath === 'string') out.keyPath = v.keyPath;
  if (typeof v.rejectUnauthorized === 'boolean') {
    out.rejectUnauthorized = v.rejectUnauthorized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function handleKafkaRoutes(ctx: RequestContext): Promise<void> {
  const {
    req,
    res,
    agent,
    path,
    url,
    requestAgentAddress,
  } = ctx;

  if (req.method === 'POST' && path === '/api/kafka/endpoint') {
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

    const reqBody: KafkaEndpointRequestBody = {
      contextGraphId: targetContextGraphId,
      broker,
      topic,
      messageFormat,
      ...(securityProtocol ? { securityProtocol } : {}),
      ...(parseSasl(raw.sasl) ? { sasl: parseSasl(raw.sasl)! } : {}),
      ...(parseSsl(raw.ssl) ? { ssl: parseSsl(raw.ssl)! } : {}),
    };

    // `?force=true` overrides a non-verified probe outcome. We honor `1`
    // and `true` (case-insensitive) as truthy; any other value is treated
    // as false. The flag is only consulted when a probe ran AND failed.
    const forceParam = (url.searchParams.get('force') ?? '').trim().toLowerCase();
    const force = forceParam === 'true' || forceParam === '1';

    const publisher: KafkaEndpointPublisher = {
      async publish(cgId, content) {
        await agent.publish(
          cgId,
          { public: content } as Record<string, unknown>,
        );
      },
    };

    let probeResult: ProbeResult | undefined;
    if (shouldProbe(reqBody) && reqBody.securityProtocol) {
      const probeOpts: KafkaProbeOptions = {
        brokers: [reqBody.broker],
        topic: reqBody.topic,
        securityProtocol: reqBody.securityProtocol,
        ...(reqBody.sasl ? { sasl: reqBody.sasl } : {}),
        ...(reqBody.ssl ? { ssl: reqBody.ssl } : {}),
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
        ...(reqBody.securityProtocol ? { securityProtocol: reqBody.securityProtocol } : {}),
        ...(probeResult
          ? {
              probe: {
                status: probeResult.status,
                probedAt: probeResult.probedAt,
              },
            }
          : {}),
        force,
      });

      return jsonResponse(res, 200, result);
    } catch (err) {
      if (err instanceof KafkaEndpointProbeFailedError) {
        // Surface the probe outcome (sans credentials) so the CLI / API client
        // can render a meaningful failure. The `verificationStatus` reflects
        // what would have been written had the caller passed `force=true`.
        return jsonResponse(res, 422, {
          error: err.message,
          probe: {
            status: err.outcome.status,
            probedAt: err.outcome.probedAt,
          },
          // Surface the safe error string from the underlying probe call so
          // the CLI can render it in the UX. Already classified to a type
          // name, never carries a credential substring.
          probeError: probeResult?.error,
        });
      }
      throw err;
    }
  }
}
