import { jsonResponse, readBody, isValidContextGraphId } from '../http-utils.js';
import type { RequestContext } from './context.js';
import {
  createKafkaLocalCgEnsurer,
  registerKafkaEndpoint,
  validateContextGraphSelection,
} from '@origintrail-official/dkg-kafka';
import {
  kafkaLocalCgFromAgent,
  kafkaPublisherFromAgent,
} from './kafka-adapters.js';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function handleKafkaRoutes(ctx: RequestContext): Promise<void> {
  const {
    req,
    res,
    agent,
    path,
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

    const {
      contextGraphId,
      useLocalCg,
      broker,
      topic,
      messageFormat,
    } = parsed as Record<string, unknown>;

    // ADR-0004: explicit local-vs-shared CG choice. We surface the pure
    // validator's error message via the daemon's standard 400 envelope.
    let selection;
    try {
      selection = validateContextGraphSelection({ contextGraphId, useLocalCg });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 400, { error: message });
    }

    if (selection.kind === 'shared' && !isValidContextGraphId(selection.contextGraphId)) {
      return jsonResponse(res, 400, { error: 'Invalid "contextGraphId"' });
    }

    if (!isNonEmptyString(broker)) {
      return jsonResponse(res, 400, { error: '"broker" must be a non-empty string' });
    }
    if (!isNonEmptyString(topic)) {
      return jsonResponse(res, 400, { error: '"topic" must be a non-empty string' });
    }
    if (!isNonEmptyString(messageFormat)) {
      return jsonResponse(res, 400, { error: '"messageFormat" must be a non-empty string' });
    }

    const result = await registerKafkaEndpoint({
      selection,
      owner: requestAgentAddress.toLowerCase(),
      broker,
      topic,
      messageFormat,
      publisher: kafkaPublisherFromAgent(agent),
      ensureLocalCg: createKafkaLocalCgEnsurer(
        kafkaLocalCgFromAgent(agent, requestAgentAddress),
      ),
    });

    return jsonResponse(res, 200, result);
  }
}
