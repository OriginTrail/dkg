import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TextInteractionTrace, redactSecrets } from '../src/text-trace.js';

describe('text interaction trace', () => {
  it('redacts secrets recursively', () => {
    expect(redactSecrets({
      token: 'secret',
      nested: { authorization: 'Bearer abc.123', value: 'Bearer def.456' },
    })).toEqual({
      token: '[REDACTED]',
      nested: { authorization: '[REDACTED]', value: 'Bearer [REDACTED]' },
    });
  });

  it('writes a readable owner-only log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-local-llm-trace-'));
    const trace = await TextInteractionTrace.create({ logDir: dir });
    await trace.write('TOOL CALL 1', { name: 'dkg_status', token: 'do-not-log' });
    const contents = await readFile(trace.filePath, 'utf8');
    const metadata = await stat(trace.filePath);
    expect(contents).toContain('DKG LOCAL LLM INTERACTION TRACE');
    expect(contents).toContain('===== TOOL CALL 1 =====');
    expect(contents).toContain('[REDACTED]');
    expect(contents).not.toContain('do-not-log');
    expect(metadata.mode & 0o777).toBe(0o600);
  });
});
