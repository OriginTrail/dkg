import type { z } from 'zod';
import { streamRegistrationSchema } from './registry.js';

export const coreSchema = streamRegistrationSchema;

export type CoreFields = z.infer<typeof coreSchema>;

// `messageSchema` deferred post-MVP (see CONTEXT.md). Object-valued fields
// become blank-node sub-graphs the one-hop discovery query can't rebuild.
export const CORE_FIELDS: readonly (keyof CoreFields)[] = [
  'name',
  'kafkaBootstrapUrl',
  'kafkaTopicName',
  'description',
  'kafkaAuthMethod',
  'kafkaSaslMechanism',
  'dataFormat',
  'clusterId',
  'providerIri',
  'schemaIri',
  'about',
];
