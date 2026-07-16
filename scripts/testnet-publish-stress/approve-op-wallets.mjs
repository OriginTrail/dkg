#!/usr/bin/env node
/**
 * One-shot helper: approve TRAC spending for KAv10 from each of Miles'
 * operational wallets.
 *
 * Why this exists: the publisher's auto-approve logic in
 * `packages/chain/src/evm-adapter.ts:1604` is gated on
 * `params.tokenAmount > 0n`. On testnet `getRequiredPublishTokenAmount`
 * returns 0 for small payloads and `1n` is used only as the on-chain
 * minimum at the actual publish call — so the approve-block is skipped
 * and any op-wallet with allowance=0 reverts the publish with
 * `TooLowAllowance(token, 0, 1)`. Miles' init only pre-approved one of
 * the 3 op-wallets, so two of them are stuck at allowance ∈ {0, 1}.
 *
 * This script signs an `approve(KAv10, MAX_UINT256)` TX from each op-wallet
 * directly against Base Sepolia, bypassing the daemon. Run once and
 * forget. Private keys come from `~/.dkg/wallets.json` (plaintext on
 * disk; never leaves the machine).
 *
 * Recommended CLI command this should eventually be: `dkg wallet approve-publisher`.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ethers;
try { ethers = require('ethers'); }
catch { ethers = require(`${process.cwd()}/node_modules/.pnpm/ethers@6.16.0_bufferutil@4.1.0_utf-8-validate@5.0.10/node_modules/ethers`); }

const RPC = 'https://sepolia.base.org';
const TRAC = '0x2A58BdD13176D85906D804cdbFFA0D9119282DC8';
const KAV10 = '0x65dcDD2484F6db18c53Ea9b31541237d7E005566';
const MAX_UINT256 = ethers.MaxUint256;
const APPROVE_THRESHOLD = ethers.parseEther('1000000');  // 1M TRAC — anything below this means it's not "infinite"

const TOKEN_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const provider = new ethers.JsonRpcProvider(RPC);

async function withRetry(fn, label, attempts = 6) {
  let delay = 1000;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      const msg = err?.error?.message ?? err?.shortMessage ?? err?.message ?? String(err);
      if (i === attempts - 1) throw err;
      console.error(`  ${label} retry ${i + 1}/${attempts}: ${msg.slice(0, 120)}; waiting ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 8000);
    }
  }
}

async function waitForReceipt(txHash, label) {
  for (let i = 0; i < 30; i++) {
    const r = await withRetry(() => provider.getTransactionReceipt(txHash), `${label} receipt poll`);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`${label}: timed out waiting for receipt`);
}

const walletsJson = JSON.parse(await readFile(`${homedir()}/.dkg/wallets.json`, 'utf8'));
const opWallets = walletsJson.wallets;
console.error(`Found ${opWallets.length} op-wallets in ~/.dkg/wallets.json`);

for (const w of opWallets) {
  const signer = new ethers.Wallet(w.privateKey, provider);
  const token = new ethers.Contract(TRAC, TOKEN_ABI, signer);
  const current = await withRetry(
    () => token.allowance(w.address, KAV10),
    `${w.address.slice(0,8)} allowance`,
  );
  const display = current === MAX_UINT256 ? 'MAX_UINT256' : current.toString();
  console.error(`\n${w.address}`);
  console.error(`  current allowance for KAv10: ${display}`);
  if (current >= APPROVE_THRESHOLD) {
    console.error('  already infinite-approved — skipping');
    continue;
  }
  const ethBal = await withRetry(
    () => provider.getBalance(w.address),
    `${w.address.slice(0,8)} balance`,
  );
  console.error(`  ETH balance: ${ethers.formatEther(ethBal)}`);
  if (ethBal < ethers.parseEther('0.0001')) {
    console.error('  ETH too low for an approve TX — please top up; SKIPPING');
    continue;
  }
  console.error(`  → sending approve(KAv10, MAX_UINT256)...`);
  const tx = await withRetry(
    () => token.approve(KAV10, MAX_UINT256),
    `${w.address.slice(0,8)} approve send`,
  );
  console.error(`    tx hash: ${tx.hash}`);
  const receipt = await waitForReceipt(tx.hash, w.address.slice(0,8));
  console.error(`    mined in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  const newAllowance = await withRetry(
    () => token.allowance(w.address, KAV10),
    `${w.address.slice(0,8)} re-check`,
  );
  const newDisplay = newAllowance === MAX_UINT256 ? 'MAX_UINT256 ✓' : newAllowance.toString();
  console.error(`    new allowance: ${newDisplay}`);
}

console.error('\n=== final state ===');
for (const w of opWallets) {
  const token = new ethers.Contract(TRAC, TOKEN_ABI, provider);
  const current = await withRetry(
    () => token.allowance(w.address, KAV10),
    `${w.address.slice(0,8)} final`,
  );
  const display = current === MAX_UINT256 ? 'MAX_UINT256 ✓' : current.toString();
  console.error(`  ${w.address}: ${display}`);
}
