import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('the real worker uses a writable renamed-file barrier and reopens when Windows directory opens are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-worker-platform-'));
  const snapshotDir = join(dir, 'snapshots'), snapshot = join(snapshotDir, 'store.nq');
  const preload = join(dir, 'windows-open-policy.mjs'), script = join(dir, 'worker-control.mjs'), trace = join(dir, 'opens.jsonl');
  const adapter = new URL('../dist/adapters/oxigraph-worker.js', import.meta.url).href;
  const nativeModule = createRequire(import.meta.url).resolve('oxigraph');
  try {
    await mkdir(snapshotDir);
    // Keep the host's real native engine and I/O. Only model Windows' directory
    // refusal/platform decision, in both the child and its inherited worker.
    await writeFile(preload, `import fs from 'node:fs';
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      createRequire(import.meta.url)(${JSON.stringify(nativeModule)});
      Object.defineProperty(process, 'platform', { value:'win32', configurable:true });
      const open = fs.promises.open;
      fs.promises.open = async (...args) => {
        fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify([String(args[0]), args[1]])+'\\n');
        if (String(args[0]) === ${JSON.stringify(snapshotDir)} && args[1] === 'r') {
          throw Object.assign(new Error('Windows directory handle refused'), { code:'EACCES' });
        }
        return open(...args);
      };
      syncBuiltinESMExports();`);
    await writeFile(script, `import { OxigraphWorkerStore } from ${JSON.stringify(adapter)};
      const store = new OxigraphWorkerStore(${JSON.stringify(snapshot)});
      try {
        await store.insert([{subject:'urn:worker:windows',predicate:'urn:worker:p',object:'"persisted"',graph:'urn:worker:g'}]);
        await store.commitment.commit();
      } finally { await store.close(); }
      const reopened = new OxigraphWorkerStore(${JSON.stringify(snapshot)});
      try { console.log(JSON.stringify({ reopened:await reopened.countQuads() })); }
      finally { await reopened.close(); }`);
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', preload, script], { timeout:60_000 });
    expect(JSON.parse(stdout.split('\n').find(line => line.startsWith('{'))!)).toEqual({ reopened:1 });
    const opens = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(opens).toContainEqual([snapshot, 'r+']);
    expect(opens).not.toContainEqual([snapshotDir, 'r']);
  } finally { await rm(dir, { recursive:true, force:true }); }
}, 60_000);
