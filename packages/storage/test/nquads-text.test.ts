import { describe, expect, it } from 'vitest';
import { parseNQuadLine, parseNQuadsText } from '../src/nquads-text.js';

describe('canonical storage N-Quads text parser', () => {
  const line = '<http://ex.org/s> <http://ex.org/p> "value\\"quoted"@en <http://ex.org/g> .';
  const expected = {
    subject: 'http://ex.org/s',
    predicate: 'http://ex.org/p',
    object: '"value\\"quoted"@en',
    graph: 'http://ex.org/g',
  };

  it('parses the representative statement used by both HTTP adapters', () => {
    expect(parseNQuadLine(line)).toEqual(expected);
  });

  it('preserves tolerant text parsing for comments and invalid interior lines', () => {
    expect(parseNQuadsText(`# generated response\nignored server noise\n${line}\n`))
      .toEqual([expected]);
  });
});
