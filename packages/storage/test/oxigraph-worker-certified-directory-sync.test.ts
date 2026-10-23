import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('retains ancestor-sync EIO across real worker replacement until a fresh certificate persists it', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dkg-worker-dir-sync-')));
  const snapshotDir = join(dir, 'snapshots'), flag = join(dir, 'inject-eio');
  try {
    await writeFile(flag, 'fail directory sync');
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', fileURLToPath(new URL('./fixtures/worker-directory-fault.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/worker-directory-sync.mjs', import.meta.url)),
    ], {
      env: { ...process.env, DKG_TEST_SNAPSHOT_DIRECTORY: snapshotDir, DKG_TEST_SYNC_DIRECTORY: dir, DKG_TEST_SNAPSHOT_PATH: join(snapshotDir, 'store.nq'), DKG_TEST_DIRECTORY_FAULT: flag },
      timeout: 60_000,
    });
    const result = JSON.parse(stdout.split('\n').find(line => line.startsWith('{'))!);
    expect(result).toMatchObject({ failure: { code: 'EIO', message: 'worker snapshot directory EIO' }, replacementFailure: { code: 'EIO' }, reopened: 2 });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);
