import { z } from 'zod';

export const coreSchema = z
  .object({
    name: z.string().min(1),
    kafkaBootstrapUrl: z.string().min(1),
    kafkaTopicName: z.string().min(1),
    description: z.string().optional(),
    kafkaAuthMethod: z.string().optional(),
    kafkaSaslMechanism: z.string().optional(),
    dataFormat: z.string().default('JSON'),
  })
  .strict();

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
];
