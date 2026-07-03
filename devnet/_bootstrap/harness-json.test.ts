import { describe, expect, it } from 'vitest';
import { parseLastJsonBlock } from './harness.js';

describe('parseLastJsonBlock', () => {
  it('parses the final JSON object after log output', () => {
    expect(parseLastJsonBlock('starting\n{"ignored":true}\ndone\n{"ok":true}', 'cli stdout'))
      .toEqual({ ok: true });
  });

  it('throws instead of hanging when malformed JSON starts at offset zero', () => {
    expect(() => parseLastJsonBlock('\n{not-json', 'bad stdout'))
      .toThrow(/no JSON object in bad stdout/);
  });
});
