/**
 * The `dkg ca` commands end to end, in the order and with the files of the
 * how-to (docs/use-dkg/conviction-accounts.md): the built CLI (dist/cli.js),
 * run as an operator runs it, against the /api/ca routes of two nodes on the
 * shared Hardhat node, each a DKGAgent over a real EVM adapter with a local
 * key.
 *
 * - Node A, the owner node, owns a 100,000 TRAC account (the 30 % discount
 *   tier) with its primary wallet.
 * - Node B, the assignee node, has its primary wallet as its buyer key.
 *
 * The local deployment leaves the schedule cut-over unset, so it is set
 * through the Hub before the account is created.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ethers, Wallet } from 'ethers';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import type { CaConsentResponse, CaContractsResponse, CaStatusResponse } from '../src/ca-client.js';
import { ensureExactScheduleFrom, serveCaNode, stopCaNode, type CaNode } from './_helpers/ca-hardhat-node.js';
import { createProvider, getSharedContext, HARDHAT_KEYS, revertSnapshot, takeSnapshot } from '../../chain/test/evm-test-context.js';
import { makeAdapterConfig, mintTokens } from '../../chain/test/hardhat-harness.js';

const execFileAsync = promisify(execFile);
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = join(PACKAGE_DIR, 'dist', 'cli.js');
const DAY = 86_400;

const owner = new Wallet(HARDHAT_KEYS.EXTRA1);
const buyer = new Wallet(HARDHAT_KEYS.EXTRA2);

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

let snapshotId: string;
let home: string;
let work: string;
let a: CaNode;
let b: CaNode;
let accountId: string;
let expires: string;

/** `dkg ca <args>` on a node, run in the how-to's working directory. */
async function dkg(node: CaNode, ...args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_ENTRY, 'ca', ...args], {
      cwd: work,
      env: { ...process.env, DKG_HOME: home, DKG_API_PORT: String(node.port), DKG_AUTH_TOKEN: '' },
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: unknown };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: typeof failed.code === 'number' ? failed.code : -1 };
  }
}

/** A command that must succeed: its stdout. */
async function ok(node: CaNode, ...args: string[]): Promise<string> {
  const run = await dkg(node, ...args);
  expect(run.code, `dkg ca ${args.join(' ')}\n${run.stderr}`).toBe(0);
  return run.stdout;
}

/** A plan file of the how-to: one inference bucket of `value` TRAC for 30 days, without a periodId. */
async function writePlan(file: string, value: string): Promise<void> {
  await writeFile(join(work, file), `${JSON.stringify({
    periodSeconds: 30 * DAY,
    planDigest: ethers.id(`plan ${file}`),
    buckets: [{ bucketId: ethers.id('bucket inference'), serviceClass: 'inference', value, maxAskWeiPerUnit: '2500000000000' }],
  }, null, 2)}\n`);
}

async function periodIdOf(file: string): Promise<string | undefined> {
  return (JSON.parse(await readFile(join(work, file), 'utf8')) as { periodId?: string }).periodId;
}

describe('the dkg ca how-to against the contracts on Hardhat', () => {
  beforeAll(async () => {
    if (!existsSync(join(PACKAGE_DIR, 'dist', 'commands', 'ca.js'))) {
      await execFileAsync('pnpm', ['run', 'build:compile'], { cwd: PACKAGE_DIR });
    }
    snapshotId = await takeSnapshot();
    home = await mkdtemp(join(tmpdir(), 'dkg-ca-home-'));
    work = await mkdtemp(join(tmpdir(), 'dkg-ca-work-'));
    const chainNow = await ensureExactScheduleFrom();
    expires = new Date((Math.max(chainNow, Math.floor(Date.now() / 1000)) + 30 * DAY) * 1000).toISOString();
    const { rpcUrl, hubAddress } = getSharedContext();
    await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, owner.address, ethers.parseEther('100000'));
    a = await serveCaNode('ca-howto-owner', new EVMChainAdapter(makeAdapterConfig(rpcUrl, hubAddress, HARDHAT_KEYS.EXTRA1)), owner.address);
    b = await serveCaNode('ca-howto-buyer', new EVMChainAdapter(makeAdapterConfig(rpcUrl, hubAddress, HARDHAT_KEYS.EXTRA2)), buyer.address);
    accountId = (await a.chain.createPublishingConvictionAccount(ethers.parseEther('100000'))).accountId.toString();
  }, 300_000);

  afterAll(async () => {
    for (const node of [a, b]) if (node) await stopCaNode(node);
    if (snapshotId) await revertSnapshot(snapshotId);
    for (const dir of [home, work]) if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('before you start: the contracts, the owned account and the buyer key', async () => {
    expect(await ok(a, 'contracts')).toMatch(/logicVersion: +10\.1\.0/);
    const contracts = JSON.parse(await ok(a, 'contracts', '--json')) as CaContractsResponse;
    expect(contracts.domain).toMatchObject({ name: 'DKGConvictionServices', version: '1', chainId: 31337 });
    expect(await ok(a, 'mine')).toMatch(new RegExp(`owned: +(.*, )?${accountId}\\b`));
    expect(await ok(b, 'mine')).toContain(`buyerKey:  ${buyer.address}`);
  });

  it('1. opts the account in on the owner node', async () => {
    const before = await ok(a, 'status', accountId);
    expect(before).toMatch(/serviceSpending: +off/);
    expect(before).toContain(`Switch service spending on with: dkg ca services ${accountId} enable`);
    expect(await ok(a, 'services', accountId, 'enable')).toContain(`Service spending on account ${accountId} is on:`);
    const after = await ok(a, 'status', accountId);
    expect(after).toMatch(/serviceSpending: +on since /);
    expect(after).toMatch(/discountBps: +3000 \(30\.00% off base cost\)/);
    const status = JSON.parse(await ok(a, 'status', accountId, '--json')) as CaStatusResponse;
    expect(status.schedule.exact).toBe(true);
    expect(status.schedule.lastEpoch - status.schedule.firstEpoch + 1).toBe(2 * status.lockDurationEpochs);
  });

  it('2. consents on the assignee node, writing consent.json', async () => {
    const out = await ok(b, 'consent', accountId, '--max-period', '25', '--max-window', '100', '--max-total', '1000',
      '--expires', expires, '--out', 'consent.json');
    expect(out).toContain('Consent signed by the buyer key; nothing was sent:');
    expect(out).toContain(`Next, on the owner node: dkg ca assign ${accountId} --consent consent.json`);
    const consent = JSON.parse(await readFile(join(work, 'consent.json'), 'utf8')) as CaConsentResponse;
    expect(consent.terms).toMatchObject({ accountId, assignee: buyer.address, maxQueryCostPerPeriod: '0', maxPeriodSeconds: 31 * DAY });
  });

  it('3. assigns the buyer key on the owner node', async () => {
    const out = await ok(a, 'assign', accountId, '--consent', 'consent.json');
    expect(out).toContain(`Assigned on account ${accountId}, sent as the owner:`);
    const listed = await ok(a, 'assignments', accountId);
    expect(listed).toContain(`${buyer.address}: active`);
    expect(listed).toMatch(/maxTotalCost: +1000\.0 TRAC/);
    // The consent's nonce is used up: the same file no longer assigns.
    const again = await dkg(a, 'assign', accountId, '--consent', 'consent.json');
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('InvalidAssignmentNonce (HTTP 409)');
  });

  it('4. funds a period on the assignee node, and a repeat funds nothing', async () => {
    await writePlan('plan.json', '10');
    const first = await dkg(b, 'fund', accountId, '--plan', 'plan.json');
    expect(first.code, first.stderr).toBe(0);
    const periodId = await periodIdOf('plan.json');
    expect(periodId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.stderr).toContain(`periodId ${periodId} is written to plan.json`);
    expect(first.stdout).toContain(`Funded period ${periodId} from account ${accountId}:`);
    expect(first.stdout).toMatch(/cost: +7\.0 TRAC \(30\.00% off\)/);
    expect(first.stdout).toMatch(/drawnFromTopUp: +0\.0 TRAC/);

    const repeat = await dkg(b, 'fund', accountId, '--plan', 'plan.json');
    expect(repeat.code, repeat.stderr).toBe(0);
    expect(repeat.stdout).toContain(`Period ${periodId} was already funded from account ${accountId}; nothing was sent:`);
  });

  it('5. inspects the period, the labels and the status', async () => {
    expect(await ok(a, 'periods', accountId)).toContain(`Periods funded from account ${accountId}: 1 (showing 1 to 1)`);
    const labels = await ok(a, 'labels', accountId);
    expect(labels).toMatch(/^ {2}epoch +scheduled +baseLabel +topUpLabel +serviceLabel +pool$/m);
    expect(await ok(a, 'status', accountId)).toMatch(/labels: +7\.0 TRAC, cursor at epoch \d+/);
    expect(await ok(b, 'mine')).toContain(`account ${accountId}: active; 7.0 of 1000.0 TRAC used`);
  });

  it('6. changes the caps on the owner node: below the usage they refuse funding, raised again they allow it', async () => {
    const tightened = await ok(a, 'caps', accountId, buyer.address, '--max-period', '5', '--max-inference', '5', '--max-total', '5');
    expect(tightened).toContain('are updated:');
    expect(tightened).toContain('maxTotalCost is below the usage, so every funding is refused until it is raised.');
    await writePlan('plan-2.json', '1');
    const refused = await dkg(b, 'fund', accountId, '--plan', 'plan-2.json');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('CapExceeded (HTTP 409): cap maxTotalCost, limit 5.0 TRAC, attempted 7.7 TRAC');
    const periodId = await periodIdOf('plan-2.json');
    expect(periodId).toBeDefined();

    expect(await ok(a, 'caps', accountId, buyer.address, '--max-period', '25', '--max-inference', '25', '--max-total', '1000')).toContain('are updated:');
    // The refused run sent nothing, so the same plan file now funds its period once.
    const funded = await dkg(b, 'fund', accountId, '--plan', 'plan-2.json');
    expect(funded.code, funded.stderr).toBe(0);
    expect(funded.stdout).toContain(`Funded period ${periodId} from account ${accountId}:`);
    expect(await ok(a, 'assignments', accountId)).toMatch(/usage: +7\.7 TRAC over 2 periods/);
  });

  it('7. revokes and advances the nonce on the owner node; the assignee node can submit an owner\'s signature', async () => {
    expect(await ok(a, 'revoke', accountId, buyer.address)).toContain(`Revoked ${buyer.address} on account ${accountId}:`);
    await writePlan('plan-3.json', '1');
    const refused = await dkg(b, 'fund', accountId, '--plan', 'plan-3.json');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('AssignmentRevoked (HTTP 409)');
    expect(await ok(a, 'advance-nonce', accountId)).toMatch(/nextNonce: +3/);

    // The owner signs the consent's terms away from the node, as a hardware wallet would.
    await ok(b, 'consent', accountId, '--max-period', '25', '--max-total', '100', '--expires', expires, '--out', 'consent-2.json');
    const consent = JSON.parse(await readFile(join(work, 'consent-2.json'), 'utf8')) as CaConsentResponse;
    const contracts = JSON.parse(await ok(b, 'contracts', '--json')) as CaContractsResponse;
    const ownerSignature = await owner.signTypedData(contracts.domain, contracts.types, consent.terms);
    const assigned = await ok(b, 'assign', accountId, '--consent', 'consent-2.json', '--owner-signature', ownerSignature);
    expect(assigned).toContain(`Assigned on account ${accountId}, sent as the assignee:`);
    // A new assignment starts its usage from zero.
    expect(await ok(a, 'assignments', accountId)).toMatch(/usage: +none/);

    // Without a consent, as for a signer that refuses typed data: the terms by hand, at the
    // nonce the storage's assignmentNonce view returns, signed by the owner.
    const css = new ethers.Contract(contracts.convictionServiceStorage, ['function assignmentNonce(uint256) view returns (uint64)'], createProvider());
    const terms = {
      accountId, assignee: buyer.address,
      maxCostPerPeriod: ethers.parseEther('25').toString(), maxInferenceCostPerPeriod: ethers.parseEther('25').toString(),
      maxQueryCostPerPeriod: '0', maxCostPerWindow: '0', maxTotalCost: ethers.parseEther('50').toString(),
      maxPeriodSeconds: 31 * DAY, expiresAt: Math.floor(Date.parse(expires) / 1000), nonce: String(await css.assignmentNonce(accountId)),
    };
    await writeFile(join(work, 'terms.json'), JSON.stringify({ terms }));
    const byHand = await ok(b, 'assign', accountId, '--consent', 'terms.json', '--owner-signature', await owner.signTypedData(contracts.domain, contracts.types, terms));
    expect(byHand).toContain('sent as the assignee:');
    expect(await ok(a, 'assignments', accountId)).toMatch(/maxTotalCost: +50\.0 TRAC/);
  });

  it('runs every step on one node that is both the owner and the assignee', async () => {
    const consent = await ok(a, 'consent', accountId, '--max-period', '5', '--max-total', '5', '--expires', expires, '--out', 'consent-a.json');
    expect(consent).toContain(`assignee:                   ${owner.address}`);
    expect(await ok(a, 'assign', accountId, '--consent', 'consent-a.json')).toContain('sent as the owner:');
    await writePlan('plan-a.json', '1');
    const funded = await ok(a, 'fund', accountId, '--plan', 'plan-a.json');
    expect(funded).toMatch(new RegExp(`assignee: +${owner.address}`));
    expect(funded).toMatch(/cost: +0\.7 TRAC/);
  });

  it('8. pauses service spending on the owner node', async () => {
    const off = await ok(a, 'services', accountId, 'disable');
    expect(off).toContain(`Service spending on account ${accountId} is off:`);
    expect(off).toContain('Assignments are kept, and funded periods run to their end.');
    const refused = await dkg(b, 'fund', accountId, '--plan', 'plan-3.json');
    expect(refused.stderr).toContain('ServiceSpendingDisabled (HTTP 409)');
    expect(await ok(a, 'assignments', accountId)).toContain(`${buyer.address}: active`);
  });
});
