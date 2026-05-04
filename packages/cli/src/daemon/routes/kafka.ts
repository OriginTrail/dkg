import {
  isNonEmptyString,
  jsonResponse,
  readBody,
  validateOptionalBoolean,
  validateRequiredContextGraphId,
} from '../http-utils.js';
import { wrapJsonLdContent } from '../json-ld-envelope.js';
import type { RequestContext } from './context.js';
import {
  registerKafkaEndpoint,
  type KafkaEndpointPublisher,
} from '@origintrail-official/dkg-kafka';

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
      private: privateField,
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

    if (!validateOptionalBoolean(privateField, 'private', res)) return;

    // `!== false` is intentional: only literal `false` opts in to public; omitted/undefined defaults to private.
    // Do NOT tighten to `=== true` — that would silently break the omitted-defaults-to-private contract.
    const isPrivate = privateField !== false;

    const publisher: KafkaEndpointPublisher = {
      async publish(cgId, content) {
        await agent.publish(cgId, wrapJsonLdContent(content, { private: isPrivate }));
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

    return jsonResponse(res, 200, { ...result, private: isPrivate });
  }
}
