import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { substitutePlaceholders } from '../src/manifest/schema.js';

describe('manifest placeholder quoting', () => {
  it.each(['', 'plain', 'O\'Brien "laptop"', '$HOME $(printf injected) `printf injected`', 'line\nbreak; printf injected', 'Ž \\ folder'])
    ('round-trips free-form identity through JSON and the POSIX shell (%j)', value => {
      const json = substitutePlaceholders('{"name":{{json:agentNickname}}}', { agentNickname: value });
      expect(JSON.parse(json)).toEqual({ name: value });
      const command = substitutePlaceholders("printf '%s' {{sh:agentNickname}}", { agentNickname: value });
      expect(execFileSync('sh', ['-c', command], { encoding: 'utf8', timeout: 2_000 })).toBe(value);
    });

  it('replaces repeated raw placeholders and leaves unknown or missing values literal', () => {
    expect(substitutePlaceholders('{{network}}/{{network}} {{unknown}} {{agentUri}}', { network: 'devnet' }))
      .toBe('devnet/devnet {{unknown}} {{agentUri}}');
  });
});
