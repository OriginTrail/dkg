import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ownProcess } from '../../../scripts/testing/owned-process.mjs';

const fixture = fileURLToPath(new URL('./fixtures/durable-unregistered-author-process.mjs', import.meta.url));
function start(phase: string, directory: string) {
  const child = fork(fixture, [phase, directory], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  return ownProcess(child, { label: `unregistered author ${phase}` });
}

describe('pre-signed unregistered authors through built worker and native persistence', () => {
  it.each(['reject', 'intent-reject'])('rejects missing inventory signing before owner admission and WM consumption (%s)', async phase => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-presigned-reject-'));
    const process = start(phase, directory);
    try {
      await process.waitForExit(60_000);
      expect(JSON.parse(await readFile(join(directory, 'rejected.json'), 'utf8')))
        .toEqual({ noOwner: true, wmAndSealUnchanged: true });
    } finally { await process.stop(); await rm(directory, { recursive: true, force: true }); }
  }, 70_000);

  it('preserves pre-signed sharing without an author key on a lane without mandatory inventory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-presigned-legacy-'));
    const process = start('legacy', directory);
    try {
      await process.waitForExit(60_000);
      expect(JSON.parse(await readFile(join(directory, 'legacy.json'), 'utf8')))
        .toEqual({ preSignedWithoutAuthorKey: true, shareSucceeded: true });
    } finally { await process.stop(); await rm(directory, { recursive: true, force: true }); }
  }, 70_000);

  it('automatically recovers a signer transport failure after successful preflight', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-presigned-transient-'));
    const process = start('transient', directory);
    try {
      await process.waitForExit(60_000);
      expect(JSON.parse(await readFile(join(directory, 'transient.json'), 'utf8')))
        .toEqual({ originalJobRecovered: true, attempts: 2, exactCatalogRows: 1 });
    } finally { await process.stop(); await rm(directory, { recursive: true, force: true }); }
  }, 70_000);

  it('rediscovers a released author scope after SIGKILL without replaying its succeeded job', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-presigned-restart-'));
    const first = start('commit', directory);
    let ready = false;
    first.child.on('message', message => { if ((message as { readyToCrash?: boolean }).readyToCrash) ready = true; });
    let second: ReturnType<typeof start> | undefined;
    try {
      await first.ready(() => ready ? true : undefined, { timeoutMs: 60_000 });
      first.child.kill('SIGKILL');
      expect((await first.closed).signal).toBe('SIGKILL');
      second = start('recover', directory);
      await second.waitForExit(60_000);
      const before = JSON.parse(await readFile(join(directory, 'committed.json'), 'utf8'));
      const after = JSON.parse(await readFile(join(directory, 'recovered.json'), 'utf8'));
      expect(after.pid).not.toBe(before.pid);
      expect(after).toMatchObject({ originalJob: true, noReplay: true, exactCatalogRows: 1, sealUnchanged: true });
    } finally { await first.stop(); await second?.stop(); await rm(directory, { recursive: true, force: true }); }
  }, 130_000);
});
