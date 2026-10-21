import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('the real worker uses a writable renamed-file barrier and reopens when Windows directory opens are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-worker-platform-'));
  const snapshotDir = join(dir, 'snapshots'), snapshot = join(snapshotDir, 'store.nq');
  const trace = join(dir, 'opens.jsonl');
  try {
    await mkdir(snapshotDir);
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', fileURLToPath(new URL('./fixtures/worker-windows-policy.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/worker-platform-persistence.mjs', import.meta.url)),
    ], { timeout:60_000, env: { ...process.env, DKG_TEST_SNAPSHOT_PATH: snapshot, DKG_TEST_SNAPSHOT_DIRECTORY: snapshotDir, DKG_TEST_OPEN_TRACE: trace } });
    const result = JSON.parse(stdout.split('\n').find(line => line.startsWith('{'))!);
    expect(result.reopened).toBe(1);
    const opens = result.traceBeforeCleanup;
    expect(opens).toContainEqual([snapshot, 'r+']);
    expect(opens).toContainEqual(['sync', snapshot, 'r+']);
    expect(opens).not.toContainEqual([snapshotDir, 'r']);
  } finally { await rm(dir, { recursive:true, force:true }); }
}, 60_000);
