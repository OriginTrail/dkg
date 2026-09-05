import { describe, expect, it } from 'vitest';
import {
  parseNQuadLine,
  parseNQuadsTextTolerant,
  scanNQuadLines,
} from '../src/nquads-text.js';

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

  it('exposes invalid content lines without treating comments as content', () => {
    expect(scanNQuadLines(`# generated response\nignored server noise\n${line}\n`)).toEqual([
      { line: 'ignored server noise', parsed: false },
      { line, parsed: true, quad: expected },
    ]);
  });

  it('preserves explicitly tolerant parsing for comments and invalid interior lines', () => {
    expect(parseNQuadsTextTolerant(`# generated response\nignored server noise\n${line}\n`))
      .toEqual([expected]);
  });

  it('decodes UCHAR escapes only in IRI positions, including supplementary scalars', () => {
    expect(parseNQuadLine(String.raw`<urn:caf\u00E9> <urn:p\U0001F600> <urn:o\uD83D\uDE00> <urn:g\u00E9> .`))
      .toEqual({
        subject: 'urn:café',
        predicate: 'urn:p😀',
        object: 'urn:o😀',
        graph: 'urn:gé',
      });
    expect(parseNQuadLine(String.raw`<urn:s> <urn:p> "literal:\u00E9" .`))
      .toMatchObject({ object: String.raw`"literal:\u00E9"` });
  });

  it('rejects malformed, out-of-range, or unpaired UCHAR escapes in IRIs', () => {
    for (const subject of [
      String.raw`urn:bad\uZZZZ`,
      String.raw`urn:bad\U00110000`,
      String.raw`urn:bad\uD800`,
      String.raw`urn:bad\uDC00`,
      String.raw`urn:bad\U0000D83D\uDE00`,
      String.raw`urn:bad\n`,
    ]) {
      expect(parseNQuadLine(`<${subject}> <urn:p> "value" .`)).toBeUndefined();
    }
  });
});
