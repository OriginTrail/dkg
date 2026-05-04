import { jsonResponse, readBody, validateRequiredContextGraphId } from '../http-utils.js';
import {
  isNonEmptyString,
  parseSasl,
  parseSecurityProtocol,
  parseSsl,
  shouldProbe,
  type KafkaEndpointRequestBody,
} from '../parsers/kafka-request.js';
import type { RequestContext } from './context.js';
import {
  KafkaEndpointProbeFailedError,
  probe as kafkaProbe,
  registerKafkaEndpoint,
  type KafkaEndpointPublisher,
  type KafkaProbeOptions,
  type ProbeResult,
} from '@origintrail-official/dkg-kafka';

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
                ...(probeResult.error ? { error: probeResult.error } : {}),
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
        // The probe error string is part of the typed outcome — already
        // classified to a kafkajs class name, never carries credential
        // substrings.
        return jsonResponse(res, 422, {
          error: err.message,
          probe: {
            status: err.outcome.status,
            probedAt: err.outcome.probedAt,
          },
          ...(err.outcome.error ? { probeError: err.outcome.error } : {}),
        });
      }
      throw err;
    }
  }
}
