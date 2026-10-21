// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmedLifecycleRecoveryFixture } from './_helpers/confirmed-lifecycle-recovery-fixture.js';

it('retains repair evidence when a real worker dies after acknowledging lifecycle writes, then reapplies durably', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-lifecycle-worker-loss-'));
  const path = join(dir, 'store.nq'), flag = join(dir, 'block-snapshot');
  const preload = join(dir, 'snapshot-fault.mjs'), script = join(dir, 'worker-loss.mjs');
  const storage = new URL('../../storage/dist/index.js', import.meta.url).href;
  const lifecycle = new URL('../dist/named-ka-vm-lifecycle.js', import.meta.url).href;
  const repairModule = new URL('../dist/named-ka-vm-lifecycle-repair.js', import.meta.url).href;
  const { input } = confirmedLifecycleRecoveryFixture();
  try {
    // A real worker inherits the scoped I/O fault. This prevents its debounced
    // snapshot from winning the race while the acknowledged mutation is inspected.
    await writeFile(preload, `import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const open = fs.promises.open;
      fs.promises.open = async (...args) => {
        if (String(args[0]).startsWith(${JSON.stringify(path)}) && args[1] === 'w'
          && fs.existsSync(${JSON.stringify(flag)})) throw Object.assign(new Error('snapshot held before crash'), { code: 'EIO' });
        return open(...args);
      };
      syncBuiltinESMExports();`);
    await writeFile(script, `import assert from 'node:assert/strict';
      import { writeFile, readFile, unlink } from 'node:fs/promises';
      import { OxigraphWorkerStore, GraphSetIndexStore, ChangelogStore } from ${JSON.stringify(storage)};
      import { applyPublishedNamedKaVmLifecycle } from ${JSON.stringify(lifecycle)};
      import { NamedKaVmLifecycleRepair } from ${JSON.stringify(repairModule)};
      const input = ${JSON.stringify(input)}, path = ${JSON.stringify(path)};
      const worker = new OxigraphWorkerStore(path);
      let arm = false, enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const held = new Promise(resolve => { release = resolve; });
      const store = new ChangelogStore(new GraphSetIndexStore(worker), { eraGuard: {
        load: async () => null,
        save: async () => { if (arm) { arm = false; enter(); await held; } },
      } });
      let now = 1000;
      const repair = new NamedKaVmLifecycleRepair({ dataDir: ${JSON.stringify(join(dir, 'repair'))},
        writeLocks: new Map(), now: () => now, isCurrent: async () => true, warn: () => {},
        apply: value => applyPublishedNamedKaVmLifecycle(store, value),
      });
      const query = 'ASK { GRAPH ?g { ?s <http://dkg.io/ontology/publishedUal> ' + JSON.stringify(input.publishedUal) + ' } }';
      const journal = async () => JSON.parse(await readFile(${JSON.stringify(join(dir, 'repair/named-ka-vm-lifecycle-repairs.json'))}, 'utf8')).entries;
      let reopened;
      try {
        await store.insert([{subject:'urn:baseline',predicate:'urn:value',object:'"keep"',graph:'urn:baseline'}]);
        await store.commitment.commit();
        const firstBarrier = store.commitment.capture?.() ?? store.commitment.commit;
        const secondBarrier = store.commitment.capture?.() ?? store.commitment.commit;
        await writeFile(${JSON.stringify(flag)}, 'hold snapshot'); arm = true;
        const attempt = repair.submit(input);
        await entered;
        assert.equal((await worker.query(query)).value, true, 'worker acknowledged lifecycle metadata');
        await worker.worker.terminate();
        assert.equal((await worker.query(query)).value, false, 'replacement really lost the uncommitted metadata');
        await unlink(${JSON.stringify(flag)});
        release();
        assert.equal(await attempt, 'pending');
        assert.equal((await journal()).length, 1);
        await assert.rejects(firstBarrier(), { code: 'OXIGRAPH_WORKER_COMMIT_OWNER_CHANGED' });
        // A fresh mutation cannot repair the stale certificate of a different owner.
        await store.insert([{subject:'urn:other',predicate:'urn:value',object:'"new"',graph:'urn:other'}]);
        now += 5000; await repair.runDue();
        assert.equal((await journal()).length, 0);
        assert.equal((await worker.query(query)).value, true);
        await assert.rejects(secondBarrier(), { code: 'OXIGRAPH_WORKER_COMMIT_OWNER_CHANGED' });
        await assert.rejects(store.commitment.commit(), { code: 'OXIGRAPH_WORKER_COMMIT_OWNER_CHANGED' });
        // Reopen before close can flush anything: only the fresh attempt's captured
        // barrier may justify retiring the durable journal.
        reopened = new OxigraphWorkerStore(path);
        assert.equal((await reopened.query(query)).value, true);
        assert.equal(await reopened.countQuads('urn:baseline'), 1);
        console.log(JSON.stringify({ acknowledgedThenLost: true, retainedUntilReapplied: true,
          durableReopen: true, staleBarriersRejected: 3 }));
      } finally { release(); await unlink(${JSON.stringify(flag)}).catch(() => {}); await repair.stop(); await reopened?.close(); await store.close(); }`);
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', preload, script], { timeout: 60_000 });
    expect(JSON.parse(stdout.split('\n').find(line => line.startsWith('{'))!)).toEqual({
      acknowledgedThenLost: true, retainedUntilReapplied: true, durableReopen: true, staleBarriersRejected: 3,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);
