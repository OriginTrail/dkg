import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as mapping from '../src/mapping.js';
import { importBundle } from '../src/index.js';

// Only an OkfValueError (a value no RDF term can hold) is recoverable; any
// other exception from the mapper is a defect and must reach the caller with
// its stack, not be reported as malformed input. vi.mock is hoisted for the
// whole file, so this lives apart from the other bundle tests.
vi.mock('../src/mapping.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/mapping.js')>();
  return { ...original, prepareConcept: vi.fn(original.prepareConcept), resolveConcept: vi.fn(original.resolveConcept) };
});

const files = [
  { path: 'index.md', content: '# Root\n' },
  { path: 'a.md', content: '---\ntype: Metric\n---\n\nbody\n' },
  { path: 'b.md', content: '---\ntype: Metric\nowner: &x\n  self: *x\n---\n\nbody\n' },
];

beforeEach(() => {
  vi.mocked(mapping.prepareConcept).mockClear();
  vi.mocked(mapping.resolveConcept).mockClear();
});

describe('importBundle failure classes', () => {
  it('skips a concept with an unmappable value and imports the rest', () => {
    const r = importBundle(files);
    expect(r.concepts.map((c) => c.conceptId)).toEqual(['a']);
    expect(r.warnings).toEqual([expect.objectContaining({ conceptId: 'b', code: 'unmappable-value' })]);
  });

  it('lets an unexpected exception propagate, unclassified, with its stack, from either pass', () => {
    const defect = new TypeError('defect inside the mapper');
    vi.mocked(mapping.prepareConcept).mockImplementationOnce(() => {
      throw defect;
    });
    expect(() => importBundle(files)).toThrow(defect);
    vi.mocked(mapping.resolveConcept).mockImplementationOnce(() => {
      throw defect;
    });
    expect(() => importBundle(files)).toThrow(defect);
  });
});

describe('importBundle maps each concept once', () => {
  it('prepares every concept once and resolves each survivor once, against the final index', () => {
    // A healthy concept names one that cannot be mapped: it is prepared once,
    // never mapped against an index that still holds the skipped concept, and
    // resolved once, after that concept has left the index.
    const r = importBundle([
      { path: 'index.md', content: '# Root\n' },
      { path: 'a.md', content: '---\ntype: Metric\nsources:\n  - { id: z, resource: /z.md }\n---\n\nSee [z](/z.md).\n' },
      { path: 'm.md', content: '---\ntype: Metric\n---\n\nbody\n' },
      { path: 'z.md', content: '---\ntype: Metric\nowner: &x\n  self: *x\n---\n\nbody\n' },
    ]);
    const prepared = vi.mocked(mapping.prepareConcept).mock.calls.map(([doc]) => doc.conceptId);
    const resolved = vi.mocked(mapping.resolveConcept).mock.calls.map(([p]) => p.doc.conceptId);
    expect(prepared).toEqual(['a', 'm', 'z']);
    expect(resolved).toEqual(['a', 'm']);
    expect(r.concepts.map((c) => c.conceptId)).toEqual(['a', 'm']);
    expect(r.warnings.filter((w) => w.conceptId === 'a').map((w) => w.code)).toEqual(['broken-link', 'broken-link']);
  });
});
