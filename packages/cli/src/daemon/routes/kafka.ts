import { jsonResponse, readBody, validateRequiredContextGraphId } from '../http-utils.js';
import type { RequestContext } from './context.js';
import {
  registerKafkaEndpoint,
  type KafkaEndpointPublisher,
} from '@origintrail-official/dkg-kafka';

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
      broker,
      topic,
      messageFormat,
    } = parsed as Record<string, unknown>;

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

    const publisher: KafkaEndpointPublisher = {
      async publish(targetContextGraphId, content) {
        await agent.publish(
          targetContextGraphId,
          { public: content } as Record<string, unknown>,
        );
      },
    };

    const result = await registerKafkaEndpoint({
      contextGraphId: targetContextGraphId,
      owner: requestAgentAddress.toLowerCase(),
      broker,
      topic,
      messageFormat,
      publisher,
    });

    return jsonResponse(res, 200, result);
  }
}
