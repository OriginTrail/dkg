import { describe, expect, it } from 'vitest';
import { MEMORY_LABEL_PREDICATES, memoryGraphLabels } from '../src/ui/lib/memoryLabels.js';
import { buildLayerGraphOptions } from '../src/ui/views/project/helpers.js';

describe('graph label predicates', () => {
  it('builds graph label options from the shared predicate list', () => {
    expect(memoryGraphLabels({ minZoomForLabels: 0.4 })).toEqual({
      predicates: [...MEMORY_LABEL_PREDICATES],
      minZoomForLabels: 0.4,
    });

    expect(memoryGraphLabels({ extraPredicates: ['http://schema.org/text'] }).predicates).toEqual([
      'http://schema.org/text',
      ...MEMORY_LABEL_PREDICATES,
    ]);
  });

  it('uses the shared memory label predicate list for layer graphs', () => {
    const options = buildLayerGraphOptions('wm');

    expect(options.labels.predicates).toEqual([...MEMORY_LABEL_PREDICATES]);
    expect(options.labels.predicates).toContain('http://purl.org/dc/elements/1.1/title');
  });
});
