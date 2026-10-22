/**
 * The `dkg ca` commands (Conviction Account service spending, OT-RFC-27)
 * against a stubbed ApiClient.ca: what each command sends, what it prints for
 * each answer (and with --json), how it renders the node's refusals, which
 * option values it refuses before connecting, and the funding's idempotency:
 * a plan's periodId is written into its file before anything is sent, and a
 * second run sends the same one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, CommanderError } from 'commander';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { ApiClient, DaemonOutcomeUnknownError } from '../src/api-client.js';
import type {
  CaAssignmentWire,
  CaCapsWire,
  CaClient,
  CaConsentResponse,
  CaFundingResponse,
  CaPeriodWire,
  CaStatusResponse,
  CaUsageWire,
} from '../src/ca-client.js';
import { registerCaCommand, caStatusPointer } from '../src/commands/ca.js';
import { registerPcaCommand } from '../src/commands/pca.js';
import {
  parseDaysOption,
  parseExpiresOption,
  parseTracOption,
  parseWholeOption,
} from '../src/ca-command-input.js';

const fsFailure = vi.hoisted(() => ({ rename: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (fsFailure.rename) throw Object.assign(new Error('EROFS: read-only file system, rename'), { code: 'EROFS' });
      return real.rename(from, to);
    },
  };
});

const OWNER = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const SS = '0x3333333333333333333333333333333333333333';
const TX = { txHash: `0x${'ab'.repeat(32)}`, blockNumber: 123 };
const DOMAIN = { name: 'DKGConvictionServices', version: '1', chainId: 31337, verifyingContract: SS } as const;
const DAY = 86_400;
const EXPIRES = '2026-11-30T00:00:00Z';
const EXPIRES_AT = Date.parse(EXPIRES) / 1000;
const PLAN_DIGEST = ethers.id('plan');
const BUCKET_ID = ethers.id('bucket inference');

const wei = (trac: string): string => ethers.parseEther(trac).toString();
const traced = (trac: string): string => ethers.formatEther(ethers.parseEther(trac));

function capsWire(period: string, total: string, window = '0', inference = period, query = '0'): CaCapsWire {
  return {
    maxCostPerPeriod: wei(period), maxCostPerPeriodTrac: traced(period),
    maxInferenceCostPerPeriod: wei(inference), maxInferenceCostPerPeriodTrac: traced(inference),
    maxQueryCostPerPeriod: wei(query), maxQueryCostPerPeriodTrac: traced(query),
    maxCostPerWindow: wei(window), maxCostPerWindowTrac: traced(window),
    maxTotalCost: wei(total), maxTotalCostTrac: traced(total),
    maxPeriodSeconds: 31 * DAY,
    expiresAt: EXPIRES_AT,
  };
}

function usageWire(total: string, periods: number): CaUsageWire {
  return { totalCost: wei(total), totalCostTrac: traced(total), windowCost: wei(total), windowCostTrac: traced(total), window: 3, periods };
}

function assignmentWire(over: Partial<CaAssignmentWire> = {}): CaAssignmentWire {
  return {
    assignee: BUYER, ...capsWire('25', '1000', '100'),
    assignedAt: 1_792_000_000, revokedAt: 0, nonce: '0', active: true, usage: usageWire('7', 1), ...over,
  };
}

function statusWire(over: Partial<CaStatusResponse> = {}): CaStatusResponse {
  return {
    accountId: '42', owner: OWNER, ownedByNode: true, buyerKey: OWNER, logicVersion: '10.1.0',
    serviceSpending: { enabled: true, enabledAt: 1_792_000_000 },
    discountBps: 3000, lockDurationEpochs: 12, expiresAtTimestamp: 1_800_000_000,
    window: {
      index: 3, baseAllowance: wei('8333'), baseAllowanceTrac: traced('8333'),
      baseRemaining: wei('8326'), baseRemainingTrac: traced('8326'), topUpBuffer: '0', topUpBufferTrac: '0.0', expired: false,
    },
    schedule: { exact: true, firstEpoch: 1201, lastEpoch: 1224 },
    labels: { total: wei('7'), totalTrac: traced('7'), cursor: 1205, remainingBaseCapacity: wei('42993'), remainingBaseCapacityTrac: traced('42993') },
    assignments: { count: 1, active: 1 },
    treasuryWired: false,
    ...over,
  };
}

function consentAnswer(nonce = '3'): CaConsentResponse {
  return {
    terms: {
      accountId: '42', assignee: BUYER,
      maxCostPerPeriod: wei('25'), maxInferenceCostPerPeriod: wei('25'), maxQueryCostPerPeriod: '0',
      maxCostPerWindow: wei('100'), maxTotalCost: wei('1000'), maxPeriodSeconds: 31 * DAY, expiresAt: EXPIRES_AT, nonce,
    },
    digest: ethers.id('digest'),
    assigneeSignature: `0x${'cd'.repeat(65)}`,
    domain: { ...DOMAIN },
  };
}

function periodWire(periodId: string, over: Partial<CaPeriodWire> = {}): CaPeriodWire {
  return {
    subscriptionId: ethers.id(`sub ${periodId}`), accountId: '42', assignee: BUYER, periodId,
    sessionKey: ethers.ZeroAddress, planDigest: PLAN_DIGEST,
    periodStart: 1_792_000_000, periodEnd: 1_792_000_000 + 30 * DAY, fundedEpoch: 1203, fundedWindow: 3, discountBps: 3000,
    value: wei('10'), valueTrac: traced('10'), cost: wei('7'), costTrac: traced('7'),
    drawnFromWindow: wei('7'), drawnFromWindowTrac: traced('7'), drawnFromTopUp: '0', drawnFromTopUpTrac: '0.0',
    buckets: [{ bucketId: BUCKET_ID, serviceClass: 'inference', value: wei('10'), valueTrac: traced('10'), maxAskWeiPerUnit: '2500000000000' }],
    ...over,
  };
}

function fundingAnswer(periodId: string, existing: boolean, over: Partial<CaPeriodWire> = {}): CaFundingResponse {
  return { ...periodWire(periodId, over), ...TX, logIndex: 7, existing };
}

/** An HTTP refusal as ApiClient throws it: the route's `error` as the message, its body as `responseBody`. */
function refusal(status: number, body: Record<string, unknown>): Error {
  return ApiClient.httpError(status, String(body.error), body);
}

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

interface Run {
  stdout: string;
  stderr: string;
  code: number | undefined;
  connected: boolean;
}

/** Run `dkg <args>` in process against `ca`, capturing stdout, stderr and the exit code. */
async function run(args: string[], ca: Partial<CaClient> = {}, extra: Record<string, unknown> = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as never);
  const connect = vi.spyOn(ApiClient, 'connect').mockResolvedValue({ ca, ...extra } as unknown as ApiClient);
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: (s) => out.push(s.trimEnd()), writeErr: (s) => err.push(s.trimEnd()) });
  registerPcaCommand(program);
  registerCaCommand(program);
  let code: number | undefined = 0;
  try {
    await program.parseAsync(['node', 'dkg', ...args]);
  } catch (e) {
    if (e instanceof Exit) code = e.code;
    else if (e instanceof CommanderError) code = e.exitCode;
    else throw e;
  }
  return { stdout: out.join('\n'), stderr: err.join('\n'), code, connected: connect.mock.calls.length > 0 };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dkg-ca-command-'));
  fsFailure.rename = false;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('option values, checked before the CLI connects', () => {
  it('takes TRAC amounts as decimal strings with at most 18 decimals, and refuses anything else', () => {
    for (const ok of ['25', '2.5', '0', '1000000', '0.000000000000000001', ' 7 ']) expect(parseTracOption(ok, '--max-period')).toBe(ok.trim());
    for (const bad of ['1e3', '-1', '+1', '1,5', '1.5.1', '.5', '5.', '', ' ', '0x10', '1.0000000000000000001', 'ten']) {
      expect(() => parseTracOption(bad, '--max-period'), bad).toThrow(/--max-period must be a decimal amount of TRAC/);
    }
    expect(() => parseTracOption(undefined, '--max-total')).toThrow(/--max-total/);
  });

  it('takes --expires only as an ISO-8601 time with a zone', () => {
    for (const ok of ['2026-11-30T00:00:00Z', '2026-11-30T01:00:00+01:00', '2026-11-29T19:00:00-05:00', '2026-11-30T00:00Z', '2026-11-30T00:00:00.500Z']) {
      expect(parseExpiresOption(ok)).toBe(ok);
    }
    for (const bad of ['2026-11-30', '2026-11-30T00:00:00', '2026-11-30 00:00:00Z', '1795996800', 'tomorrow', '2026-13-40T00:00:00Z', '2026-11-30T00:00:00+0100']) {
      expect(() => parseExpiresOption(bad), bad).toThrow(/--expires must be an ISO-8601 time with a zone/);
    }
  });

  it('takes whole days and whole numbers', () => {
    expect(parseDaysOption('31', '--max-period-days')).toBe(31 * DAY);
    expect(parseDaysOption('1', '--max-period-days')).toBe(DAY);
    for (const bad of ['0', '1.5', '-1', 'a', '49711']) expect(() => parseDaysOption(bad, '--max-period-days'), bad).toThrow(/whole number of days/);
    expect(parseWholeOption('0', '--offset')).toBe(0);
    expect(parseWholeOption('1205', '--from')).toBe(1205);
    expect(() => parseWholeOption('-1', '--offset')).toThrow(/--offset must be a whole number, 0 or more/);
    expect(() => parseWholeOption('0', '--limit', 1)).toThrow(/--limit must be a whole number from 1/);
  });

  it('refuses a bad account id, address or state without connecting', async () => {
    for (const args of [
      ['ca', 'status', 'abc'],
      ['ca', 'caps', '42', '0x1234', '--max-total', '5'],
      ['ca', 'revoke', '42', 'buyer'],
      ['ca', 'services', '42', 'maybe'],
      ['ca', 'periods', '42', '--limit', '0'],
      ['ca', 'labels', '42', '--from', 'first'],
    ]) {
      const result = await run(args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.connected).toBe(false);
      vi.restoreAllMocks();
    }
  });
});

describe('dkg ca contracts, mine and status', () => {
  it('prints the contracts and the consent domain', async () => {
    const contracts = vi.fn(async () => ({
      serviceSubscriptions: SS, convictionServiceStorage: OWNER, publishingConviction: BUYER, logicVersion: '10.1.0',
      domain: { ...DOMAIN }, primaryType: 'ServiceAssignment' as const, types: {},
    }));
    const { stdout, code } = await run(['ca', 'contracts'], { contracts });
    expect(code).toBe(0);
    expect(stdout.split('\n')).toEqual([
      'Conviction Account service contracts:',
      `  serviceSubscriptions:      ${SS}`,
      `  convictionServiceStorage:  ${OWNER}`,
      `  publishingConviction:      ${BUYER}`,
      '  logicVersion:              10.1.0',
      `  domain:                    DKGConvictionServices, version 1, chainId 31337, verifyingContract ${SS}`,
      '  primaryType:               ServiceAssignment',
    ]);
  });

  it('prints the accounts the node owns and those its buyer key is assigned on', async () => {
    const mine = vi.fn(async () => ({ owner: OWNER, buyerKey: BUYER, owned: [{ accountId: '42' }, { accountId: '43' }], assigned: [{ accountId: '44', ...assignmentWire() }] }));
    const { stdout } = await run(['ca', 'mine'], { mine });
    expect(stdout.split('\n')).toEqual([
      'This node\'s Conviction Accounts:',
      `  owner:     ${OWNER}`,
      `  buyerKey:  ${BUYER}`,
      '  owned:     42, 43',
      '  assigned:  44',
      '    account 44: active; 7.0 of 1000.0 TRAC used; expires 2026-11-30T00:00:00.000Z',
    ]);
    const none = await run(['ca', 'mine'], { mine: vi.fn(async () => ({ owner: null, buyerKey: null, owned: [], assigned: [] })) });
    expect(none.stdout).toContain('  owned:     none');
    expect(none.stdout).toContain('  buyerKey:  none (the node holds no signer for its buyer key)');
  });

  it('prints the status of an account', async () => {
    const status = vi.fn(async () => statusWire());
    const { stdout } = await run(['ca', 'status', '42'], { status });
    expect(status).toHaveBeenCalledWith('42');
    expect(stdout.split('\n')).toEqual([
      'Conviction Account 42:',
      `  owner:               ${OWNER} (this node's wallet)`,
      `  buyerKey:            ${OWNER}`,
      '  logicVersion:        10.1.0',
      `  serviceSpending:     on since ${new Date(1_792_000_000_000).toISOString()}`,
      '  discountBps:         3000 (30.00% off base cost)',
      '  lockDurationEpochs:  12',
      `  expiresAt:           ${new Date(1_800_000_000_000).toISOString()}`,
      '  window:              3: 8326.0 of 8333.0 TRAC left, topUpBuffer 0.0 TRAC',
      '  schedule:            exact, epochs 1201 to 1224',
      '  labels:              7.0 TRAC, cursor at epoch 1205, 42993.0 TRAC of base capacity left',
      '  assignments:         1 (1 active)',
      '  treasuryWired:       false',
    ]);
  });

  it('says how to switch service spending on, on the owner node, and renders an expired window and a missing buyer key', async () => {
    const off = statusWire({ serviceSpending: { enabled: false, enabledAt: 0 }, buyerKey: null, schedule: { exact: false, firstEpoch: 5, lastEpoch: 28 } });
    off.window.expired = true;
    const { stdout } = await run(['ca', 'status', '42'], { status: vi.fn(async () => off) });
    expect(stdout).toContain('  serviceSpending:     off');
    expect(stdout).toContain('  buyerKey:            none (this node holds no signer for its buyer key)');
    expect(stdout).toContain('  window:              3, expired');
    expect(stdout).toContain('  schedule:            conservative basis, epochs 5 to 28');
    expect(stdout).toContain('Switch service spending on with: dkg ca services 42 enable');
    const elsewhere = await run(['ca', 'status', '42'], { status: vi.fn(async () => ({ ...off, ownedByNode: false })) });
    expect(elsewhere.stdout).not.toContain('Switch service spending on');
    expect(elsewhere.stdout).toContain(`  owner:               ${OWNER}\n`);
  });

  it('points dkg pca info to dkg ca status when service spending is on, and stays quiet otherwise', async () => {
    const getPcaInfo = vi.fn(async () => ({
      accountId: '42', owner: OWNER, committedTRAC: wei('100000'), committedTRACTrac: '100000.0', baseEpochAllowance: '1',
      topUpBuffer: '0', topUpBufferTrac: '0.0', createdAtEpoch: 1, expiresAtEpoch: 13, createdAtTimestamp: 1, expiresAtTimestamp: 2,
      discountBps: 3000, agentCount: 0, lastSettledWindow: 0, fullySwept: false,
    }));
    const on = await run(['pca', 'info', '42'], { status: vi.fn(async () => statusWire()) }, { getPcaInfo });
    expect(on.stdout).toContain('  serviceSpending:  on (see dkg ca status 42)');
    const unavailable = await run(['pca', 'info', '42'], {
      status: vi.fn(async () => { throw refusal(503, { error: 'not available', code: 'CA_UNAVAILABLE' }); }),
    }, { getPcaInfo });
    expect(unavailable.code).toBe(0);
    expect(unavailable.stdout).not.toContain('serviceSpending');
    expect(await caStatusPointer({ ca: { status: async () => statusWire({ serviceSpending: { enabled: false, enabledAt: 0 } }) } } as unknown as ApiClient, '42')).toBeNull();
  });
});

describe('dkg ca services', () => {
  it('switches service spending on and off', async () => {
    const setServices = vi.fn(async (_id: unknown, enabled: boolean) => ({ accountId: '42', enabled, ...TX }));
    const on = await run(['ca', 'services', '42', 'enable'], { setServices });
    expect(setServices).toHaveBeenLastCalledWith('42', true);
    expect(on.stdout.split('\n')).toEqual(['Service spending on account 42 is on:', `  txHash:  ${TX.txHash}`, '  block:   123']);
    const off = await run(['ca', 'services', '42', 'off'], { setServices });
    expect(setServices).toHaveBeenLastCalledWith('42', false);
    expect(off.stdout).toContain('Service spending on account 42 is off:');
    expect(off.stdout).toContain('Assignments are kept, and funded periods run to their end.');
    await run(['ca', 'services', '42', 'DISABLE'], { setServices });
    expect(setServices).toHaveBeenLastCalledWith('42', false);
  });
});

describe('dkg ca consent', () => {
  const required = ['ca', 'consent', '42', '--max-period', '25', '--max-total', '1000', '--expires', EXPIRES];

  it('sends only the options given, and writes the consent to --out with a summary', async () => {
    const answer = consentAnswer();
    const consent = vi.fn(async () => answer);
    const file = join(dir, 'consent.json');
    const { stdout, stderr, code } = await run([...required, '--out', file], { consent });
    expect(code).toBe(0);
    expect(consent).toHaveBeenCalledWith('42', { maxCostPerPeriod: '25', maxTotalCost: '1000', expiresAt: EXPIRES });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(answer);
    expect(stderr).toBe('');
    expect(stdout.split('\n')).toEqual([
      'Consent signed by the buyer key; nothing was sent:',
      '  accountId:                  42',
      `  assignee:                   ${BUYER}`,
      '  nonce:                      3',
      '  maxCostPerPeriod:           25.0 TRAC',
      '  maxInferenceCostPerPeriod:  25.0 TRAC',
      '  maxQueryCostPerPeriod:      0.0 TRAC (no query services)',
      '  maxCostPerWindow:           100.0 TRAC',
      '  maxTotalCost:               1000.0 TRAC',
      '  maxPeriodSeconds:           2678400 (31 days)',
      '  expiresAt:                  2026-11-30T00:00:00.000Z',
      `  digest:                     ${answer.digest}`,
      `  file:                       ${file}`,
      `Next, on the owner node: dkg ca assign 42 --consent ${file}`,
    ]);
  });

  it('passes every cap option on, the days as seconds', async () => {
    const consent = vi.fn(async () => consentAnswer());
    await run([...required, '--max-inference', '20', '--max-query', '5', '--max-window', '100', '--max-period-days', '30', '--out', join(dir, 'c.json')], { consent });
    expect(consent).toHaveBeenCalledWith('42', {
      maxCostPerPeriod: '25', maxInferenceCostPerPeriod: '20', maxQueryCostPerPeriod: '5', maxCostPerWindow: '100',
      maxTotalCost: '1000', maxPeriodSeconds: 30 * DAY, expiresAt: EXPIRES,
    });
  });

  it('prints the consent as JSON without --out, with the summary on stderr', async () => {
    const answer = consentAnswer();
    const { stdout, stderr } = await run(required, { consent: vi.fn(async () => answer) });
    expect(JSON.parse(stdout)).toEqual(answer);
    expect(stderr).toContain('Next, on the owner node: dkg ca assign 42 --consent <file>');
    const json = await run([...required, '--json', '--out', join(dir, 'j.json')], { consent: vi.fn(async () => answer) });
    expect(JSON.parse(json.stdout)).toEqual(answer);
    expect(JSON.parse(await readFile(join(dir, 'j.json'), 'utf8'))).toEqual(answer);
  });

  it('refuses an --expires without a zone, a bad amount and a missing cap before connecting', async () => {
    const noZone = await run(['ca', 'consent', '42', '--max-period', '25', '--max-total', '1000', '--expires', '2026-11-30T00:00:00']);
    expect(noZone).toMatchObject({ code: 1, connected: false });
    expect(noZone.stderr).toMatch(/--expires must be an ISO-8601 time with a zone/);
    const amount = await run(['ca', 'consent', '42', '--max-period', '25 TRAC', '--max-total', '1000', '--expires', EXPIRES]);
    expect(amount).toMatchObject({ code: 1, connected: false });
    expect(amount.stderr).toMatch(/--max-period must be a decimal amount of TRAC/);
    const missing = await run(['ca', 'consent', '42', '--max-period', '25', '--expires', EXPIRES]);
    expect(missing).toMatchObject({ code: 1, connected: false });
    expect(missing.stderr).toMatch(/required option '--max-total <TRAC>' not specified/);
  });

  it('renders the node\'s refusal of the caps by the option to fix, and a signer\'s refusal with its hint', async () => {
    const terms = await run(required, { consent: vi.fn(async () => { throw refusal(400, { error: 'InvalidAssignmentTerms', accountId: '42', args: { reason: 'maxTotalCost' } }); }) });
    expect(terms.code).toBe(1);
    expect(terms.stderr.split('\n')).toEqual([
      'InvalidAssignmentTerms (HTTP 400): reason maxTotalCost',
      'The caps are refused: --max-total must be at least --max-period.',
    ]);
    const signer = await run(required, {
      consent: vi.fn(async () => { throw refusal(502, { error: 'typed data domain not allowed', code: 'REMOTE_SIGNER_REJECTED', accountId: '42', hint: 'Allow that EIP-712 domain.' }); }),
    });
    expect(signer.stderr.split('\n')).toEqual([
      'typed data domain not allowed (HTTP 502, REMOTE_SIGNER_REJECTED)',
      'Hint: Allow that EIP-712 domain.',
    ]);
  });
});

describe('dkg ca assign', () => {
  async function consentFile(content: unknown = consentAnswer()): Promise<string> {
    const file = join(dir, 'consent.json');
    await writeFile(file, JSON.stringify(content));
    return file;
  }
  const assigned = { accountId: '42', assignee: BUYER, digest: ethers.id('digest'), ...TX };

  it('posts the consent file unchanged on the owner node', async () => {
    const assign = vi.fn(async () => ({ ...assigned, sentAs: 'owner' as const }));
    const { stdout } = await run(['ca', 'assign', '42', '--consent', await consentFile()], { assign });
    expect(assign).toHaveBeenCalledWith('42', consentAnswer());
    expect(stdout.split('\n')).toEqual([
      'Assigned on account 42, sent as the owner:',
      `  assignee:  ${BUYER}`,
      `  digest:    ${assigned.digest}`,
      `  txHash:    ${TX.txHash}`,
      '  block:     123',
    ]);
  });

  it('adds the owner\'s signature on the assignee node, also to a file of bare terms', async () => {
    const assign = vi.fn(async () => ({ ...assigned, sentAs: 'assignee' as const }));
    const signature = `0x${'ef'.repeat(65)}`;
    const { stdout } = await run(['ca', 'assign', '42', '--consent', await consentFile(), '--owner-signature', signature], { assign });
    expect(assign).toHaveBeenCalledWith('42', { ...consentAnswer(), ownerSignature: signature });
    expect(stdout).toContain('sent as the assignee');
    const { terms } = consentAnswer();
    await run(['ca', 'assign', '42', '--consent', await consentFile({ terms }), '--owner-signature', signature], { assign });
    expect(assign).toHaveBeenLastCalledWith('42', { terms, ownerSignature: signature });
  });

  it('refuses a bad signature, a missing file and a file without terms before connecting', async () => {
    const badSignature = await run(['ca', 'assign', '42', '--consent', await consentFile(), '--owner-signature', '0xabc']);
    expect(badSignature).toMatchObject({ code: 1, connected: false });
    expect(badSignature.stderr).toMatch(/--owner-signature must be 0x-prefixed hex bytes/);
    const missing = await run(['ca', 'assign', '42', '--consent', join(dir, 'none.json')]);
    expect(missing.stderr).toMatch(/Cannot read the consent file/);
    await writeFile(join(dir, 'bad.json'), '{"terms": ');
    expect((await run(['ca', 'assign', '42', '--consent', join(dir, 'bad.json')])).stderr).toMatch(/is not valid JSON/);
    await writeFile(join(dir, 'list.json'), '[]');
    expect((await run(['ca', 'assign', '42', '--consent', join(dir, 'list.json')])).stderr).toMatch(/must hold a JSON object/);
    const noTerms = await run(['ca', 'assign', '42', '--consent', await consentFile({ digest: '0x' })]);
    expect(noTerms).toMatchObject({ code: 1, connected: false });
    expect(noTerms.stderr).toMatch(/has no terms: use the file that dkg ca consent wrote/);
  });

  it('says who the node is when it is neither owner nor assignee, and what a moved nonce means', async () => {
    const neither = await run(['ca', 'assign', '42', '--consent', await consentFile()], {
      assign: vi.fn(async () => {
        throw refusal(403, { error: 'This node is neither the owner of the account nor its assignee', accountId: '42', owner: OWNER, nodeWallet: SS, buyerKey: SS, assignee: BUYER });
      }),
    });
    expect(neither.stderr.split('\n')).toEqual([
      'This node is neither the owner of the account nor its assignee (HTTP 403)',
      `  owner: ${OWNER}`,
      `  nodeWallet: ${SS}`,
      `  buyerKey: ${SS}`,
      `  assignee: ${BUYER}`,
    ]);
    const nonce = await run(['ca', 'assign', '42', '--consent', await consentFile()], {
      assign: vi.fn(async () => { throw refusal(409, { error: 'InvalidAssignmentNonce', accountId: '42', args: { accountId: '42', expected: '4', provided: '3' } }); }),
    });
    expect(nonce.stderr.split('\n')).toEqual([
      'InvalidAssignmentNonce (HTTP 409): accountId 42, expected 4, provided 3',
      'The account\'s assignment nonce moved after the terms were signed: sign a new consent on the assignee node.',
    ]);
  });

  it('says how to check, and that a repeat is safe, when the answer never came', async () => {
    const lost = new DaemonOutcomeUnknownError('POST', '/api/ca/42/assignments', 240_000, 'Check GET /api/ca/42/assignments before retrying.');
    const { stderr, code } = await run(['ca', 'assign', '42', '--consent', await consentFile()], { assign: vi.fn(async () => { throw lost; }) });
    expect(code).toBe(1);
    expect(stderr).toContain('Outcome unknown: the daemon did not answer POST /api/ca/42/assignments within 240s.');
    expect(stderr).toContain('Check dkg ca assignments 42 to see whether it landed. Running the same command again is safe');
  });
});

describe('dkg ca assignments, caps, revoke and advance-nonce', () => {
  it('lists assignments with their caps, state and usage', async () => {
    const assignments = vi.fn(async () => ({
      accountId: '42',
      assignments: [
        assignmentWire(),
        assignmentWire({ assignee: OWNER, revokedAt: 1_792_500_000, active: false, nonce: '1', usage: usageWire('0', 0) }),
        assignmentWire({ assignee: SS, active: false, nonce: '2' }),
      ],
    }));
    const { stdout } = await run(['ca', 'assignments', '42'], { assignments });
    const lines = stdout.split('\n');
    expect(lines.slice(0, 11)).toEqual([
      'Assignments on account 42: 3',
      `  ${BUYER}: active`,
      '    maxCostPerPeriod:           25.0 TRAC',
      '    maxInferenceCostPerPeriod:  25.0 TRAC',
      '    maxQueryCostPerPeriod:      0.0 TRAC (no query services)',
      '    maxCostPerWindow:           100.0 TRAC',
      '    maxTotalCost:               1000.0 TRAC',
      '    maxPeriodSeconds:           2678400 (31 days)',
      '    expiresAt:                  2026-11-30T00:00:00.000Z',
      `    assignedAt:                 ${new Date(1_792_000_000_000).toISOString()} (nonce 0)`,
      '    usage:                      7.0 TRAC over 1 period; 7.0 TRAC in window 3',
    ]);
    expect(stdout).toContain(`  ${OWNER}: revoked at ${new Date(1_792_500_000_000).toISOString()}`);
    expect(stdout).toContain('    usage:                      none');
    expect(stdout).toContain(`  ${SS}: expired at 2026-11-30T00:00:00.000Z`);
    expect((await run(['ca', 'assignments', '42'], { assignments: vi.fn(async () => ({ accountId: '42', assignments: [] })) })).stdout).toBe('No assignments on account 42.');
  });

  it('sends only the caps given, and prints the merged caps and the kept usage', async () => {
    const updateCaps = vi.fn(async () => ({ accountId: '42', assignee: BUYER, unchanged: false, caps: capsWire('25', '1500', '50'), usage: usageWire('7', 1), ...TX }));
    const { stdout } = await run(['ca', 'caps', '42', BUYER, '--max-window', '50', '--max-total', '1500'], { updateCaps });
    expect(updateCaps).toHaveBeenCalledWith('42', BUYER, { maxCostPerWindow: '50', maxTotalCost: '1500' });
    expect(stdout.split('\n')).toEqual([
      `The caps of ${BUYER} on account 42 are updated:`,
      '  maxCostPerPeriod:           25.0 TRAC',
      '  maxInferenceCostPerPeriod:  25.0 TRAC',
      '  maxQueryCostPerPeriod:      0.0 TRAC (no query services)',
      '  maxCostPerWindow:           50.0 TRAC',
      '  maxTotalCost:               1500.0 TRAC',
      '  maxPeriodSeconds:           2678400 (31 days)',
      '  expiresAt:                  2026-11-30T00:00:00.000Z',
      '  usage:                      7.0 TRAC over 1 period; 7.0 TRAC in window 3',
      `  txHash:                     ${TX.txHash}`,
      '  block:                      123',
    ]);
    await run(['ca', 'caps', '42', BUYER, '--max-period-days', '7', '--expires', '2026-12-01T00:00:00+01:00', '--max-query', '0', '--max-inference', '5', '--max-period', '5'], { updateCaps });
    expect(updateCaps).toHaveBeenLastCalledWith('42', BUYER, {
      maxCostPerPeriod: '5', maxInferenceCostPerPeriod: '5', maxQueryCostPerPeriod: '0', maxPeriodSeconds: 7 * DAY, expiresAt: '2026-12-01T00:00:00+01:00',
    });
  });

  it('says when nothing was sent, and when the total cap is below the usage', async () => {
    const unchanged = vi.fn(async () => ({ accountId: '42', assignee: BUYER, unchanged: true, caps: capsWire('5', '5', '100'), usage: usageWire('7', 1) }));
    const { stdout } = await run(['ca', 'caps', '42', BUYER, '--max-total', '5'], { updateCaps: unchanged });
    expect(stdout).toContain(`The caps of ${BUYER} on account 42 are unchanged; nothing was sent:`);
    expect(stdout).not.toContain('txHash');
    expect(stdout).toContain('maxTotalCost is below the usage, so every funding is refused until it is raised.');
  });

  it('refuses a caps command without any cap before connecting', async () => {
    const none = await run(['ca', 'caps', '42', BUYER]);
    expect(none).toMatchObject({ code: 1, connected: false });
    expect(none.stderr).toMatch(/Give at least one of --max-period/);
  });

  it('revokes and advances the nonce', async () => {
    const revoke = vi.fn(async () => ({ accountId: '42', assignee: BUYER, revoked: true as const, nextNonce: '2', ...TX }));
    const revoked = await run(['ca', 'revoke', '42', BUYER], { revoke });
    expect(revoke).toHaveBeenCalledWith('42', BUYER);
    expect(revoked.stdout.split('\n')).toEqual([
      `Revoked ${BUYER} on account 42:`,
      '  nextNonce:  2',
      `  txHash:     ${TX.txHash}`,
      '  block:      123',
      'Funded periods run to their end; new fundings are refused.',
    ]);
    const advanceNonce = vi.fn(async () => ({ accountId: '42', nextNonce: '3', ...TX }));
    const advanced = await run(['ca', 'advance-nonce', '42'], { advanceNonce });
    expect(advanced.stdout).toContain('The assignment nonce of account 42 is advanced:');
    expect(advanced.stdout).toContain('  nextNonce:  3');
    expect(advanced.stdout).toContain('Terms signed at an earlier nonce no longer assign.');
  });

  it('renders the owner refusal and an unknown account', async () => {
    const owner = await run(['ca', 'revoke', '42', BUYER], {
      revoke: vi.fn(async () => { throw refusal(403, { error: 'NotAccountOwner', accountId: '42', args: { accountId: '42', caller: SS } }); }),
    });
    expect(owner.stderr.split('\n')).toEqual([
      `NotAccountOwner (HTTP 403): accountId 42, caller ${SS}`,
      'Run the owner\'s commands on the node whose primary wallet owns the account (dkg ca status shows the owner).',
    ]);
    const unknown = await run(['ca', 'status', '9'], { status: vi.fn(async () => { throw refusal(404, { error: 'UnknownAccount', accountId: '9', args: {} }); }) });
    expect(unknown.stderr).toBe('UnknownAccount (HTTP 404)\nThere is no such account on this chain.');
  });
});

describe('dkg ca labels and periods', () => {
  it('prints the labels as a table in TRAC, and passes the epoch range', async () => {
    const labels = vi.fn(async () => ({
      accountId: '42', cursor: 1205, from: 1201, to: 1202,
      epochs: [
        { epoch: 1201, scheduled: wei('4166.5'), scheduledTrac: '4166.5', baseLabel: wei('7'), baseLabelTrac: '7.0', topUpLabel: '0', topUpLabelTrac: '0.0', serviceLabel: wei('7'), serviceLabelTrac: '7.0', pool: wei('50000'), poolTrac: '50000.0' },
        { epoch: 1202, scheduled: wei('4166.5'), scheduledTrac: '4166.5', baseLabel: '0', baseLabelTrac: '0.0', topUpLabel: '0', topUpLabelTrac: '0.0', serviceLabel: '0', serviceLabelTrac: '0.0', pool: '0', poolTrac: '0.0' },
      ],
    }));
    const { stdout } = await run(['ca', 'labels', '42', '--from', '1201', '--to', '1202'], { labels });
    expect(labels).toHaveBeenCalledWith('42', { from: 1201, to: 1202 });
    expect(stdout.split('\n')).toEqual([
      'Labels of account 42, epochs 1201 to 1202 (cursor at epoch 1205), in TRAC:',
      '  epoch  scheduled  baseLabel  topUpLabel  serviceLabel  pool',
      '  1201   4166.5     7.0        0.0         7.0           50000.0',
      '  1202   4166.5     0.0        0.0         0.0           0.0',
    ]);
    await run(['ca', 'labels', '42'], { labels });
    expect(labels).toHaveBeenLastCalledWith('42', {});
  });

  it('prints the funded periods with their buckets, and passes the page', async () => {
    const id = ethers.id('period one');
    const periods = vi.fn(async () => ({ accountId: '42', total: 3, offset: 0, limit: 1, periods: [periodWire(id)] }));
    const { stdout } = await run(['ca', 'periods', '42', '--offset', '0', '--limit', '1'], { periods });
    expect(periods).toHaveBeenCalledWith('42', { offset: 0, limit: 1 });
    expect(stdout.split('\n')).toEqual([
      'Periods funded from account 42: 3 (showing 1 to 1)',
      `  periodId ${id}:`,
      `    subscriptionId:   ${ethers.id(`sub ${id}`)}`,
      `    assignee:         ${BUYER}`,
      '    value:            10.0 TRAC',
      '    cost:             7.0 TRAC (30.00% off)',
      '    drawnFromWindow:  7.0 TRAC (window 3)',
      '    drawnFromTopUp:   0.0 TRAC',
      `    period:           ${new Date(1_792_000_000_000).toISOString()} to ${new Date((1_792_000_000 + 30 * DAY) * 1000).toISOString()}`,
      '    fundedEpoch:      1203',
      `    sessionKey:       ${ethers.ZeroAddress}`,
      `    planDigest:       ${PLAN_DIGEST}`,
      '    buckets:          1',
      `      ${BUCKET_ID}  inference  10.0 TRAC  maxAskWeiPerUnit 2500000000000`,
    ]);
    expect((await run(['ca', 'periods', '42'], { periods: vi.fn(async () => ({ accountId: '42', total: 0, offset: 0, limit: 50, periods: [] })) })).stdout)
      .toBe('No periods funded from account 42.');
    expect((await run(['ca', 'periods', '42', '--offset', '5'], { periods: vi.fn(async () => ({ accountId: '42', total: 3, offset: 5, limit: 50, periods: [] })) })).stdout)
      .toBe('No periods from offset 5; account 42 has 3.');
  });
});

describe('dkg ca fund: the periodId is written before anything is sent, and a repeat reuses it', () => {
  const body = { periodSeconds: 30 * DAY, planDigest: PLAN_DIGEST, buckets: [{ bucketId: BUCKET_ID, serviceClass: 'inference', value: '10', maxAskWeiPerUnit: '2500000000000' }] };

  async function planFile(content: Record<string, unknown> = body): Promise<string> {
    const file = join(dir, 'plan.json');
    await writeFile(file, `${JSON.stringify(content, null, 2)}\n`);
    return file;
  }

  it('writes a new periodId into the plan file before posting, and a second run sends the same one', async () => {
    const file = await planFile();
    const sent: string[] = [];
    const fund = vi.fn(async (_id: unknown, plan: { periodId?: string }) => {
      // The id is in the file before the request leaves.
      expect(JSON.parse(await readFile(file, 'utf8')).periodId).toBe(plan.periodId);
      sent.push(plan.periodId!);
      return fundingAnswer(plan.periodId!, sent.length > 1);
    });
    const first = await run(['ca', 'fund', '42', '--plan', file], { fund });
    expect(first.code).toBe(0);
    const periodId = sent[0]!;
    expect(periodId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.stderr).toBe(`periodId ${periodId} is written to ${file}: running this command again repeats this period, and never funds a second one.`);
    expect(first.stdout.split('\n')).toEqual([
      `Funded period ${periodId} from account 42:`,
      `  subscriptionId:   ${ethers.id(`sub ${periodId}`)}`,
      `  txHash:           ${TX.txHash}`,
      '  block:            123',
      '  logIndex:         7',
      `  assignee:         ${BUYER}`,
      '  value:            10.0 TRAC',
      '  cost:             7.0 TRAC (30.00% off)',
      '  drawnFromWindow:  7.0 TRAC (window 3)',
      '  drawnFromTopUp:   0.0 TRAC',
      `  period:           ${new Date(1_792_000_000_000).toISOString()} to ${new Date((1_792_000_000 + 30 * DAY) * 1000).toISOString()}`,
      '  fundedEpoch:      1203',
      `  sessionKey:       ${ethers.ZeroAddress}`,
      `  planDigest:       ${PLAN_DIGEST}`,
      '  buckets:          1',
      `    ${BUCKET_ID}  inference  10.0 TRAC  maxAskWeiPerUnit 2500000000000`,
    ]);
    const written = await readFile(file, 'utf8');
    expect(JSON.parse(written)).toEqual({ periodId, ...body });
    expect(Object.keys(JSON.parse(written))[0]).toBe('periodId');
    expect(fund).toHaveBeenCalledWith('42', { periodId, ...body });

    const second = await run(['ca', 'fund', '42', '--plan', file], { fund });
    expect(sent).toEqual([periodId, periodId]);
    expect(second.stderr).toBe(`Funding period ${periodId}, the periodId of ${file}.`);
    expect(second.stdout.split('\n')[0]).toBe(`Period ${periodId} was already funded from account 42; nothing was sent:`);
    expect(await readFile(file, 'utf8')).toBe(written);
  });

  it('keeps a plan\'s own periodId, and notices a plan that changed under a funded one', async () => {
    const periodId = ethers.id('chosen period');
    const file = await planFile({ periodId, ...body, planDigest: ethers.id('another plan') });
    const before = await readFile(file, 'utf8');
    const fund = vi.fn(async () => fundingAnswer(periodId, true));
    const { stdout } = await run(['ca', 'fund', '42', '--plan', file], { fund });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(fund).toHaveBeenCalledWith('42', { periodId, ...body, planDigest: ethers.id('another plan') });
    expect(stdout).toContain('The plan file\'s planDigest differs from the funded period\'s. To fund a new period, remove periodId from the plan file.');
  });

  it('sends nothing when the periodId cannot be written into the plan file', async () => {
    const file = await planFile();
    fsFailure.rename = true;
    const fund = vi.fn();
    const { stderr, code, connected } = await run(['ca', 'fund', '42', '--plan', file], { fund });
    expect(code).toBe(1);
    expect(connected).toBe(false);
    expect(fund).not.toHaveBeenCalled();
    expect(stderr).toMatch(/^Cannot write a periodId into the plan file .*plan\.json \(EROFS: read-only file system, rename\), so nothing was sent\./);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(body);
    expect(await readdir(dir)).toEqual(['plan.json']);
  });

  it('refuses a malformed periodId and a missing plan file before connecting', async () => {
    const bad = await run(['ca', 'fund', '42', '--plan', await planFile({ periodId: '0x1234', ...body })]);
    expect(bad).toMatchObject({ code: 1, connected: false });
    expect(bad.stderr).toMatch(/periodId in the plan file .* must be 32 bytes of 0x-prefixed hex/);
    expect((await run(['ca', 'fund', '42', '--plan', join(dir, 'missing.json')])).stderr).toMatch(/Cannot read the plan file/);
  });

  it('names the periodId and the safe retry when the answer never came', async () => {
    const file = await planFile();
    const fund = vi.fn(async (_id: unknown, plan: { periodId?: string }) => {
      throw new DaemonOutcomeUnknownError('POST', '/api/ca/42/periods', 240_000,
        `The period may have been funded: repeat with periodId ${plan.periodId}, which answers it without funding it again.`);
    });
    const { stderr, code } = await run(['ca', 'fund', '42', '--plan', file], { fund });
    expect(code).toBe(1);
    const { periodId } = JSON.parse(await readFile(file, 'utf8')) as { periodId: string };
    const lines = stderr.split('\n');
    expect(lines[1]).toMatch(/^Outcome unknown: the daemon did not answer POST \/api\/ca\/42\/periods within 240s\./);
    expect(lines[1]).toContain(`repeat with periodId ${periodId}`);
    expect(lines.slice(2)).toEqual([
      `The period's periodId ${periodId} is in ${file}. Run the same command again: dkg ca fund 42 --plan ${file}`,
      'If the period was funded, it is answered as already funded and nothing is sent; if not, it is funded once.',
    ]);
  });

  it('renders the funding refusals: a cap in TRAC, the plan\'s fault, the allowance', async () => {
    const file = await planFile({ periodId: ethers.id('p'), ...body });
    const cap = await run(['ca', 'fund', '42', '--plan', file], {
      fund: vi.fn(async () => { throw refusal(409, { error: 'CapExceeded', accountId: '42', args: { cap: 'maxTotalCost', limit: wei('5'), attempted: wei('7.7') } }); }),
    });
    expect(cap.stderr.split('\n').slice(1)).toEqual([
      'CapExceeded (HTTP 409): cap maxTotalCost, limit 5.0 TRAC, attempted 7.7 TRAC',
      'The cost, after the discount, is above that cap of the assignment; nothing was funded. The owner can change the caps with dkg ca caps.',
    ]);
    const plan = await run(['ca', 'fund', '42', '--plan', file], {
      fund: vi.fn(async () => { throw refusal(400, { error: 'InvalidFundingRequest', accountId: '42', args: { reason: 'bucketOrder' } }); }),
    });
    expect(plan.stderr.split('\n').slice(1)).toEqual([
      'InvalidFundingRequest (HTTP 400): reason bucketOrder',
      'The plan is refused: the plan\'s bucketIds must be strictly increasing.',
    ]);
    const allowance = await run(['ca', 'fund', '42', '--plan', file], {
      fund: vi.fn(async () => { throw refusal(409, { error: 'InsufficientAllowance', accountId: '42', args: { accountId: '42', epoch: '1203', required: wei('100'), available: wei('3') } }); }),
    });
    expect(allowance.stderr.split('\n')[1]).toBe('InsufficientAllowance (HTTP 409): accountId 42, epoch 1203, required 100.0 TRAC, available 3.0 TRAC');
  });
});

describe('errors that are not a contract refusal', () => {
  it('renders an unavailable chain, a missing buyer key, a timeout, an older node and a daemon that is not running', async () => {
    const unavailable = await run(['ca', 'contracts'], {
      contracts: vi.fn(async () => { throw refusal(503, { error: 'Conviction Account service spending is not available on this node', code: 'CA_UNAVAILABLE' }); }),
    });
    expect(unavailable.stderr).toBe('Conviction Account service spending is not available on this node (HTTP 503, CA_UNAVAILABLE)');
    const noBuyerKey = await run(['ca', 'consent', '42', '--max-period', '25', '--max-total', '1000', '--expires', EXPIRES], {
      consent: vi.fn(async () => { throw refusal(503, { error: 'This node holds no signer for its Conviction Account buyer key', code: 'CA_BUYER_KEY_UNAVAILABLE' }); }),
    });
    expect(noBuyerKey).toMatchObject({ code: 1, stderr: 'This node holds no signer for its Conviction Account buyer key (HTTP 503, CA_BUYER_KEY_UNAVAILABLE)' });
    const timeout = await run(['ca', 'services', '42', 'enable'], {
      setServices: vi.fn(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }),
    });
    expect(timeout.stderr.split('\n')).toEqual([
      'The operation was aborted due to timeout: the node did not answer in time, and may still complete the request.',
      'Check the account (dkg ca status, dkg ca assignments) before running the command again.',
    ]);
    const older = await run(['ca', 'mine'], { mine: vi.fn(async () => { throw refusal(404, { error: 'Not found' }); }) });
    expect(older.stderr).toBe('Not found (HTTP 404)\nThe node may run a version without Conviction Account service spending (/api/ca).');
    const down = await run(['ca', 'mine'], { mine: vi.fn(async () => { throw new Error('Daemon is not running. Start it with: dkg start'); }) });
    expect(down).toMatchObject({ code: 1, stderr: 'Daemon is not running. Start it with: dkg start' });
    const odd = await run(['ca', 'mine'], { mine: vi.fn(async () => { throw 'a string'; }) });
    expect(odd.stderr).toBe('a string');
    const bare = await run(['ca', 'mine'], { mine: vi.fn(async () => { throw ApiClient.httpError(500, 'getConvictionServiceStatus failed: boom'); }) });
    expect(bare.stderr).toBe('getConvictionServiceStatus failed: boom (HTTP 500)');
  });
});

describe('--json prints each answer as it came', () => {
  const cases: Array<[string[], keyof CaClient, unknown]> = [
    [['ca', 'contracts'], 'contracts', { serviceSubscriptions: SS, domain: DOMAIN, primaryType: 'ServiceAssignment', types: {} }],
    [['ca', 'mine'], 'mine', { owner: OWNER, buyerKey: BUYER, owned: [], assigned: [] }],
    [['ca', 'status', '42'], 'status', statusWire()],
    [['ca', 'services', '42', 'enable'], 'setServices', { accountId: '42', enabled: true, ...TX }],
    [['ca', 'assignments', '42'], 'assignments', { accountId: '42', assignments: [assignmentWire()] }],
    [['ca', 'caps', '42', BUYER, '--max-total', '5'], 'updateCaps', { accountId: '42', assignee: BUYER, unchanged: true, caps: capsWire('5', '5'), usage: usageWire('0', 0) }],
    [['ca', 'revoke', '42', BUYER], 'revoke', { accountId: '42', assignee: BUYER, revoked: true, nextNonce: '2', ...TX }],
    [['ca', 'advance-nonce', '42'], 'advanceNonce', { accountId: '42', nextNonce: '3', ...TX }],
    [['ca', 'labels', '42'], 'labels', { accountId: '42', cursor: 1, from: 1, to: 1, epochs: [] }],
    [['ca', 'periods', '42'], 'periods', { accountId: '42', total: 0, offset: 0, limit: 50, periods: [] }],
  ];

  it.each(cases)('%j', async (args, method, answer) => {
    const { stdout, code } = await run([...args, '--json'], { [method]: vi.fn(async () => answer) });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(answer);
  });

  it('keeps stdout one JSON document for dkg ca fund and assign', async () => {
    const plan = join(dir, 'plan.json');
    await writeFile(plan, JSON.stringify({ periodSeconds: DAY, planDigest: PLAN_DIGEST, buckets: [] }));
    const fund = vi.fn(async (_id: unknown, p: { periodId?: string }) => fundingAnswer(p.periodId!, false));
    const funded = await run(['ca', 'fund', '42', '--plan', plan, '--json'], { fund });
    expect(JSON.parse(funded.stdout)).toMatchObject({ existing: false, logIndex: 7 });
    expect(funded.stderr).toMatch(/^periodId 0x[0-9a-f]{64} is written to/);
    const consent = join(dir, 'consent.json');
    await writeFile(consent, JSON.stringify(consentAnswer()));
    const answer = { accountId: '42', assignee: BUYER, digest: ethers.id('digest'), sentAs: 'owner' as const, ...TX };
    expect(JSON.parse((await run(['ca', 'assign', '42', '--consent', consent, '--json'], { assign: vi.fn(async () => answer) })).stdout)).toEqual(answer);
  });
});
