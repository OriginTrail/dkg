import { describe, it, expect } from 'vitest';
import { coreSchema, CORE_FIELDS } from '../src/schema.js';
const validBody = {
  name: 'demo-stream',
  kafkaBootstrapUrl: 'kafka://broker:9092',
  kafkaTopicName: 'demo.readings',
};
describe('coreSchema', () => {
  it('exports CORE_FIELDS containing every documented field name', () => {
    expect(CORE_FIELDS).toEqual(expect.arrayContaining([
      'name',
      'kafkaBootstrapUrl',
      'kafkaTopicName',
      'description',
      'kafkaAuthMethod',
      'kafkaSaslMechanism',
      'dataFormat',
    ]));
  });
  it('accepts a minimal valid body and fills in dataFormat default', () => {
    const result = coreSchema.parse(validBody);
    expect(result.name).toBe(validBody.name);
    expect(result.kafkaBootstrapUrl).toBe(validBody.kafkaBootstrapUrl);
    expect(result.kafkaTopicName).toBe(validBody.kafkaTopicName);
    expect(result.dataFormat).toBe('JSON');
  });
  it.each(['name', 'kafkaBootstrapUrl', 'kafkaTopicName'] as const)(
    'rejects when required field %s is missing',
    (field) => {
      const body: Record<string, unknown> = { ...validBody };
      delete body[field];
      const res = coreSchema.safeParse(body);
      expect(res.success).toBe(false);
      if (!res.success) {
        const paths = res.error.issues.map((i) => i.path.join('.'));
        expect(paths).toContain(field);
      }
    },
  );
  it('accepts optional fields when present', () => {
    const res = coreSchema.parse({
      ...validBody,
      description: 'desc',
      kafkaAuthMethod: 'SASL_SSL',
      kafkaSaslMechanism: 'PLAIN',
      dataFormat: 'AVRO',
    });
    expect(res.description).toBe('desc');
    expect(res.kafkaAuthMethod).toBe('SASL_SSL');
    expect(res.kafkaSaslMechanism).toBe('PLAIN');
    expect(res.dataFormat).toBe('AVRO');
  });
  it('rejects unknown top-level keys including contextGraphId', () => {
    const res = coreSchema.safeParse({ ...validBody, contextGraphId: 'urn:cg:1' });
    expect(res.success).toBe(false);
  });
  it('rejects unrelated unknown keys', () => {
    const res = coreSchema.safeParse({ ...validBody, surprise: 'x' });
    expect(res.success).toBe(false);
  });
});
// Bug 4: `messageSchema` (object-valued) breaks round-trip — Oxigraph
// surfaces it as a blank-node sub-graph the one-hop discovery query
// cannot reconstruct. Removed from v1; forks needing it should declare
// it in their extension (e.g. `source:messageSchema`).
describe('coreSchema — Bug 4: messageSchema removed from v1', () => {
  it('omits messageSchema from CORE_FIELDS', () => {
    expect(CORE_FIELDS).not.toContain('messageSchema');
  });
  it('rejects messageSchema as an unknown key under strict mode', () => {
    const res = coreSchema.safeParse({ ...validBody, messageSchema: { foo: 'bar' } });
    expect(res.success).toBe(false);
  });
});
