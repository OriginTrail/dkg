import { describe, it, expect, vi } from 'vitest';
import * as mapping from '../src/mapping.js';
import { importBundle } from '../src/index.js';

// Only an OkfValueError (a value no RDF term can hold) is recoverable; any
// other exception from the mapper is a defect and must reach the caller with
// its stack, not be reported as malformed input. vi.mock is hoisted for the
// whole file, so this lives apart from the other bundle tests.
vi.mock('../src/mapping.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/mapping.js')>();
  return { ...original, mapConcept: vi.fn(original.mapConcept) };
});

const files = [
  { path: 'index.md', content: '# Root\n' },
  { path: 'a.md', content: '---\ntype: Metric\n---\n\nbody\n' },
  { path: 'b.md', content: '---\ntype: Metric\nowner: &x\n  self: *x\n---\n\nbody\n' },
];

describe('importBundle failure classes', () => {
  it('skips a concept with an unmappable value and imports the rest', () => {
    const r = importBundle(files);
    expect(r.concepts.map((c) => c.conceptId)).toEqual(['a']);
    expect(r.warnings).toEqual([expect.objectContaining({ conceptId: 'b', code: 'unmappable-value' })]);
  });

  it('lets an unexpected mapper exception propagate, unclassified, with its stack', () => {
    const defect = new TypeError('defect inside the mapper');
    vi.mocked(mapping.mapConcept).mockImplementationOnce(() => {
      throw defect;
    });
    expect(() => importBundle(files)).toThrow(defect);
  });
});
