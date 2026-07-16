/**
 * S2 step 6 + S4 step 6 orchestration tests for `runHermesSetup`.
 *
 * Per `agent-docs/hermes-parity/test-matrix.md`, these are the H-AC
 * rows that exercise the wiring between `runHermesSetup` and the
 * shared `@origintrail-official/dkg-core` lifecycle helpers extracted
 * in S1 (`startDaemon`, `fundWalletsBestEffort`, `requestFaucetFunding`).
 * The mock pattern mirrors `packages/adapter-openclaw/test/setup.test.ts`:
 * dual-mock on the dkg-core barrel + on the dist module path so calls
 * routed through intra-package imports inside the orchestrator are
 * intercepted as well.
 *
 * The matrix originally specified DI stubs at the action-handler
 * boundary. We mock at the dkg-core module boundary instead because:
 *   1. `runHermesSetup` is the canonical entrypoint per
 *      `setup-entrypoint-contract.md`, and tests should exercise it
 *      directly to lock the contract surface.
 *   2. The dual-mock pattern is already established and reviewed for
 *      adapter-openclaw faucet tests; consistency simplifies review.
 *
 * Covered rows from the deferred S2 step 6 set: H-AC-12, H-AC-16,
 * H-AC-22, H-AC-23, H-AC-24, H-AC-50. The remaining 15 deferred rows
 * either need real-daemon fixtures (out of scope per execution-plan §6)
 * or will land at the QA pre-#15 sweep.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hoisted spies shared across the dkg-core mock surfaces.
const startDaemonSpy = vi.hoisted(() => vi.fn(async () => {}));
const requestFaucetFundingSpy = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, funded: ['0x1', '0x2'], failedWallets: [] })),
);

// Mock #1: the dkg-core barrel — for any caller that imports
// `startDaemon` / `requestFaucetFunding` from the public surface.
vi.mock('@origintrail-official/dkg-core', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-core')>(
    '@origintrail-official/dkg-core',
  );
  return {
    ...actual,
    startDaemon: startDaemonSpy,
    requestFaucetFunding: requestFaucetFundingSpy,
  };
});

// Mock #2: the dkg-core dist module path — for intra-package callers
// inside core that reach `requestFaucetFunding` via `./faucet.js` (the
// `fundWalletsBestEffort` orchestrator does this). Same dual-mock
// pattern S1.3 documented.
vi.mock('@origintrail-official/dkg-core/dist/faucet.js', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-core/dist/faucet.js')>(
    '@origintrail-official/dkg-core/dist/faucet.js',
  );
  return {
    ...actual,
    requestFaucetFunding: requestFaucetFundingSpy,
  };
});

// Stub fetch for the daemon-registration probe so it doesn't try to
// hit a real socket. Returns a generic OK response.
const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
}));

describe('runHermesSetup orchestration (S2 step 6 + S4 step 6 deferred sweep)', () => {
  let hermesHome: string;

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hermes-orch-'));
    startDaemonSpy.mockClear();
    requestFaucetFundingSpy.mockClear();
    requestFaucetFundingSpy.mockResolvedValue({
      success: true,
      funded: ['0x1', '0x2'],
      failedWallets: [],
    });
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockClear();
  });

  afterEach(() => {
    rmSync(hermesHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  // H-AC-12: `--no-start` does not invoke `startDaemon`.
  it('H-AC-12: --no-start does not invoke startDaemon', async () => {
    const { runHermesSetup } = await import('@origintrail-official/dkg-adapter-hermes');

    await runHermesSetup({ hermesHome, start: false, fund: false, verify: false });

    expect(startDaemonSpy).toHaveBeenCalledTimes(0);
  });

  // H-AC-12 positive control: default flags DO invoke startDaemon.
  it('H-AC-12 (positive): default start invokes startDaemon exactly once', async () => {
    const { runHermesSetup } = await import('@origintrail-official/dkg-adapter-hermes');

    await runHermesSetup({ hermesHome, fund: false, verify: false });

    expect(startDaemonSpy).toHaveBeenCalledTimes(1);
  });

  // H-AC-16: `--no-fund` skips the faucet call.
  it('H-AC-16: --no-fund does not invoke requestFaucetFunding', async () => {
    const { runHermesSetup } = await import('@origintrail-official/dkg-adapter-hermes');

    await runHermesSetup({ hermesHome, start: false, fund: false, verify: false });

    expect(requestFaucetFundingSpy).toHaveBeenCalledTimes(0);
  });

  // H-AC-22: `--dry-run` does not invoke startDaemon.
  it('H-AC-22: --dry-run does not invoke startDaemon', async () => {
    const { runHermesSetup } = await import('@origintrail-official/dkg-adapter-hermes');

    await runHermesSetup({ hermesHome, dryRun: true });

    expect(startDaemonSpy).toHaveBeenCalledTimes(0);
  });

  // H-AC-23: `--dry-run` does not invoke requestFaucetFunding.
  it('H-AC-23: --dry-run does not invoke requestFaucetFunding', async () => {
    const { runHermesSetup } = await import('@origintrail-official/dkg-adapter-hermes');

    await runHermesSetup({ hermesHome, dryRun: true });

    expect(requestFaucetFundingSpy).toHaveBeenCalledTimes(0);
  });

  // H-AC-24: `--dry-run` does not call any HTTP that would touch disk
  // (e.g. the daemon-registration probe). The orchestrator gates
  // `connectDaemonBestEffort` on `!dryRun`, so the stubbed fetch
  // should never fire for dry-run.
  it('H-AC-24: --dry-run does not invoke the daemon-registration probe (no fetch calls)', async () => {
    const { runHermesSetup } = await import('@origintrail-official/dkg-adapter-hermes');

    await runHermesSetup({ hermesHome, dryRun: true });

    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  // H-AC-50: `--port` validation rejects out-of-range values BEFORE
  // any daemon-start attempt. The orchestrator delegates port parsing
  // to `toSetupOptions` → `normalizePort`, which throws for invalid
  // ports synchronously during `setup-options.js` resolution.
  it('H-AC-50: --port out-of-range rejects without invoking startDaemon', async () => {
    const { runHermesSetup } = await import('@origintrail-official/dkg-adapter-hermes');

    // The port goes through `toSetupOptions` → `normalizePort` which
    // throws synchronously. The orchestrator wraps the throw in result
    // errors rather than re-throwing, so we assert via result.ok=false.
    let threw = false;
    try {
      await runHermesSetup({
        hermesHome,
        port: 70000,
        start: false,
        fund: false,
        verify: false,
      });
    } catch (err: any) {
      threw = true;
      expect(String(err?.message ?? err)).toMatch(/Invalid Hermes daemon port/);
    }
    // Either path is acceptable: the orchestrator may surface the throw
    // or capture into result.errors. What MUST hold: startDaemon was
    // not invoked.
    expect(startDaemonSpy).toHaveBeenCalledTimes(0);
    expect(threw).toBe(true);
  });
});
