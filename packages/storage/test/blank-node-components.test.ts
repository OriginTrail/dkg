import { describe, expect, it } from 'vitest';
import {
  isBlankNodeTerm,
  partitionConnectedBlankNodeComponents,
  type Quad,
} from '../src/index.js';

const quad = (subject: string, object: string, graph = 'urn:g'): Quad => ({
  subject,
  predicate: 'urn:p',
  object,
  graph,
});

describe('partitionConnectedBlankNodeComponents', () => {
  it('groups shared labels transitively while preserving first-seen component order', () => {
    const ground = quad('urn:ground', 'urn:value');
    const first = quad('urn:a', '_:a');
    const bridge = quad('_:a', '_:b');
    const tail = quad('_:b', 'urn:tail');
    const separate = quad('urn:c', '_:c');

    const components = partitionConnectedBlankNodeComponents(
      [ground, first, separate, bridge, tail],
      (item) => [item.subject, item.object],
    );

    expect(components.map((component) => component.items)).toEqual([
      [ground],
      [first, bridge, tail],
      [separate],
    ]);
    expect([...components[1]!.blankNodeLabels].sort()).toEqual(['_:a', '_:b']);
  });

  it('lets callers include or exclude graph-position blank nodes from the scope', () => {
    const left = quad('urn:left', 'urn:value', '_:graph');
    const right = quad('urn:right', 'urn:value', '_:graph');

    expect(
      partitionConnectedBlankNodeComponents([left, right], (item) => [
        item.subject,
        item.object,
      ]),
    ).toHaveLength(2);
    expect(
      partitionConnectedBlankNodeComponents([left, right], (item) => [
        item.subject,
        item.object,
        item.graph,
      ]),
    ).toHaveLength(1);
  });

  it('recognizes only blank-node term strings', () => {
    expect(isBlankNodeTerm('_:b0')).toBe(true);
    expect(isBlankNodeTerm('urn:b0')).toBe(false);
    expect(isBlankNodeTerm(undefined)).toBe(false);
  });
});
