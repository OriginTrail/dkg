import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMORY_LABEL_PREDICATES } from '../src/ui/lib/memoryLabels.js';
import { buildLayerGraphOptions } from '../src/ui/views/project/helpers.js';

const UI_DIR = resolve(__dirname, '..', 'src', 'ui');

describe('graph label predicates', () => {
  it('uses the shared memory label predicate list for layer graphs', () => {
    const options = buildLayerGraphOptions('wm');

    expect(options.labels.predicates).toEqual([...MEMORY_LABEL_PREDICATES]);
    expect(options.labels.predicates).toContain('http://purl.org/dc/elements/1.1/title');
  });

  it('keeps detail, subgraph, and standalone graph configs on the shared list', () => {
    const projectComponents = readFileSync(resolve(UI_DIR, 'views', 'project', 'components.tsx'), 'utf-8');
    const memoryLayerView = readFileSync(resolve(UI_DIR, 'views', 'MemoryLayerView.tsx'), 'utf-8');
    const projectGraphUses = projectComponents.split('predicates: [...MEMORY_LABEL_PREDICATES]').length - 1;

    expect(projectComponents).toContain("import { MEMORY_LABEL_PREDICATES } from '../../lib/memoryLabels.js'");
    expect(projectGraphUses).toBeGreaterThanOrEqual(2);
    expect(memoryLayerView).toContain("import { MEMORY_LABEL_PREDICATES } from '../lib/memoryLabels.js'");
    expect(memoryLayerView).toContain('...MEMORY_LABEL_PREDICATES');
  });
});
