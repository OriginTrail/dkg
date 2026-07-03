import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerPcaCommand } from '../src/commands/pca.js';
import { ApiClient } from '../src/api-client.js';

// R9 (9-D) — the CLI translates the register-agent advisory shape into
// operator-facing text; without a command-level test, a regression in that
// translation stays green in the route/facade tests while misleading users.
// Mock ApiClient.registerPcaAgent per advisory branch, run the command in
// process, and assert stdout.
async function runRegisterAgent(
  resp: { registered?: boolean; verified?: boolean | null; adapterSupported: boolean },
): Promise<string> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  const connectSpy = vi.spyOn(ApiClient, 'connect').mockResolvedValue({
    registerPcaAgent: async () => ({
      accountId: '7',
      agent: '0x' + '1'.repeat(40),
      registered: resp.registered ?? true,
      txHash: '0xreg',
      blockNumber: 9,
      // Legacy (pre-#1346) responses OMIT `verified`; include it only when set.
      ...(resp.verified !== undefined ? { verified: resp.verified } : {}),
      adapterSupported: resp.adapterSupported,
    }),
  } as any);
  try {
    const program = new Command();
    program.exitOverride(); // don't call process.exit on completion
    registerPcaCommand(program);
    await program.parseAsync(['node', 'dkg', 'pca', 'register-agent', '7', '0x' + '1'.repeat(40)]);
    return logs.join('\n');
  } finally {
    logSpy.mockRestore();
    connectSpy.mockRestore();
  }
}

describe('pca register-agent — advisory output rendering', () => {
  it('verified:true → "confirmed on-chain"', async () => {
    const out = await runRegisterAgent({ verified: true, adapterSupported: true });
    expect(out).toMatch(/registered: true/);
    expect(out).toMatch(/verified:\s+confirmed on-chain/);
  });

  it('verified:false (adapterSupported:true) → "pending"', async () => {
    const out = await runRegisterAgent({ verified: false, adapterSupported: true });
    expect(out).toMatch(/registered: true/);
    expect(out).toMatch(/verified:\s+pending/);
  });

  it('verified:null (adapterSupported:true) → "pending"', async () => {
    const out = await runRegisterAgent({ verified: null, adapterSupported: true });
    expect(out).toMatch(/verified:\s+pending/);
  });

  it('adapterSupported:false → "not verifiable on this adapter"', async () => {
    const out = await runRegisterAgent({ verified: null, adapterSupported: false });
    expect(out).toMatch(/verified:\s+not verifiable on this adapter/);
  });

  // R10 — legacy (pre-#1346) daemon omits `verified`; its registered:true meant
  // the on-chain read confirmed the registration, so it must render as confirmed
  // (not the generic pending fallback), preserving the modeled legacy wire shape.
  it('legacy shape (verified absent, registered:true, adapterSupported:true) → confirmed, not pending', async () => {
    const out = await runRegisterAgent({ adapterSupported: true }); // no `verified` field
    expect(out).toMatch(/registered: true/);
    expect(out).toMatch(/verified:\s+confirmed on-chain/);
    expect(out).not.toMatch(/pending/);
  });

  // R14 (14-A) — a pre-#1346 daemon has no success:false guard, so a legacy
  // `registered:false` may be a failed/unconfirmed tx. We must NOT force it to
  // `registered:true` (that would report a failed registration as success);
  // surface it as-is with an unverifiable status.
  it('legacy unverifiable (verified absent, registered:false, adapterSupported:false) → registered:false + unverifiable, NOT forced true', async () => {
    const out = await runRegisterAgent({ registered: false, adapterSupported: false });
    expect(out).toMatch(/registered: false/);
    expect(out).toMatch(/verified:\s+unverifiable/);
    expect(out).not.toMatch(/registered: true/);
  });

  it('legacy unverifiable (verified absent, registered:false, adapterSupported:true) → registered:false + unverifiable (unconfirmed legacy tx not reported registered)', async () => {
    const out = await runRegisterAgent({ registered: false, adapterSupported: true });
    expect(out).toMatch(/registered: false/);
    expect(out).toMatch(/verified:\s+unverifiable/);
    expect(out).not.toMatch(/registered: true/);
  });
});
