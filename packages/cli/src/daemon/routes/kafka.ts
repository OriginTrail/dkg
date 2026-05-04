import {
  isNonEmptyString,
  jsonResponse,
  readBody,
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

    // Privacy boundary: enforce a strict boolean to keep the contract
    // unambiguous. Mirrors the strict typing applied above to
    // broker/topic/messageFormat — string "false", numbers, etc. are
    // rejected rather than silently coerced.
    if (privateField !== undefined && typeof privateField !== 'boolean') {
      return jsonResponse(res, 400, { error: '"private" must be a boolean' });
    }

    // Default to private: true. Callers opt into a public KA by sending
    // `private: false` in the request body. The `!== false` predicate is
    // intentional: only the literal boolean `false` flips to public; any
    // other accepted value (omitted/undefined, after the type-check above)
    // resolves to private. This is the safe failure mode for a
    // privacy-sensitive boundary — a future "tightening" to `=== true`
    // would silently break the omitted-defaults-to-private semantic.
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
