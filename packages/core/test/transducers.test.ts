import { describe, expect, it } from 'vitest';
import {
  defineSourceAdapter,
  readWithSourceAdapter,
  defineNormalizer,
  normalizeWith,
  defineDatasetTransducer,
  transduceWith,
} from '../src/transducers.js';

describe('core transducer helpers', () => {
  it('adapts source, normalize, and transduce helpers generically', async () => {
    const source = defineSourceAdapter<string, { dataset: string; sourceTable: string; values: Record<string, unknown> }>({
      read(input, context) {
        return { rows: [{ dataset: context.dataset, sourceTable: context.sourceType, values: { raw: input } }] };
      },
    });
    const sourceRows = await readWithSourceAdapter(source, 'a', { dataset: 'demo', sourceType: 'csv' });

    const normalizer = defineNormalizer<{ dataset: string; sourceTable: string; values: Record<string, unknown> }, { dataset: string; sourceTable: string; values: Record<string, unknown>; keys: Record<string, string | number | boolean | null> }>({
      normalize(rows) {
        return { records: rows.map((row) => ({ ...row, keys: { raw: String(row.values.raw ?? '') } })) };
      },
    });
    const normalized = await normalizeWith(normalizer, sourceRows.rows, { dataset: 'demo' });

    const transducer = defineDatasetTransducer<typeof normalized.records, typeof normalized.records[number], { '@id': string }>({
      transduce(input) {
        return {
          records: input,
          nodes: [{ '@id': 'urn:test:1' }],
          quads: [{ subject: 'urn:test:1', predicate: 'urn:p', object: '"a"' }],
          assets: [{ rootEntity: 'urn:test:1', quads: [{ subject: 'urn:test:1', predicate: 'urn:p', object: '"a"' }] }],
        };
      },
    });
    const result = transduceWith(transducer, normalized.records, {
      dataset: 'demo',
      mappingSpec: {
        dataset: 'demo',
        classIri: 'urn:test:Class',
        identity: { keyFields: ['raw'], buildId: () => 'urn:test:1' },
        fieldMappings: [],
      },
    });

    expect(result).toEqual({
      records: normalized.records,
      nodes: [{ '@id': 'urn:test:1' }],
      quads: [{ subject: 'urn:test:1', predicate: 'urn:p', object: '"a"' }],
      assets: [{ rootEntity: 'urn:test:1', quads: [{ subject: 'urn:test:1', predicate: 'urn:p', object: '"a"' }] }],
    });
  });
});
