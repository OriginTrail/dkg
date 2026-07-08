/**
 * storage-ack-store-outage — the PRIMARY 2026-07-07 mainnet incident cause and
 * the G1 devnet gap.
 *
 * On mainnet a core's Blazegraph went unreachable under the sync storm; the
 * StorageACK handler could not read the SWM data and (pre-fix) dead-aired past
 * the publisher's 20s timeout, so the publisher mislabeled the empty reply
 * INVALID_SIGNATURE and the round burned. The fixes make that path graceful: a
 * TYPED CORE_TEMPORARILY_UNAVAILABLE decline, the publish still reaching quorum
 * via the HEALTHY cores, and recovery once the store is back.
 *
 * The unit tests prove the handler RETURNS that decline when its store throws —
 * but they mock the store. This suite covers the INTEGRATION the incident
 * exercised: a REAL store going down mid-publish, end-to-end across live nodes.
 *
 * The orchestration (identify the target core's managed store process, SIGSTOP
 * it, publish from an edge node, assert quorum + the typed decline, SIGCONT to
 * recover) lives in `scripts/devnet-test-store-outage.sh`, so an operator can
 * run it by hand and process control stays in shell — same shape as the
 * edge-update-flow suite. This file is the thin vitest wrapper.
 *
 * Preconditions (the script SKIPs — exit 0 — with guidance when unmet, so the
 * suite is green-and-informative on unsuitable lanes rather than falsely red):
 *   - a running devnet (`./scripts/devnet.sh start 6`) with an EDGE node to
 *     publish from (minimumRequiredSignatures=3 and a publisher does not sign
 *     its own quorum, so a core publisher + one paused core cannot reach quorum
 *     on the default 4-core layout — otReviewAgent #1517) and at least one
 *     non-publisher core on the daemon-managed `oxigraph-server` backend so ONE
 *     store can be isolated AND positively identified before it is signaled.
 *     The default devnet layout (oxigraph-server on cores 1-2, edges 5-6) fits.
 *   - `lsof` on the host (to find the store process by port).
 *
 * Run: pnpm test:devnet:storage-ack-store-outage
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'devnet-test-store-outage.sh');

describe('storage-ack-store-outage — a core store failing mid-publish degrades gracefully', () => {
  it('runs scripts/devnet-test-store-outage.sh to completion', async () => {
    expect(existsSync(SCRIPT), `expected ${SCRIPT} to exist`).toBe(true);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const proc = spawn('bash', [SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (c: Buffer) => {
      stdoutChunks.push(c);
      process.stdout.write(c);
    });
    proc.stderr.on('data', (c: Buffer) => {
      stderrChunks.push(c);
      process.stderr.write(c);
    });

    const exitCode: number = await new Promise((res, rej) => {
      proc.once('error', rej);
      proc.once('close', (code) => res(code ?? -1));
    });

    const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
    const stderr = Buffer.concat(stderrChunks).toString('utf-8');
    const tail = (s: string, n: number) => s.split('\n').slice(-n).join('\n');

    if (exitCode !== 0) {
      throw new Error(
        `devnet-test-store-outage.sh exited ${exitCode}\n` +
          `--- last 40 lines of stderr ---\n${tail(stderr, 40)}\n` +
          `--- last 40 lines of stdout ---\n${tail(stdout, 40)}`,
      );
    }

    // Either it SKIPped (precondition unmet) or it PASSed — both are exit 0. A
    // PASS must have asserted the load-bearing contract: publish confirmed while
    // one core's store was down, the paused core returned the TYPED
    // CORE_TEMPORARILY_UNAVAILABLE decline (the incident regression — dead-air
    // here fails the script), and the publish confirmed again after recovery.
    // Anchor on those lines so a regression that quietly stops exercising the
    // outage still fails.
    const skipped = /\[store-outage\] SKIP:/.test(stdout);
    if (skipped) {
      // eslint-disable-next-line no-console
      console.warn('[storage-ack-store-outage] suite SKIPPED — see guidance above');
      return;
    }
    expect(stdout).toMatch(/publish confirmed via the healthy cores while node\d+'s store was down/);
    expect(stdout).toMatch(/node\d+ returned a typed CORE_TEMPORARILY_UNAVAILABLE decline/);
    expect(stdout).toMatch(/publish confirmed after node\d+'s store recovered/);
    expect(stdout).toMatch(/\[store-outage\] PASS/);
  }, 360_000);
});
