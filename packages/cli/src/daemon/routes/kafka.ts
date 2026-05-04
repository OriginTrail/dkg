import { jsonResponse, readBody, isValidContextGraphId } from '../http-utils.js';
import type { RequestContext } from './context.js';
import {
  ensureKafkaLocalCg,
  registerKafkaEndpoint,
  validateContextGraphSelection,
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
      useLocalCg,
      broker,
      topic,
      messageFormat,
    } = parsed as Record<string, unknown>;

    // ADR-0004: explicit local-vs-shared CG choice. The pure validation
    // module enforces "exactly one of contextGraphId or useLocalCg" — neither
    // and both are 4xx with a clear message naming both options. We rethrow
    // its message into the daemon's standard error envelope.
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

    const publisher: KafkaEndpointPublisher = {
      async publish(cgId, content) {
        await agent.publish(
          cgId,
          { public: content } as Record<string, unknown>,
        );
      },
    };

    // Bind the V10 free-CG primitive to the local-cg module's expected shape.
    // The `kafka-local` CG is a free CG: created locally via
    // `agent.createContextGraph` with no on-chain registration.
    const ensureLocalCg = () =>
      ensureKafkaLocalCg({
        contextGraphExists: (id) => agent.contextGraphExists(id),
        createContextGraph: (opts) =>
          agent.createContextGraph({
            ...opts,
            callerAgentAddress: requestAgentAddress,
          }),
      });

    const result = await registerKafkaEndpoint({
      selection,
      owner: requestAgentAddress.toLowerCase(),
      broker,
      topic,
      messageFormat,
      publisher,
      ensureLocalCg,
    });

    return jsonResponse(res, 200, result);
  }
}
