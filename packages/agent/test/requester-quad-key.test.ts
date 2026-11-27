import { describe, expect, it } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';

import { canonicalQuadKey } from '../src/sync/requester/quad-key.js';

describe('canonicalQuadKey', () => {
  it('keeps tuple boundaries distinct when terms contain a flattened delimiter', () => {
    const left: Quad = {
      graph: 'urn:graph\0urn:subject',
      subject: 'urn:predicate',
      predicate: 'urn:object',
      object: '"value"',
    };
    const right: Quad = {
      graph: 'urn:graph',
      subject: 'urn:subject\0urn:predicate',
      predicate: 'urn:object',
      object: '"value"',
    };

    expect(
      [left.graph, left.subject, left.predicate, left.object].join('\0'),
    ).toBe(
      [right.graph, right.subject, right.predicate, right.object].join('\0'),
    );
    expect(canonicalQuadKey(left)).not.toBe(canonicalQuadKey(right));
    expect(canonicalQuadKey({ ...left })).toBe(canonicalQuadKey(left));
  });
});
