import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

it('bounds an actual drain over 512 x 256 KiB rows and a 16 MiB head entry', () => {
    const result = spawnSync(process.execPath, ['--expose-gc', '--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./fixtures/outbox-memory.fixture.ts', import.meta.url))], { encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024 });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const line = result.stdout.split('\n').find(text => text.startsWith('OUTBOX_MEMORY_RESULT '));
    expect(line).toBeDefined();
    const sample = JSON.parse(line!.slice('OUTBOX_MEMORY_RESULT '.length));
    expect(sample.rows).toBe(512);
    expect(sample.rowBytes).toBe(256 * 1024);
    expect(sample.peakClaimedBytes).toBe(4 * 1024 * 1024);
    expect(sample.skippedOversizedEntriesTotal).toBe(32);
  }, 100_000);
