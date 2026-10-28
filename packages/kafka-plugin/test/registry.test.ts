import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { buildKa, mergeAugmentFragment } from '../src/ka-builder.js';
import { coreSchema } from '../src/schema.js';
import { createRegistryEntry, descriptorFromKa, descriptorHash, registryIriSchema,
  validateRegistryEntry, STREAMS } from '../src/registry.js';
import { parseRegistryFilters, registryFilterPattern } from '../src/registry-filters.js';
import { includeRegistry, withRegistry } from '../src/registry-response.js';
import { validateExtensionAgainstCore } from '../src/extension.js';

const input = { name: 'Application events', kafkaBootstrapUrl: 'kafka://broker.example:9094',
  kafkaTopicName: 'application.events', clusterId: 'example-cluster', providerIri: 'urn:provider:alpha',
  schemaIri: 'https://example.com/schema/v1', about: ['urn:app:b', 'urn:app:a', 'urn:app:a'] };
const ka = () => ({ ...buildKa(coreSchema.parse(input)), 'dkg-streams:registeredByAgentAddress': '0x' + 'A'.repeat(40) });
const ual = 'did:dkg:31337/0x' + 'a'.repeat(40) + '/1';

describe('generic registry contract', () => {
  it('represents multiple arbitrary entities as IRIs without requiring tenants or devices', () => {
    const descriptor = descriptorFromKa(ka());
    expect(descriptor.about).toEqual(['urn:app:a', 'urn:app:b']);
    expect(descriptor.providerIri).toBe('urn:provider:alpha');
    expect(descriptor.registeredByAgentAddress).toBe('0x' + 'a'.repeat(40));
    expect(ka()['schema:about']).toEqual([{ '@id': 'urn:app:a' }, { '@id': 'urn:app:b' }]);
    expect(ka()['dkg-streams:schemaIri']).toEqual({ '@id': input.schemaIri });
  });
  it('keeps old minimal registrations readable without inventing a registrator', () => {
    const legacy = buildKa(coreSchema.parse({ name: 'Legacy', kafkaBootstrapUrl: 'u', kafkaTopicName: 't' }));
    expect(descriptorFromKa(legacy)).toEqual({ name: 'Legacy', kafkaBootstrapUrl: 'u', kafkaTopicName: 't', dataFormat: 'JSON' });
    expect(validateRegistryEntry(createRegistryEntry(legacy, ual, 'catalog')).descriptor.clusterId).toBeUndefined();
  });
  it('pins normalized descriptor bytes, detects changes and rejects ambiguous scalar values', () => {
    const entry = createRegistryEntry(ka(), ual, 'catalog', 'did:dkg:agent:publisher');
    // Persisted source pins and record identities must survive library updates.
    expect(entry.descriptorHash).toBe('sha256:34a67e8ea74b7325f1b2c8e9ecfdae80fd1b487a220819fb1710e77cffced10b');
    expect(validateRegistryEntry(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
    expect(entry.descriptorHash).toBe(descriptorHash({ ...entry.descriptor, about: ['urn:app:b', 'urn:app:a'] }));
    expect(descriptorHash({ ...entry.descriptor, about: [] })).toBe(descriptorHash({ ...entry.descriptor, about: undefined }));
    expect(() => validateRegistryEntry({ ...entry, descriptor: { ...entry.descriptor, kafkaTopicName: 'different' } })).toThrow('KAFKA_REGISTRY_HASH_MISMATCH');
    expect(() => descriptorFromKa({ ...ka(), 'schema:name': ['one', 'two'] })).toThrow();
    expect(() => descriptorFromKa({ ...ka(), 'dkg-streams:providerIri': null })).toThrow();
    expect(() => descriptorFromKa({ ...ka(), '@context': {} })).toThrow('KAFKA_REGISTRY_CONTEXT_MISMATCH');
    expect(() => descriptorFromKa({ ...ka(), '@type': 'other:Thing' })).toThrow('KAFKA_REGISTRY_TYPE_REQUIRED');
    expect(descriptorFromKa({ ...ka(), '@type': ['other:Thing', 'dkg-streams:KafkaStream'],
      'schema:about': 'urn:app:single', 'dkg-streams:providerIri': 'urn:provider:alpha' }).about).toEqual(['urn:app:single']);
  });
  it.each(['relative', 'urn:bad> } DROP ALL {', 'https://example.com/has space', ''])('rejects unsafe RDF reference %j', value => {
    expect(registryIriSchema.safeParse(value).success).toBe(false);
  });
  it('bounds entity references and keeps server identity out of request fields', () => {
    expect(coreSchema.safeParse({ ...input, about: Array.from({ length: 65 }, (_, n) => `urn:app:${n}`) }).success).toBe(false);
    expect(coreSchema.safeParse({ ...input, registeredByAgentAddress: '0x' + 'b'.repeat(40) }).success).toBe(false);
    expect(() => validateExtensionAgainstCore({ schema: z.object({ providerIri: z.string() }), augment: () => ({}) }, coreSchema)).toThrow();
    expect(() => validateExtensionAgainstCore({ schema: z.object({ registeredByAgentAddress: z.string() }), augment: () => ({}) }, coreSchema)).toThrow();
    for (const kafkaBootstrapUrl of ['kafka://user:secret@broker:9094', 'kafka://broker:9094?token=secret', 'kafka://broker:9094#secret']) {
      expect(coreSchema.safeParse({ ...input, kafkaBootstrapUrl }).success).toBe(false);
    }
  });
  it('blocks extension identity spoofing through full IRIs, aliases and @vocab', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const original = ka();
    for (const fragment of [
      { [`${STREAMS}registeredByAgentAddress`]: 'attacker' },
      { '@context': { alias: STREAMS }, 'alias:registeredByAgentAddress': 'attacker' },
      { registeredByAgentAddress: 'attacker', '@context': { '@vocab': STREAMS } },
      { who: 'attacker', '@context': { who: `${STREAMS}registeredByAgentAddress` } },
      { who: 'attacker', '@context': { who: 'dkg-streams:registeredByAgentAddress' } },
      { who: 'attacker', '@context': { who: 'next', next: 'dkg-streams:registeredByAgentAddress' } },
      { who: 'attacker', '@context': { who: 'alias:registeredByAgentAddress', alias: 'dkg-streams:' } },
      { registeredByAgentAddress: 'attacker', '@context': { '@vocab': 'dkg-streams:' } },
      { who: 'attacker', '@context': { who: 'cycle', cycle: 'who' } },
    ]) {
      const merged = mergeAugmentFragment(original, fragment, new Set());
      expect(merged['dkg-streams:registeredByAgentAddress']).toBe(original['dkg-streams:registeredByAgentAddress']);
      expect(Object.values(merged)).not.toContain('attacker');
    }
    vi.restoreAllMocks();
  });
});

describe('registry filtering and opt-in envelopes', () => {
  it('normalizes supported filters and safely quotes search text', () => {
    const params = new URLSearchParams({ publisher: 'did:dkg:agent:publisher', registeredBy: '0x' + 'A'.repeat(40),
      provider: 'urn:provider:alpha', about: 'urn:app:a', schema: input.schemaIri, dataFormat: 'JSON', q: '" } UNION { ?s ?p ?o } #' });
    const filters = parseRegistryFilters(params);
    expect(filters.registeredBy).toBe('0x' + 'a'.repeat(40));
    const pattern = registryFilterPattern(filters);
    expect(pattern).toContain('FILTER(?publisher = <did:dkg:agent:publisher>)');
    expect(pattern).toContain('\\" } UNION');
    expect(pattern).toContain('<urn:app:a>');
    expect(registryFilterPattern()).toBe('');
    expect(() => parseRegistryFilters(new URLSearchParams('provider=urn:a&provider=urn:b'))).toThrow('Repeated');
    expect(() => parseRegistryFilters(new URLSearchParams('tenantId=example'))).toThrow('Unknown');
    expect(() => parseRegistryFilters(new URLSearchParams({ q: 'a'.repeat(201) }))).toThrow();
  });
  it('preserves default responses and explicitly validates response mode', () => {
    expect(includeRegistry(new URLSearchParams())).toBe(false);
    expect(includeRegistry(new URLSearchParams('includeRegistry=false'))).toBe(false);
    expect(includeRegistry(new URLSearchParams('includeRegistry=true'))).toBe(true);
    expect(() => includeRegistry(new URLSearchParams('includeRegistry=oops'))).toThrow();
    expect(() => includeRegistry(new URLSearchParams('includeRegistry=true&includeRegistry=true'))).toThrow();
    const payload = ka();
    expect(withRegistry(payload, ual, 'catalog', [], false)).toBe(payload);
    expect(withRegistry(payload, ual, 'catalog', [], true)).toHaveProperty('registry');
    for (const publisher of ['<did:dkg:agent:publisher>', { value: 'did:dkg:agent:publisher' }, 1, {}]) {
      expect(withRegistry(payload, ual, 'catalog', [{ publisher }], true)).toHaveProperty('registry');
    }
    expect(() => withRegistry(payload, ual, 'catalog', [{ publisher: 'urn:a' }, { publisher: 'urn:b' }], true)).toThrow('Ambiguous');
  });
});
