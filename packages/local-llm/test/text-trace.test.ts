import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TextInteractionTrace, redactSecrets } from '../src/text-trace.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

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
    dirs.push(dir);
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


describe('trace data boundaries', () => {
  it('redacts arrays and cycles without changing the original data', () => {
    const data: Record<string, unknown> = { list: [null, 7, false, { api_key: 'hidden', value: 'Bearer abc+def/123=' }] };
    data.self = data;
    expect(redactSecrets(data)).toEqual({ list: [null, 7, false, { api_key: '[REDACTED]', value: 'Bearer [REDACTED]' }], self: '[Circular]' });
    expect(data.self).toBe(data);
    expect(data.list).toEqual([null, 7, false, { api_key: 'hidden', value: 'Bearer abc+def/123=' }]);
  });

  it('serializes concurrent writes in invocation order to an explicit nested file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-local-llm-trace-'));
    dirs.push(dir);
    const filePath = join(dir, 'nested', 'trace.log');
    const trace = await TextInteractionTrace.create({ logFile: filePath });
    await Promise.all([trace.write('EMPTY'), trace.write('TEXT', 'Bearer secret'), trace.write('ARRAY', [1, null])]);
    expect(trace.filePath).toBe(filePath);
    const text = await readFile(filePath, 'utf8');
    expect(text).toContain('===== EMPTY =====\n\n');
    expect(text).toContain('===== TEXT =====\nBearer [REDACTED]\n');
    expect(text).toContain('===== ARRAY =====\n[\n  1,\n  null\n]\n');
    expect(text.indexOf('===== EMPTY')).toBeLessThan(text.indexOf('===== TEXT'));
    expect(text.indexOf('===== TEXT')).toBeLessThan(text.indexOf('===== ARRAY'));
    expect(text).not.toContain('Bearer secret');
  });
});
