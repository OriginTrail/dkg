import { buildKafkaEndpointKnowledgeAsset } from './ka-builder.js';
import { buildKafkaEndpointUri } from './uri.js';
import type { KafkaContextGraphSelection } from './validation.js';

/**
 * Dependency-inversion boundary: the kafka package needs something that can
 * publish a JSON-LD knowledge asset. The package hands the bare KA across this
 * interface; envelope wrapping (e.g. `{ public: ... }`) belongs to the caller.
 */
export type KafkaEndpointKnowledgeAsset = ReturnType<typeof buildKafkaEndpointKnowledgeAsset>;

export interface KafkaEndpointPublisher {
  publish(
    contextGraphId: string,
    knowledgeAsset: KafkaEndpointKnowledgeAsset,
  ): Promise<unknown>;
}

export type CgScope = 'local' | 'shared';

export interface RegisterKafkaEndpointInput {
  /** Pre-validated selection produced by `validateContextGraphSelection`. */
  selection: KafkaContextGraphSelection;
  owner: string;
  broker: string;
  topic: string;
  messageFormat: string;
  issuedAt?: string;
  publisher: KafkaEndpointPublisher;
  /**
   * Required when `selection.kind === 'local'`. Resolves the destination CG
   * id by lazily creating `kafka-local` if needed. The orchestrator stays
   * agent-agnostic by depending on this thunk rather than importing the V10
   * primitive directly — see `local-cg.ts` for the concrete implementation
   * the route handler binds.
   */
  ensureLocalCg?: () => Promise<string>;
}

export interface RegisterKafkaEndpointResult {
  uri: string;
  contextGraphId: string;
  cgScope: CgScope;
}

export async function registerKafkaEndpoint(
  input: RegisterKafkaEndpointInput,
): Promise<RegisterKafkaEndpointResult> {
  let resolvedContextGraphId: string;
  let cgScope: CgScope;

  if (input.selection.kind === 'shared') {
    resolvedContextGraphId = input.selection.contextGraphId;
    cgScope = 'shared';
  } else {
    if (!input.ensureLocalCg) {
      throw new Error(
        '"ensureLocalCg" is required when selection.kind is "local". ' +
        'The route handler must bind a thunk that lazy-creates the kafka-local free CG.',
      );
    }
    resolvedContextGraphId = await input.ensureLocalCg();
    cgScope = 'local';
  }

  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const uri = buildKafkaEndpointUri(input);
  const knowledgeAsset = buildKafkaEndpointKnowledgeAsset({
    owner: input.owner,
    broker: input.broker,
    topic: input.topic,
    messageFormat: input.messageFormat,
    issuedAt,
  });

  await input.publisher.publish(resolvedContextGraphId, knowledgeAsset);

  return {
    uri,
    contextGraphId: resolvedContextGraphId,
    cgScope,
  };
}
