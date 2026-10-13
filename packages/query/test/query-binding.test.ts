import { describe, expect, it } from 'vitest';
import { stripSparqlLiteralValue } from '../src/query-binding.js';
import { decodeRegisteredSubGraphName } from '../src/registered-sub-graphs.js';

describe('query binding lexical compatibility', () => {
  it.each([
    [undefined, ''], ['', ''], ['code', 'code'], ['"code"', 'code'],
    ['"code"^^<http://www.w3.org/2001/XMLSchema#string>', 'code'],
    ['"code"@en-US', 'code'], ['"42"^^<http://www.w3.org/2001/XMLSchema#integer>', '42'],
    ['"01"', '01'], ['"-1"', '-1'], ['"a\\nb"', 'a\\nb'],
  ])('preserves existing extraction for %s', (value, lexical) => {
    expect(stripSparqlLiteralValue(value)).toBe(lexical);
  });

  it.each(['code', '"code"', '"code"@en', '"code"^^<http://www.w3.org/2001/XMLSchema#string>'])('still accepts registered names in %s', value => {
    expect(decodeRegisteredSubGraphName(value)).toBe('code');
  });
  it.each([undefined, '', '"bad/name"', '"_private"'])('keeps registration validation for %s', value => {
    expect(decodeRegisteredSubGraphName(value)).toBeUndefined();
  });
});
