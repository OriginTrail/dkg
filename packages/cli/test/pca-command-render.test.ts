import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerPcaCommand } from '../src/commands/pca.js';
import { ApiClient } from '../src/api-client.js';
import type { RegisterAgentAdvisoryStatus } from '../src/pca-confirmation-wire.js';

// R9/R15 — the CLI renders the register-agent advisory into operator-facing
// text. Since R15 the client normalizes the wire response into
// `{ registered, advisory }`, so the command consumes that directly; these
// tests mock the normalized ApiClient result and assert stdout per advisory
// status. (The raw wire → normalized decode is covered by the decoder unit
// tests in pca-confirmation-wire.test.ts.)
async function runRegisterAgent(result: {
  registered: boolean;
  advisory: RegisterAgentAdvisoryStatus;
}): Promise<string> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  const connectSpy = vi.spyOn(ApiClient, 'connect').mockResolvedValue({
    registerPcaAgent: async () => ({
      accountId: '7',
      agent: '0x' + '1'.repeat(40),
      registered: result.registered,
      advisory: result.advisory,
      txHash: '0xreg',
      blockNumber: 9,
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
  it('confirmed → "confirmed on-chain", registered:true', async () => {
    const out = await runRegisterAgent({ registered: true, advisory: 'confirmed' });
    expect(out).toMatch(/registered: true/);
    expect(out).toMatch(/verified:\s+confirmed on-chain/);
  });

  // not_observed / inconclusive both render as operator-facing "pending …" text
  // but stay distinct in the model (the canonical outcome is preserved).
  it('not_observed → "pending" (follower-RPC lag)', async () => {
    const out = await runRegisterAgent({ registered: true, advisory: 'not_observed' });
    expect(out).toMatch(/registered: true/);
    expect(out).toMatch(/verified:\s+pending.*follower-RPC lag/);
  });

  it('inconclusive → "pending" (read failed)', async () => {
    const out = await runRegisterAgent({ registered: true, advisory: 'inconclusive' });
    expect(out).toMatch(/registered: true/);
    expect(out).toMatch(/verified:\s+pending.*inconclusive/);
  });

  it('unsupported → "not verifiable on this adapter"', async () => {
    const out = await runRegisterAgent({ registered: true, advisory: 'unsupported' });
    expect(out).toMatch(/verified:\s+not verifiable on this adapter/);
  });

  // R14/R15 — a legacy-unverified result surfaces `registered` as-is and must
  // NOT be rendered as a successful registration.
  it('legacy-unverified → "unverifiable", registered:false (not reported as success)', async () => {
    const out = await runRegisterAgent({ registered: false, advisory: 'legacy-unverified' });
    expect(out).toMatch(/registered: false/);
    expect(out).toMatch(/verified:\s+unverifiable/);
    expect(out).not.toMatch(/registered: true/);
  });
});
