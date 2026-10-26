/** Registry wire contract. This entrypoint has no daemon/runtime imports. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sparqlIri } from '@origintrail-official/dkg-core';

export const STREAMS = 'https://ontology.dkg.io/streams#';
export const SCHEMA = 'https://schema.org/';
export const agentAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => v.toLowerCase());
export const registryIriSchema = z.string().min(1).max(2048).refine(value => {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  try { sparqlIri(value); return true; } catch { return false; }
}, 'Expected an absolute RDF IRI');
const contextGraphIdSchema = z.string().min(1).max(256).regex(/^[\w:/.@-]+$/);

/** Existing request fields remain valid; domain/entity references are optional. */
export const streamRegistrationSchema = z.object({
  name: z.string().min(1),
  kafkaBootstrapUrl: z.string().min(1).refine(value => {
    // Preserve legacy opaque endpoint strings, but never accept credentials or
    // URL parameters embedded in a structured bootstrap address.
    let url;
    try { url = new URL(value); } catch { return true; }
    return !url.username && !url.password && !url.search && !url.hash;
  }, 'Bootstrap metadata must not embed credentials, query parameters or fragments'),
  kafkaTopicName: z.string().min(1),
  description: z.string().optional(),
  kafkaAuthMethod: z.string().optional(),
  kafkaSaslMechanism: z.string().optional(),
  dataFormat: z.string().default('JSON'),
  clusterId: z.string().min(1).max(256).optional(),
  providerIri: registryIriSchema.optional(),
  schemaIri: registryIriSchema.optional(),
  about: z.array(registryIriSchema).max(64).transform(values => values.length ? [...new Set(values)].sort() : undefined).optional(),
}).strict();

export const streamDescriptorSchema = streamRegistrationSchema.extend({
  registeredByAgentAddress: agentAddressSchema.optional(),
}).strict();
export type KafkaStreamDescriptor = z.infer<typeof streamDescriptorSchema>;

export const registryEntrySchema = z.object({
  version: z.literal(1),
  ual: registryIriSchema,
  contextGraphId: contextGraphIdSchema,
  publisherIri: registryIriSchema.optional(),
  descriptor: streamDescriptorSchema,
  descriptorHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
export type KafkaRegistryEntry = z.infer<typeof registryEntrySchema>;

export function descriptorHash(descriptor: KafkaStreamDescriptor): string {
  // Zod fixes field order; about is a sorted, duplicate-free set. Extensions
  // cannot silently change the transport/provenance snapshot being enrolled.
  const normalized = streamDescriptorSchema.parse(descriptor);
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

export function validateRegistryEntry(value: unknown): KafkaRegistryEntry {
  const entry = registryEntrySchema.parse(value);
  if (descriptorHash(entry.descriptor) !== entry.descriptorHash) throw new Error('KAFKA_REGISTRY_HASH_MISMATCH');
  return entry;
}

/** Convert the plugin's canonical JSON-LD response, not arbitrary JSON-LD. */
export function descriptorFromKa(ka: Record<string, unknown>): KafkaStreamDescriptor {
  const context = ka['@context'] as Record<string, unknown> | undefined;
  if (context?.['dkg-streams'] !== STREAMS || context?.schema !== SCHEMA) {
    throw new Error('KAFKA_REGISTRY_CONTEXT_MISMATCH');
  }
  const types = Array.isArray(ka['@type']) ? ka['@type'] : [ka['@type']];
  if (!types.includes('dkg-streams:KafkaStream')) throw new Error('KAFKA_REGISTRY_TYPE_REQUIRED');
  const fields: Record<string, unknown> = {};
  for (const field of Object.keys(streamDescriptorSchema.shape)) {
    const key = field === 'name' || field === 'description' || field === 'about'
      ? `schema:${field}` : `dkg-streams:${field}`;
    const value = ka[key];
    if (value === undefined) continue;
    if (field === 'about') {
      fields[field] = (Array.isArray(value) ? value : [value]).map(iriValue);
    } else if (field === 'providerIri' || field === 'schemaIri') {
      fields[field] = iriValue(value);
    } else fields[field] = value;
  }
  return streamDescriptorSchema.parse(fields);
}

function iriValue(value: unknown): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)['@id'] : value;
}

export function createRegistryEntry(
  ka: Record<string, unknown>, ual: string, contextGraphId: string, publisherIri?: string,
): KafkaRegistryEntry {
  const descriptor = descriptorFromKa(ka);
  return registryEntrySchema.parse({ version: 1, ual, contextGraphId,
    ...(publisherIri ? { publisherIri } : {}), descriptor, descriptorHash: descriptorHash(descriptor) });
}
