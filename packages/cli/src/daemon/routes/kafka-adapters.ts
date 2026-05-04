// Adapters that bind the daemon's `DKGAgent` to the small interfaces the
// `@origintrail-official/dkg-kafka` package depends on. Kept on the CLI side
// because the agent type lives here; the kafka package stays agent-agnostic.
//
// Slice 02 only consumes these from `routes/kafka.ts`; later kafka routes
// (discover, revoke) will reuse them — one home, one responsibility each.

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type {
  KafkaEndpointPublisher,
  LocalCgPrimitive,
} from '@origintrail-official/dkg-kafka';

/**
 * Wraps `agent.publish` with the daemon's `{ public: content }` envelope so
 * the kafka package can stay envelope-agnostic.
 */
export function kafkaPublisherFromAgent(agent: DKGAgent): KafkaEndpointPublisher {
  return {
    async publish(contextGraphId, knowledgeAsset) {
      await agent.publish(
        contextGraphId,
        { public: knowledgeAsset } as Record<string, unknown>,
      );
    },
  };
}

/**
 * Adapts the agent's free-CG surface to the `LocalCgPrimitive` shape the
 * `kafka-local` ensurer consumes. `callerAgentAddress` is threaded into
 * `createContextGraph` so the create runs under the requesting agent.
 */
export function kafkaLocalCgFromAgent(
  agent: DKGAgent,
  callerAgentAddress: string,
): LocalCgPrimitive {
  return {
    contextGraphExists: (id) => agent.contextGraphExists(id),
    createContextGraph: (opts) =>
      agent.createContextGraph({ ...opts, callerAgentAddress }),
  };
}
