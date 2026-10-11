import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

const CHILD = fileURLToPath(new URL('./fixtures/context-graph-name-adoption-crash-child.ts', import.meta.url));
const EVENT_PREFIX = 'DKG_ADOPTION_CRASH_EVENT ';
const CLEARTEXT = 'acme-fun-facts';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CLEARTEXT)).toLowerCase();

function startChild(mode: 'stage' | 'verify', dataDir: string) {
  // Launch Node directly. The tsx CLI forks a second Node process, so killing
  // its wrapper would leave the fixture alive and keep its stdio pipes open.
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, mode, dataDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, closed, stderr: () => stderr };
}

async function waitForEvent(
  child: ChildProcessWithoutNullStreams,
  kind: string,
  stderr: () => string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let pending = '';
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${kind}; ${stderr()}`)), 20_000);
    function finish(error?: Error, event?: Record<string, unknown>) {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('close', onClose);
      if (error) reject(error);
      else resolve(event!);
    }
    function onClose(code: number | null, signal: NodeJS.Signals | null) {
      finish(new Error(`child exited before ${kind}: code=${code} signal=${signal}; ${stderr()}`));
    }
    function onData(chunk: Buffer) {
      pending += chunk.toString();
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) return;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.startsWith(EVENT_PREFIX)) continue;
        const event = JSON.parse(line.slice(EVENT_PREFIX.length)) as Record<string, unknown>;
        if (event.kind === kind) return finish(undefined, event);
      }
    }
    child.stdout.on('data', onData);
    child.once('close', onClose);
  });
}

describe('name-hash adoption after an unclean process exit', () => {
  it('retires the durable hash row on restart when SIGKILL interrupts its deletion', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-name-adoption-crash-'));
    let stage: ReturnType<typeof startChild> | undefined;
    let verify: ReturnType<typeof startChild> | undefined;
    try {
      stage = startChild('stage', dataDir);
      const checkpoint = await waitForEvent(stage.child, 'crash-window', stage.stderr);
      expect(checkpoint.rows).toEqual([NAME_HASH, CLEARTEXT].sort());
      // SQLite has committed the canonical row, while deletion of the old
      // hash row is parked. No graceful agent or database shutdown runs.
      stage.child.kill('SIGKILL');
      const stopped = await stage.closed;
      expect(stopped.code).not.toBe(0);

      verify = startChild('verify', dataDir);
      const result = await waitForEvent(verify.child, 'verified', verify.stderr);
      expect(await verify.closed).toMatchObject({ code: 0 });
      expect(result).toMatchObject({
        before: [NAME_HASH, CLEARTEXT].sort(),
        after: [CLEARTEXT],
        active: [CLEARTEXT],
        alias: CLEARTEXT,
      });
    } finally {
      if (stage?.child.exitCode === null) stage.child.kill('SIGKILL');
      if (verify?.child.exitCode === null) verify.child.kill('SIGKILL');
      await Promise.all([stage?.closed, verify?.closed].filter(Boolean));
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
