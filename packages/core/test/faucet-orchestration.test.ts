import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Direct coverage for the shared faucet ORCHESTRATOR (`fundWalletsBestEffort`),
// which the openclaw/hermes/mcp setup paths all delegate funding to. Only the
// faucet HTTP primitive (`requestFaucetFunding`) is mocked — `readWallets`
// (real fs read of DKG_HOME/wallets.json), `getFundableWalletAddresses`, and
// `logManualFundingInstructions` (real console output) run as production code,
// so the failure / partial-success / manual-curl branches are exercised for
// real. `fundWalletsBestEffort` imports `requestFaucetFunding` from
// `./faucet.js`, so mocking that module intercepts the orchestrator's call.
vi.mock('../src/faucet.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/faucet.js')>();
  return { ...actual, requestFaucetFunding: vi.fn() };
});

import { fundWalletsBestEffort } from '../src/faucet-orchestration.js';
import { requestFaucetFunding } from '../src/faucet.js';

const NETWORK = { faucet: { url: 'https://faucet.test/api', mode: 'testnet' } };

describe('fundWalletsBestEffort (shared faucet orchestrator)', () => {
  let dkgHome: string;
  let oldDkgHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dkgHome = mkdtempSync(join(tmpdir(), 'dkg-faucet-orch-'));
    oldDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(requestFaucetFunding).mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    if (oldDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = oldDkgHome;
    rmSync(dkgHome, { recursive: true, force: true });
  });

  function seedWallets() {
    writeFileSync(
      join(dkgHome, 'wallets.json'),
      JSON.stringify({
        adminWallet: { address: '0xADMIN', privateKey: '0x0' },
        wallets: [
          { address: '0xOP1', privateKey: '0x0' },
          { address: '0xOP2', privateKey: '0x0' },
        ],
      }),
    );
  }
  const logged = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  const warned = () => warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  // Just the `--data-raw '{"mode":...,"wallets":[...]}'` curl line(s), so wallet
  // assertions target the manual-funding batch — NOT the unrelated
  // `Wallets: 0x…` line readWallets() logs for every discovered wallet.
  const curlWallets = () =>
    logSpy.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('--data-raw')).join('\n');

  it('skips (no faucet call) when the network has no faucet configured (e.g. mainnet)', async () => {
    seedWallets();
    await fundWalletsBestEffort({ network: {}, didStartDaemon: false });
    expect(requestFaucetFunding).not.toHaveBeenCalled();
    expect(logged()).toMatch(/Skipping wallet funding \(no faucet configured/);
  });

  it('skips (no faucet call) when wallets.json is absent', async () => {
    // No seedWallets() — readWallets() returns [] (with a warning).
    await fundWalletsBestEffort({ network: NETWORK, didStartDaemon: false });
    expect(requestFaucetFunding).not.toHaveBeenCalled();
    expect(warned()).toMatch(/No wallet addresses available/);
  });

  it('calls the faucet with the discovered addresses + idempotency seed on full success (no manual curl)', async () => {
    seedWallets();
    vi.mocked(requestFaucetFunding).mockResolvedValue({ success: true, funded: ['0.01 ETH', '1000 TRAC'] } as any);

    await fundWalletsBestEffort({ network: NETWORK, idempotencySeed: 'agent-x', didStartDaemon: false });

    expect(requestFaucetFunding).toHaveBeenCalledTimes(1);
    const [url, mode, addresses, seed] = vi.mocked(requestFaucetFunding).mock.calls[0] as any[];
    expect(url).toBe('https://faucet.test/api');
    expect(mode).toBe('testnet');
    expect(addresses).toEqual(['0xADMIN', '0xOP1', '0xOP2']);
    expect(seed).toBe('agent-x');
    expect(logged()).not.toMatch(/To fund wallets manually/);
  });

  it('logs manual curl instructions (non-fatal) when the faucet throws', async () => {
    seedWallets();
    vi.mocked(requestFaucetFunding).mockRejectedValue(new Error('faucet 503'));

    // Best-effort: must never throw.
    await expect(
      fundWalletsBestEffort({ network: NETWORK, didStartDaemon: false }),
    ).resolves.toBeUndefined();

    expect(warned()).toMatch(/Faucet call failed: faucet 503/);
    expect(logged()).toMatch(/To fund wallets manually/);
    // All wallets fall back into the manual-curl batch when the call throws.
    expect(curlWallets()).toContain('0xADMIN');
    expect(curlWallets()).toContain('0xOP2');
  });

  it('logs the faucet-provided reason + manual curl for ALL wallets on success:false', async () => {
    seedWallets();
    vi.mocked(requestFaucetFunding).mockResolvedValue({
      success: false,
      funded: [],
      error: 'cooldown_active: Caller cooldown active',
    } as any);

    await fundWalletsBestEffort({ network: NETWORK, didStartDaemon: false });

    expect(warned()).toMatch(/cooldown_active/);
    expect(logged()).toMatch(/To fund wallets manually/);
    expect(curlWallets()).toContain('0xADMIN');
    expect(curlWallets()).toContain('0xOP2');
  });

  it('logs manual curl for the FAILED wallets only on partial success', async () => {
    seedWallets();
    vi.mocked(requestFaucetFunding).mockResolvedValue({
      success: true,
      funded: ['0.01 ETH'],
      failedWallets: ['0xOP2'],
      error: 'Faucet did not fund all wallets: 0xOP2',
    } as any);

    await fundWalletsBestEffort({ network: NETWORK, didStartDaemon: false });

    expect(warned()).toMatch(/Faucet partially completed/);
    expect(logged()).toMatch(/To fund wallets manually/);
    // Only the FAILED wallet is in the manual-curl batch; the funded ones are not.
    expect(curlWallets()).toContain('0xOP2');
    expect(curlWallets()).not.toContain('0xADMIN');
    expect(curlWallets()).not.toContain('0xOP1');
  });
});
