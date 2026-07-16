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
 * SKIP is NOT a pass (otReviewAgent #1517). When a precondition is unmet the
 * script exits with a DISTINCT code (3, not 0) and this wrapper reports the
 * test as a real vitest SKIP — never a pass — so a validation dashboard / sweep
 * counts a non-run as "not run", never as outage coverage on the primary
 * incident path. Distinguishers:
 *   - reporter status  → SKIPPED vs passed  (a graceful skip still exits 0, by
 *                         vitest design; the *reporter line* is what differs);
 *   - the script's exit → 3 (skip) vs 0 (ran-and-passed) vs other (failure);
 *   - DEVNET_REQUIRE_STORE_OUTAGE=1 → flips a precondition SKIP into a HARD
 *                         FAILURE so a CI "required devnet" lane can guarantee
 *                         the outage was actually exercised, while local/dev
 *                         runs still skip gracefully.
 *
 * Preconditions (the script SKIPs — exit 3 — with guidance when unmet, so the
 * suite is skipped-and-informative on unsuitable lanes rather than falsely
 * green or falsely red):
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
 * Required-lane run (skip becomes a failure):
 *   DEVNET_REQUIRE_STORE_OUTAGE=1 pnpm test:devnet:storage-ack-store-outage
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'devnet-test-store-outage.sh');

// Must match `SKIP_EXIT` in scripts/devnet-test-store-outage.sh.
const SKIP_EXIT = 3;
// Required-lane opt-in: a precondition SKIP becomes a hard FAILURE.
const REQUIRE_RUN = process.env.DEVNET_REQUIRE_STORE_OUTAGE === '1';

interface ScriptRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Spawn the shell script and capture its exit code + streams. */
async function runScript(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  echo: boolean,
): Promise<ScriptRun> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const proc = spawn('bash', [script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (c: Buffer) => {
    stdoutChunks.push(c);
    if (echo) process.stdout.write(c);
  });
  proc.stderr.on('data', (c: Buffer) => {
    stderrChunks.push(c);
    if (echo) process.stderr.write(c);
  });
  const exitCode: number = await new Promise((res, rej) => {
    proc.once('error', rej);
    proc.once('close', (code) => res(code ?? -1));
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
    stderr: Buffer.concat(stderrChunks).toString('utf-8'),
  };
}

// Discriminated outcome so the exit-code policy is one pure, unit-testable
// decision — and so a script SKIP can never fall through to the PASS assertions.
type Outcome =
  | { kind: 'ran' }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string };

const tailLines = (s: string, n: number): string => s.split('\n').slice(-n).join('\n');

/** Last `[store-outage] SKIP: ...` guidance line the script printed, if any. */
function lastSkipGuidance(stdout: string): string {
  const hits = stdout.split('\n').filter((l) => /\[store-outage\] SKIP:/.test(l));
  return hits.length ? hits[hits.length - 1].trim() : '(no SKIP: guidance line captured)';
}

/**
 * Map the script's exit code to a test outcome (otReviewAgent #1517):
 *   0        → ran (the wrapper then asserts the load-bearing PASS contract)
 *   SKIP_EXIT→ precondition unmet: a SKIP normally, but a hard FAIL when the
 *              required-lane flag demands the outage actually be exercised
 *   other    → a real failure
 * A SKIP is NEVER classified as `ran`, so a non-run can never be reported as a
 * passing outage-coverage result.
 */
export function classifyStoreOutageRun(
  exitCode: number,
  stdout: string,
  stderr: string,
  requireRun: boolean,
): Outcome {
  if (exitCode === 0) return { kind: 'ran' };
  if (exitCode === SKIP_EXIT) {
    const guidance = lastSkipGuidance(stdout);
    if (requireRun) {
      return {
        kind: 'fail',
        reason:
          `DEVNET_REQUIRE_STORE_OUTAGE=1 requires the store-outage integration to actually run, ` +
          `but a precondition was unmet and the script SKIPPED (exit ${SKIP_EXIT}) — the outage was ` +
          `NOT exercised. Stand up a 6-node devnet (./scripts/devnet.sh start 6, an EDGE publisher + ` +
          `an oxigraph-server core to isolate) so the incident path is covered.\n` +
          `Script guidance: ${guidance}`,
      };
    }
    return { kind: 'skip', reason: guidance };
  }
  return {
    kind: 'fail',
    reason:
      `devnet-test-store-outage.sh exited ${exitCode}\n` +
      `--- last 40 lines of stderr ---\n${tailLines(stderr, 40)}\n` +
      `--- last 40 lines of stdout ---\n${tailLines(stdout, 40)}`,
  };
}

describe('storage-ack-store-outage — a core store failing mid-publish degrades gracefully', () => {
  it('runs scripts/devnet-test-store-outage.sh to completion', async (ctx) => {
    expect(existsSync(SCRIPT), `expected ${SCRIPT} to exist`).toBe(true);

    const { exitCode, stdout, stderr } = await runScript(SCRIPT, REPO_ROOT, { ...process.env }, true);
    const outcome = classifyStoreOutageRun(exitCode, stdout, stderr, REQUIRE_RUN);

    if (outcome.kind === 'skip') {
      // A REAL vitest skip — the reporter shows SKIPPED, not passed, so a
      // non-run is never counted as outage coverage (otReviewAgent #1517).
      // eslint-disable-next-line no-console
      console.warn(`[storage-ack-store-outage] SKIPPED (precondition unmet) — ${outcome.reason}`);
      ctx.skip();
      return;
    }
    if (outcome.kind === 'fail') {
      throw new Error(outcome.reason);
    }

    // Ran to completion (exit 0). Anchor on the load-bearing contract so a
    // regression that quietly stops exercising the outage still fails: the
    // publish confirmed while one core's store was down, the paused core
    // returned the TYPED CORE_TEMPORARILY_UNAVAILABLE decline (dead-air here IS
    // the incident regression), and publishing recovered afterwards.
    expect(stdout).toMatch(/publish confirmed via the healthy cores while node\d+'s store was down/);
    expect(stdout).toMatch(/node\d+ returned a typed CORE_TEMPORARILY_UNAVAILABLE decline/);
    expect(stdout).toMatch(/publish confirmed after node\d+'s store recovered/);
    expect(stdout).toMatch(/\[store-outage\] PASS/);
  }, 360_000);
});

// Harness assertions (otReviewAgent #1517) — unit-level, NO live devnet needed.
// Prove that a script-level SKIP is surfaced as a vitest SKIP (or a FAILURE in
// the required lane), and NEVER as a passing outage-coverage result.
describe('storage-ack-store-outage — a precondition SKIP is never reported as a pass (otReviewAgent #1517)', () => {
  it('classifies a passing run (exit 0) as ran (asserts the outage contract)', () => {
    expect(classifyStoreOutageRun(0, '[store-outage] PASS', '', false)).toEqual({ kind: 'ran' });
  });

  it('classifies a precondition SKIP (exit 3) as skip, NOT ran/pass', () => {
    const o = classifyStoreOutageRun(SKIP_EXIT, '[store-outage] SKIP: no devnet at ./.devnet', '', false);
    expect(o.kind).toBe('skip');
    expect(o.kind).not.toBe('ran');
  });

  it('under DEVNET_REQUIRE_STORE_OUTAGE=1, a precondition SKIP (exit 3) becomes a hard FAIL', () => {
    const o = classifyStoreOutageRun(SKIP_EXIT, '[store-outage] SKIP: no devnet at ./.devnet', '', true);
    expect(o.kind).toBe('fail');
    if (o.kind === 'fail') expect(o.reason).toMatch(/DEVNET_REQUIRE_STORE_OUTAGE=1/);
  });

  it('classifies any other non-zero exit as a real failure', () => {
    expect(classifyStoreOutageRun(1, '', 'boom', false).kind).toBe('fail');
    expect(classifyStoreOutageRun(2, '', 'boom', true).kind).toBe('fail');
  });

  it('the REAL script exits with the SKIP code (3), never 0, when its first precondition is unmet', async () => {
    // Point DEVNET_DIR at a directory that cannot exist so the very first
    // precondition (`[ -d "$DEVNET_DIR" ]`) misses and the script SKIPs before
    // it needs lsof, a devnet, or any store to isolate. Strip the required-lane
    // flag from the child env so this stays deterministic even when the whole
    // suite runs in a required lane with the flag set ambiently.
    const env = { ...process.env };
    delete env.DEVNET_REQUIRE_STORE_OUTAGE;
    const { exitCode, stdout } = await runScript(SCRIPT, REPO_ROOT, {
      ...env,
      DEVNET_DIR: resolve(REPO_ROOT, '.devnet-store-outage-harness-does-not-exist'),
    }, false);

    expect(exitCode, 'a precondition miss must exit with the SKIP code, not 0/PASS').toBe(SKIP_EXIT);
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/\[store-outage\] SKIP:/);
    // The real exit code maps to a vitest SKIP locally...
    expect(classifyStoreOutageRun(exitCode, stdout, '', false).kind).toBe('skip');
    // ...and to a hard FAILURE in a required CI lane.
    expect(classifyStoreOutageRun(exitCode, stdout, '', true).kind).toBe('fail');
  }, 30_000);
});
