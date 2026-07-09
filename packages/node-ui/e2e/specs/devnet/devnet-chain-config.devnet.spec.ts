/**
 * Devnet chain/config guard (#1403 — solc 0.8.24 + cancun pin).
 *
 * The Playwright devnet compiles + deploys the EVM contracts with the
 * devnet-only Hardhat config (`hardhat.devnet.config.ts`: solc 0.8.24, cancun
 * EVM target, cancun in-process hardfork) because the lockfile-pinned
 * @openzeppelin/contracts 5.4.0 emits `mcopy` (EIP-5656). A regression in that
 * pin (solc bump into the 0.8.26+ stack-too-deep range, hardfork drift back to
 * shanghai, config split between `hardhat node` and `hardhat deploy`) breaks
 * the deploy — and without this spec that surfaces minutes later as opaque
 * downstream e2e failures. This spec asserts the OBSERVABLE contract directly:
 * the devnet chain is up, is the expected chain, actually EXECUTED the deploy
 * (the Hub has bytecode), and keeps mining.
 */
import { test, expect } from '../../fixtures/base.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDevnetNode, requireDevnetNode, waitForDevnetStatus } from '../../helpers/devnet.js';

const HARDHAT_RPC = `http://127.0.0.1:${process.env.HARDHAT_PORT || 8545}`;

async function rpc(method: string, params: unknown[] = []): Promise<string> {
  const res = await fetch(HARDHAT_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(res.ok, `hardhat RPC ${method} HTTP ${res.status}`).toBe(true);
  const json = (await res.json()) as { result?: string; error?: { message: string } };
  expect(json.error, `hardhat RPC ${method} error: ${json.error?.message}`).toBeUndefined();
  return json.result!;
}

/** The devnet writes the deployed Hub address next to the node homes. */
function readHubAddress(): string {
  const node1 = readDevnetNode(1);
  expect(node1, 'devnet node1 home not found (.devnet/node1)').not.toBeNull();
  const hubFile = join(node1!.home, '..', 'hardhat', 'hub_address');
  const addr = readFileSync(hubFile, 'utf8').trim();
  expect(addr, `no Hub address in ${hubFile}`).toMatch(/^0x[0-9a-fA-F]{40}$/);
  return addr;
}

test.beforeAll(async () => {
  await requireDevnetNode(test, 1);
  await waitForDevnetStatus(1);
});

test.describe('devnet chain under the pinned solc/cancun config', () => {
  test('is the expected local chain (31337) and the Hub deploy actually executed', async () => {
    expect(await rpc('eth_chainId')).toBe('0x7a69'); // 31337

    // The strongest black-box proof the 0.8.24/cancun compile+deploy worked:
    // the Hub address the nodes were configured with carries real bytecode. A
    // solc pin regression fails the deploy (no code), a hardfork regression
    // reverts the deploy txs (mcopy is invalid pre-cancun) — both land here.
    const code = await rpc('eth_getCode', [readHubAddress(), 'latest']);
    expect(code.length, 'Hub has no deployed bytecode — devnet contract deploy regressed').toBeGreaterThan(2);
  });

  test('keeps mining (interval mining is on, so time-dependent flows work)', async () => {
    // devnet.sh enables interval mining precisely so block.number/timestamp
    // never freeze between txs (policy confirmation, epochs). Poll briefly:
    // a devnet that stops mining breaks every publish-confirm flow.
    const first = parseInt(await rpc('eth_blockNumber'), 16);
    let last = first;
    const deadline = Date.now() + 15_000;
    while (last <= first && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_000));
      last = parseInt(await rpc('eth_blockNumber'), 16);
    }
    expect(last, `block number stuck at ${first} for 15s — devnet chain not mining`).toBeGreaterThan(first);
  });
});
