/**
 * OT-RFC-41 Bundle B — Edge npm-only update + rollback flow integration test.
 *
 * The unit suite in `packages/cli/test/rfc-41-bundle-b.test.ts` covers
 * the LOGIC of `performNpmUpdateEdge` + `dkg rollback` (Edge branch)
 * with a mocked `_autoUpdateIo.exec`. That gets us 95% of the
 * confidence. The last 5% — that `npm install -g` actually mutates
 * disk, that the installed binary actually runs, that the
 * previous-version breadcrumb survives a real exec round-trip — is
 * what this integration test closes.
 *
 * The actual orchestration lives in `scripts/devnet-test-edge-update.sh`
 * for two reasons:
 *
 *   1. The script is the form an operator can also run by hand for
 *      ad-hoc validation. Keeping the wiring in shell means the
 *      runbook in `docs/devnet/EDGE_UPDATE_VALIDATION.md` is a direct
 *      copy-paste of what CI executes — no test-runner-specific glue.
 *   2. Running `npm install -g` requires a clean process env (npm
 *      reads `NPM_CONFIG_*`, `.npmrc`, etc. up front, not per-spawn),
 *      so a child process boundary is the path of least resistance.
 *      Vitest+forks gives us that boundary naturally.
 *
 * This file is the thinnest possible vitest wrapper: it shells out to
 * the script, asserts a clean exit code, and surfaces failures with
 * the script's own stderr so the failure report is grep-friendly.
 *
 * Preconditions:
 *   - `pnpm install` + `pnpm build` from the repo root.
 *   - `npx -y verdaccio --version` works on the host (the script
 *     uses `npx -y verdaccio@latest` to boot the registry).
 *
 * Runtime: ~3-5 minutes — the publish stage iterates ~15 public
 * workspace packages and the install stage does two `npm install -g`
 * round-trips with the MarkItDown postinstall.
 *
 * Run via `pnpm test:devnet:edge-update-flow` from the repo root.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'devnet-test-edge-update.sh');

describe('RFC-41 Bundle B — Edge npm-only update + rollback round-trip', () => {
  it('runs scripts/devnet-test-edge-update.sh to completion', async () => {
    expect(existsSync(SCRIPT), `expected ${SCRIPT} to exist`).toBe(true);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const proc = spawn('bash', [SCRIPT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // Honour any operator overrides the runbook documents, but
        // do not silently inject anything else — keep this transparent
        // for debugging.
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (c: Buffer) => {
      stdoutChunks.push(c);
      // Stream the script's progress so a stalled stage is visible
      // in CI logs without having to wait for the test to time out.
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

    if (exitCode !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const tail = (s: string, n: number) => s.split('\n').slice(-n).join('\n');
      throw new Error(
        `devnet-test-edge-update.sh exited ${exitCode}\n` +
          `--- last 40 lines of stderr ---\n${tail(stderr, 40)}\n` +
          `--- last 40 lines of stdout ---\n${tail(stdout, 40)}`,
      );
    }

    const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
    // Final assertion lines emitted by the script — anchor the test
    // to the production contract so a regression that quietly skips
    // a stage still fails here.
    expect(stdout).toMatch(/\[edge-update\] v1 installed and reports version /);
    expect(stdout).toMatch(/\[edge-update\] previous-version=.* \(matches v1\)/);
    expect(stdout).toMatch(/\[edge-update\] binary now reports /);
    expect(stdout).toMatch(/\[edge-update\] binary back to .* after rollback — round-trip complete/);
    expect(stdout).toMatch(/\[edge-update\] PASS — Edge npm-only update \+ rollback round-trip/);
  });
});
