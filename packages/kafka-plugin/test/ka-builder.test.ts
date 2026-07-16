import { describe, it, expect } from 'vitest';
import { coreSchema } from '../src/schema.js';
import { buildKa } from '../src/ka-builder.js';
describe('buildKa — bare core fields', () => {
  it('produces a KafkaStream JSON-LD KA with @context + @type + protocol', () => {
    const parsed = coreSchema.parse({
      name: 'demo-stream',
      kafkaBootstrapUrl: 'kafka://broker:9092',
      kafkaTopicName: 'demo.readings',
    });
    const ka = buildKa(parsed);
    expect(ka).toEqual({
      '@context': {
        'dkg-streams': 'https://ontology.dkg.io/streams#',
        schema: 'https://schema.org/',
      },
      '@type': 'dkg-streams:KafkaStream',
      'dkg-streams:protocol': 'kafka',
      'schema:name': 'demo-stream',
      'dkg-streams:kafkaBootstrapUrl': 'kafka://broker:9092',
      'dkg-streams:kafkaTopicName': 'demo.readings',
      'dkg-streams:dataFormat': 'JSON',
    });
  });
  it('maps description to schema:description when present', () => {
    const parsed = coreSchema.parse({
      name: 'n',
      kafkaBootstrapUrl: 'u',
      kafkaTopicName: 't',
      description: 'd',
    });
    const ka = buildKa(parsed);
    expect(ka['schema:description']).toBe('d');
  });
  it('maps every optional dkg-streams field present in the parsed body', () => {
    const parsed = coreSchema.parse({
      name: 'n',
      kafkaBootstrapUrl: 'u',
      kafkaTopicName: 't',
      kafkaAuthMethod: 'SASL_SSL',
      kafkaSaslMechanism: 'PLAIN',
      dataFormat: 'AVRO',
    });
    const ka = buildKa(parsed);
    expect(ka['dkg-streams:kafkaAuthMethod']).toBe('SASL_SSL');
    expect(ka['dkg-streams:kafkaSaslMechanism']).toBe('PLAIN');
    expect(ka['dkg-streams:dataFormat']).toBe('AVRO');
  });
  it('omits keys for absent optional fields', () => {
    const parsed = coreSchema.parse({
      name: 'n',
      kafkaBootstrapUrl: 'u',
      kafkaTopicName: 't',
    });
    const ka = buildKa(parsed);
    expect('schema:description' in ka).toBe(false);
    expect('dkg-streams:kafkaAuthMethod' in ka).toBe(false);
    expect('dkg-streams:kafkaSaslMechanism' in ka).toBe(false);
  });
});
import { vi } from 'vitest';
import { mergeAugmentFragment } from '../src/ka-builder.js';
describe('mergeAugmentFragment — core wins + log-once', () => {
  it('adds extension keys that do not collide with the base KA', () => {
    const base = buildKa(
      coreSchema.parse({ name: 'n', kafkaBootstrapUrl: 'u', kafkaTopicName: 't' }),
    );
    const merged = mergeAugmentFragment(
      base,
      { 'x:externalRef': 'ref-alpha', 'x:sourceRef': 'source-1' },
      new Set<string>(),
    );
    expect(merged['x:externalRef']).toBe('ref-alpha');
    expect(merged['x:sourceRef']).toBe('source-1');
    expect(merged['@type']).toBe('dkg-streams:KafkaStream');
  });
  it('drops non-scalar extension values that discovery cannot round-trip', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = buildKa(
      coreSchema.parse({ name: 'n', kafkaBootstrapUrl: 'u', kafkaTopicName: 't' }),
    );
    const logged = new Set<string>();
    const merged = mergeAugmentFragment(
      base,
      { 'x:nested': { value: 'nope' }, 'x:ok': 'ok' },
      logged,
    );
    expect(merged).not.toHaveProperty('x:nested');
    expect(merged['x:ok']).toBe('ok');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('non-scalar key "x:nested"'),
    );
    warnSpy.mockRestore();
  });
  it('drops extension keys that collide with core (core wins)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = buildKa(
      coreSchema.parse({ name: 'n', kafkaBootstrapUrl: 'u', kafkaTopicName: 't' }),
    );
    const merged = mergeAugmentFragment(
      base,
      { 'schema:name': 'OVERRIDE', 'dkg-streams:kafkaBootstrapUrl': 'OVERRIDE', 'x:ok': 'ok' },
      new Set<string>(),
    );
    expect(merged['schema:name']).toBe('n');
    expect(merged['dkg-streams:kafkaBootstrapUrl']).toBe('u');
    expect(merged['x:ok']).toBe('ok');
    warnSpy.mockRestore();
  });
  it('emits exactly one console.warn per unique colliding key across N calls', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logged = new Set<string>();
    const base = buildKa(
      coreSchema.parse({ name: 'n', kafkaBootstrapUrl: 'u', kafkaTopicName: 't' }),
    );
    for (let i = 0; i < 5; i++) {
      mergeAugmentFragment(
        base,
        { 'schema:name': 'X', 'dkg-streams:kafkaTopicName': 'X' },
        logged,
      );
    }
    const messages = warnSpy.mock.calls.map((c) => c.join(' '));
    const nameWarns = messages.filter((m) => m.includes('schema:name'));
    const topicWarns = messages.filter((m) => m.includes('dkg-streams:kafkaTopicName'));
    expect(nameWarns).toHaveLength(1);
    expect(topicWarns).toHaveLength(1);
    expect(logged.has('schema:name')).toBe(true);
    expect(logged.has('dkg-streams:kafkaTopicName')).toBe(true);
    warnSpy.mockRestore();
  });
  it('does not mutate the base KA in place', () => {
    const base = buildKa(
      coreSchema.parse({ name: 'n', kafkaBootstrapUrl: 'u', kafkaTopicName: 't' }),
    );
    const snapshot = JSON.parse(JSON.stringify(base));
    mergeAugmentFragment(base, { 'x:k': 'v' }, new Set<string>());
    expect(base).toEqual(snapshot);
  });
});
