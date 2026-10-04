import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('propagates a real worker directory-sync EIO through certified persistence and recovers after retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-worker-dir-sync-'));
  const snapshotDir = join(dir, 'snapshots'), flag = join(dir, 'inject-eio');
  const preload = join(dir, 'directory-fault.mjs'), script = join(dir, 'worker-control.mjs');
  const adapter = new URL('../dist/adapters/oxigraph-worker.js', import.meta.url).href;
  try {
    await mkdir(snapshotDir);
    await writeFile(flag, 'fail directory sync');
    // Inherit this I/O fault in the real worker thread. It changes only the
    // containing directory's sync; snapshot bytes, rename and RPC stay real.
    await writeFile(preload, `import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const open = fs.promises.open;
      fs.promises.open = async (...args) => {
        const handle = await open(...args);
        if (String(args[0]) === process.env.DKG_TEST_SNAPSHOT_DIRECTORY
          && args[1] === 'r' && fs.existsSync(process.env.DKG_TEST_DIRECTORY_FAULT)) {
          handle.sync = async () => { throw Object.assign(new Error('worker snapshot directory EIO'), { code: 'EIO' }); };
        }
        return handle;
      };
      syncBuiltinESMExports();`);
    await writeFile(script, `import { OxigraphWorkerStore } from ${JSON.stringify(adapter)};
      import { unlink } from 'node:fs/promises';
      const path = ${JSON.stringify(join(snapshotDir, 'store.nq'))};
      const store = new OxigraphWorkerStore(path);
      let failure;
      try {
        await store.insert([{subject:'urn:worker:s',predicate:'urn:worker:p',object:'"value"',graph:'urn:worker:g'}]);
        try { await store.commitment.commit(); } catch (error) { failure = { code:error.code, message:error.message }; }
        await unlink(${JSON.stringify(flag)});
        await store.commitment.commit();
      } finally { await store.close(); }
      const reopened = new OxigraphWorkerStore(path);
      try { console.log(JSON.stringify({ failure, reopened:await reopened.countQuads() })); }
      finally { await reopened.close(); }`);
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', preload, script], {
      env: { ...process.env, DKG_TEST_SNAPSHOT_DIRECTORY: snapshotDir, DKG_TEST_DIRECTORY_FAULT: flag },
      timeout: 60_000,
    });
    const result = JSON.parse(stdout.split('\n').find(line => line.startsWith('{'))!);
    expect(result).toMatchObject({ failure: { code: 'EIO', message: 'worker snapshot directory EIO' }, reopened: 1 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
