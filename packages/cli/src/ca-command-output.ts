// SPDX-License-Identifier: Apache-2.0

/**
 * The output side of the `dkg ca` commands (Conviction Account service
 * spending, OT-RFC-27): the lines each command prints for an answer of
 * `ApiClient.ca`, and for an error. Amounts print in TRAC from the answers'
 * `…Trac` siblings, times as ISO-8601 in UTC.
 */
import { ethers } from 'ethers';
import type {
  CaAssignResponse,
  CaAssignmentWire,
  CaCapsResponse,
  CaCapsWire,
  CaConsentResponse,
  CaContractsResponse,
  CaFundingResponse,
  CaLabelWire,
  CaMineResponse,
  CaPeriodWire,
  CaStatusResponse,
  CaTxWire,
  CaUsageWire,
} from './ca-client.js';

const DAY_SECONDS = 86_400;

type Row = readonly [label: string, value: string];

/** `label: value` rows, the values aligned two spaces after the longest label, as `dkg pca info` aligns them. */
function rows(entries: readonly Row[], indent = '  '): string[] {
  const width = Math.max(...entries.map(([label]) => label.length)) + 3;
  return entries.map(([label, value]) => `${indent}${`${label}:`.padEnd(width)}${value}`);
}

function time(seconds: number): string {
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : 'never';
}

function duration(seconds: number): string {
  if (seconds % DAY_SECONDS !== 0) return `${seconds} s`;
  const days = seconds / DAY_SECONDS;
  return `${seconds} (${days} day${days === 1 ? '' : 's'})`;
}

function discount(bps: number): string {
  return `${bps} (${(bps / 100).toFixed(2)}% off base cost)`;
}

function weiAsTrac(wei: string): string {
  return `${ethers.formatEther(BigInt(wei))} TRAC`;
}

function txRows(tx: Partial<CaTxWire>): Row[] {
  return tx.txHash === undefined ? [] : [['txHash', tx.txHash], ['block', String(tx.blockNumber)]];
}

function capsRows(c: CaCapsWire): Row[] {
  return [
    ['maxCostPerPeriod', `${c.maxCostPerPeriodTrac} TRAC`],
    ['maxInferenceCostPerPeriod', `${c.maxInferenceCostPerPeriodTrac} TRAC`],
    ['maxQueryCostPerPeriod', `${c.maxQueryCostPerPeriodTrac} TRAC${c.maxQueryCostPerPeriod === '0' ? ' (no query services)' : ''}`],
    ['maxCostPerWindow', `${c.maxCostPerWindowTrac} TRAC${c.maxCostPerWindow === '0' ? ' (no window cap)' : ''}`],
    ['maxTotalCost', `${c.maxTotalCostTrac} TRAC`],
    ['maxPeriodSeconds', duration(c.maxPeriodSeconds)],
    ['expiresAt', time(c.expiresAt)],
  ];
}

function usage(u: CaUsageWire): string {
  if (u.periods === 0) return 'none';
  return `${u.totalCostTrac} TRAC over ${u.periods} period${u.periods === 1 ? '' : 's'}; ${u.windowCostTrac} TRAC in window ${u.window}`;
}

function assignmentState(a: Pick<CaAssignmentWire, 'active' | 'revokedAt' | 'expiresAt'>): string {
  if (a.revokedAt !== 0) return `revoked at ${time(a.revokedAt)}`;
  return a.active ? 'active' : `expired at ${time(a.expiresAt)}`;
}

export function contractsLines(c: CaContractsResponse): string[] {
  return [
    'Conviction Account service contracts:',
    ...rows([
      ['serviceSubscriptions', c.serviceSubscriptions],
      ['convictionServiceStorage', c.convictionServiceStorage],
      ['publishingConviction', c.publishingConviction],
      ['logicVersion', c.logicVersion],
      ['domain', `${c.domain.name}, version ${c.domain.version}, chainId ${c.domain.chainId}, verifyingContract ${c.domain.verifyingContract}`],
      ['primaryType', c.primaryType],
    ]),
  ];
}

export function mineLines(m: CaMineResponse): string[] {
  const lines = [
    'This node\'s Conviction Accounts:',
    ...rows([
      ['owner', m.owner ?? 'none (the node has no operational wallet)'],
      ['buyerKey', m.buyerKey ?? 'none (the node holds no signer for its buyer key)'],
      ['owned', m.owned.length === 0 ? 'none' : m.owned.map((a) => a.accountId).join(', ')],
      ['assigned', m.assigned.length === 0 ? 'none' : m.assigned.map((a) => a.accountId).join(', ')],
    ]),
  ];
  for (const a of m.assigned) {
    lines.push(`    account ${a.accountId}: ${assignmentState(a)}; ${a.usage.totalCostTrac} of ${a.maxTotalCostTrac} TRAC used; expires ${time(a.expiresAt)}`);
  }
  return lines;
}

export function statusLines(s: CaStatusResponse): string[] {
  const w = s.window;
  const lines = [
    `Conviction Account ${s.accountId}:`,
    ...rows([
      ['owner', `${s.owner}${s.ownedByNode ? ' (this node\'s wallet)' : ''}`],
      ['buyerKey', s.buyerKey ?? 'none (this node holds no signer for its buyer key)'],
      ['logicVersion', s.logicVersion],
      ['serviceSpending', s.serviceSpending.enabled ? `on since ${time(s.serviceSpending.enabledAt)}` : 'off'],
      ['discountBps', discount(s.discountBps)],
      ['lockDurationEpochs', String(s.lockDurationEpochs)],
      ['expiresAt', time(s.expiresAtTimestamp)],
      ['window', w.expired
        ? `${w.index}, expired`
        : `${w.index}: ${w.baseRemainingTrac} of ${w.baseAllowanceTrac} TRAC left, topUpBuffer ${w.topUpBufferTrac} TRAC`],
      ['schedule', `${s.schedule.exact ? 'exact' : 'conservative basis'}, epochs ${s.schedule.firstEpoch} to ${s.schedule.lastEpoch}`],
      ['labels', `${s.labels.totalTrac} TRAC, cursor at epoch ${s.labels.cursor}, ${s.labels.remainingBaseCapacityTrac} TRAC of base capacity left`],
      ['assignments', `${s.assignments.count} (${s.assignments.active} active)`],
      ['treasuryWired', String(s.treasuryWired)],
    ]),
  ];
  if (s.ownedByNode && !s.serviceSpending.enabled) lines.push(`Switch service spending on with: dkg ca services ${s.accountId} enable`);
  return lines;
}

export function servicesLines(r: { accountId: string; enabled: boolean } & CaTxWire): string[] {
  return [
    `Service spending on account ${r.accountId} is ${r.enabled ? 'on' : 'off'}:`,
    ...rows(txRows(r)),
    ...(r.enabled ? [] : ['Assignments are kept, and funded periods run to their end.']),
  ];
}

/** A consent's summary; `file` is where it was written, if anywhere. */
export function consentLines(c: CaConsentResponse, file?: string): string[] {
  const t = c.terms;
  return [
    'Consent signed by the buyer key; nothing was sent:',
    ...rows([
      ['accountId', t.accountId],
      ['assignee', t.assignee],
      ['nonce', t.nonce],
      ['maxCostPerPeriod', weiAsTrac(t.maxCostPerPeriod)],
      ['maxInferenceCostPerPeriod', weiAsTrac(t.maxInferenceCostPerPeriod)],
      ['maxQueryCostPerPeriod', `${weiAsTrac(t.maxQueryCostPerPeriod)}${t.maxQueryCostPerPeriod === '0' ? ' (no query services)' : ''}`],
      ['maxCostPerWindow', `${weiAsTrac(t.maxCostPerWindow)}${t.maxCostPerWindow === '0' ? ' (no window cap)' : ''}`],
      ['maxTotalCost', weiAsTrac(t.maxTotalCost)],
      ['maxPeriodSeconds', duration(t.maxPeriodSeconds)],
      ['expiresAt', time(t.expiresAt)],
      ['digest', c.digest],
      ...(file === undefined ? [] : [['file', file] as const]),
    ]),
    `Next, on the owner node: dkg ca assign ${t.accountId} --consent ${file ?? '<file>'}`,
  ];
}

export function assignLines(r: CaAssignResponse): string[] {
  return [
    `Assigned on account ${r.accountId}, sent as the ${r.sentAs}:`,
    ...rows([['assignee', r.assignee], ['digest', r.digest], ...txRows(r)]),
  ];
}

export function assignmentsLines(r: { accountId: string; assignments: CaAssignmentWire[] }): string[] {
  if (r.assignments.length === 0) return [`No assignments on account ${r.accountId}.`];
  const lines = [`Assignments on account ${r.accountId}: ${r.assignments.length}`];
  for (const a of r.assignments) {
    lines.push(`  ${a.assignee}: ${assignmentState(a)}`);
    lines.push(...rows([
      ...capsRows(a),
      ['assignedAt', `${time(a.assignedAt)} (nonce ${a.nonce})`],
      ['usage', usage(a.usage)],
    ], '    '));
  }
  return lines;
}

export function capsLines(r: CaCapsResponse): string[] {
  const lines = [
    r.unchanged
      ? `The caps of ${r.assignee} on account ${r.accountId} are unchanged; nothing was sent:`
      : `The caps of ${r.assignee} on account ${r.accountId} are updated:`,
    ...rows([...capsRows(r.caps), ['usage', usage(r.usage)], ...txRows(r)]),
  ];
  if (BigInt(r.caps.maxTotalCost) < BigInt(r.usage.totalCost)) {
    lines.push('maxTotalCost is below the usage, so every funding is refused until it is raised.');
  }
  return lines;
}

export function revokeLines(r: { accountId: string; assignee: string; nextNonce: string } & CaTxWire): string[] {
  return [
    `Revoked ${r.assignee} on account ${r.accountId}:`,
    ...rows([['nextNonce', r.nextNonce], ...txRows(r)]),
    'Funded periods run to their end; new fundings are refused.',
  ];
}

export function nonceLines(r: { accountId: string; nextNonce: string } & CaTxWire): string[] {
  return [
    `The assignment nonce of account ${r.accountId} is advanced:`,
    ...rows([['nextNonce', r.nextNonce], ...txRows(r)]),
    'Terms signed at an earlier nonce no longer assign.',
  ];
}

export function labelsLines(r: { accountId: string; cursor: number; from: number; to: number; epochs: CaLabelWire[] }): string[] {
  const header = ['epoch', 'scheduled', 'baseLabel', 'topUpLabel', 'serviceLabel', 'pool'];
  const table = r.epochs.map((e) => [String(e.epoch), e.scheduledTrac, e.baseLabelTrac, e.topUpLabelTrac, e.serviceLabelTrac, e.poolTrac]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i]!.length)));
  const line = (cells: string[]) => `  ${cells.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()}`;
  return [
    `Labels of account ${r.accountId}, epochs ${r.from} to ${r.to} (cursor at epoch ${r.cursor}), in TRAC:`,
    line(header),
    ...table.map(line),
  ];
}

function bucketLines(p: CaPeriodWire, indent: string): string[] {
  return p.buckets.map((b) => `${indent}${b.bucketId}  ${b.serviceClass}  ${b.valueTrac} TRAC  maxAskWeiPerUnit ${b.maxAskWeiPerUnit}`);
}

function periodRows(p: CaPeriodWire): Row[] {
  return [
    ['subscriptionId', p.subscriptionId],
    ['assignee', p.assignee],
    ['value', `${p.valueTrac} TRAC`],
    ['cost', `${p.costTrac} TRAC (${(p.discountBps / 100).toFixed(2)}% off)`],
    ['drawnFromWindow', `${p.drawnFromWindowTrac} TRAC (window ${p.fundedWindow})`],
    ['drawnFromTopUp', `${p.drawnFromTopUpTrac} TRAC`],
    ['period', `${time(p.periodStart)} to ${time(p.periodEnd)}`],
    ['fundedEpoch', String(p.fundedEpoch)],
    ['sessionKey', p.sessionKey],
    ['planDigest', p.planDigest],
    ['buckets', String(p.buckets.length)],
  ];
}

export function periodsLines(r: { accountId: string; total: number; offset: number; periods: CaPeriodWire[] }): string[] {
  if (r.periods.length === 0) {
    return [r.total === 0 ? `No periods funded from account ${r.accountId}.` : `No periods from offset ${r.offset}; account ${r.accountId} has ${r.total}.`];
  }
  const lines = [`Periods funded from account ${r.accountId}: ${r.total} (showing ${r.offset + 1} to ${r.offset + r.periods.length})`];
  for (const p of r.periods) {
    lines.push(`  periodId ${p.periodId}:`, ...rows(periodRows(p), '    '), ...bucketLines(p, '      '));
  }
  return lines;
}

/**
 * The funded period, its transaction first: a seller verifies the period from
 * its `PeriodFunded` log, by `txHash` and `logIndex`. `planDigest` is the plan
 * file's, to notice a plan that changed under a funded periodId.
 */
export function fundLines(r: CaFundingResponse, planDigest?: string): string[] {
  const [subscription, ...period] = periodRows(r);
  const lines = [
    r.existing
      ? `Period ${r.periodId} was already funded from account ${r.accountId}; nothing was sent:`
      : `Funded period ${r.periodId} from account ${r.accountId}:`,
    ...rows([subscription!, ['txHash', r.txHash], ['block', String(r.blockNumber)], ['logIndex', String(r.logIndex)], ...period]),
    ...bucketLines(r, '    '),
  ];
  if (r.existing && planDigest !== undefined && planDigest.toLowerCase() !== r.planDigest.toLowerCase()) {
    lines.push('The plan file\'s planDigest differs from the funded period\'s. To fund a new period, remove periodId from the plan file.');
  }
  return lines;
}

/** One line for `dkg pca info`, pointing to `dkg ca status` when the account spends on services. */
export function serviceSpendingPointer(status: Pick<CaStatusResponse, 'accountId' | 'serviceSpending'>): string | null {
  return status.serviceSpending.enabled ? `  serviceSpending:  on (see dkg ca status ${status.accountId})` : null;
}

// ---------------------------------------------------------------- errors

const TERMS_REASONS: Readonly<Record<string, string>> = {
  assignee: 'the assignee is the zero address',
  maxCostPerPeriod: '--max-period must be above 0',
  maxInferenceCostPerPeriod: '--max-inference must not exceed --max-period',
  maxQueryCostPerPeriod: '--max-query must not exceed --max-period',
  classCaps: '--max-inference and --max-query cannot both be 0',
  maxTotalCost: '--max-total must be at least --max-period',
  maxCostPerWindow: '--max-window must be 0 (no window cap) or at least --max-period',
  maxPeriodSeconds: '--max-period-days must be at least 1 and within the chain\'s longest period',
  expiresAt: '--expires must be in the future',
};

const FUNDING_REASONS: Readonly<Record<string, string>> = {
  bucketCount: 'the plan needs at least one bucket, and no more than the chain allows per period',
  bucketOrder: 'the plan\'s bucketIds must be strictly increasing',
  serviceClass: 'each bucket\'s serviceClass must be "inference" or "query"',
  bucketValue: 'each bucket\'s value must be above 0',
  maxAskWeiPerUnit: 'each bucket\'s maxAskWeiPerUnit must be above 0',
  periodSeconds: 'periodSeconds must be above 0 and within the assignment\'s longest period',
  value: 'the buckets\' total value is too large',
};

const REVERT_HINTS: Readonly<Record<string, string>> = {
  NotAccountOwner: 'Run the owner\'s commands on the node whose primary wallet owns the account (dkg ca status shows the owner).',
  NotAssigned: 'This buyer key holds no assignment on the account: the owner assigns it with dkg ca assign.',
  UnknownAccount: 'There is no such account on this chain.',
  ERC721NonexistentToken: 'There is no such account on this chain.',
  ServiceSpendingDisabled: 'The owner has not switched service spending on: dkg ca services <accountId> enable, on the owner node.',
  ServiceSpendingUnchanged: 'Service spending is already in that state.',
  ExactScheduleFromUnset: 'This chain\'s schedule cut-over (exactScheduleFrom) is not set, so service spending cannot be switched on yet.',
  ServiceFundingPausedTreasuryWired: 'A protocol treasury is wired on this chain, which pauses service spending.',
  InvalidAssignmentNonce: 'The account\'s assignment nonce moved after the terms were signed: sign a new consent on the assignee node.',
  ConsentMissing: 'A party\'s consent is missing: the owner node needs the assignee\'s consent file, the assignee node --owner-signature.',
  InvalidConsentSignature: 'A consent signature does not match these terms on this chain: sign a new consent.',
  AssignmentRevoked: 'The assignment is revoked: only a new assignment, with a new consent, allows funding again.',
  AssignmentExpired: 'The assignment has expired: only a new assignment, with a new consent, renews it.',
  CapExceeded: 'The cost, after the discount, is above that cap of the assignment; nothing was funded. The owner can change the caps with dkg ca caps.',
  PeriodAlreadyFunded: 'This periodId is funded already: dkg ca periods lists it.',
  LabelCapacityExceeded: 'The account\'s remaining scheduled emission cannot cover this cost; nothing was funded.',
  InsufficientAllowance: 'The account\'s current window has too little allowance left for this cost; nothing was funded.',
  AccountExpired: 'The account has expired.',
  // The daemon's answer to a route it does not have.
  'Not found': 'The node may run a version without Conviction Account service spending (/api/ca).',
};

/** Revert arguments that are amounts of TRAC wei. */
const AMOUNT_ARGS: ReadonlySet<string> = new Set(['limit', 'attempted', 'required', 'available', 'unplaced']);
/** Fields of a refusal body worth printing below its first line. */
const BODY_FIELDS = ['owner', 'nodeWallet', 'buyerKey', 'assignee', 'txHash'] as const;

interface HttpErrorLike {
  httpStatus: number;
  message: string;
  responseBody?: unknown;
}

function isHttpError(err: unknown): err is HttpErrorLike {
  return err instanceof Error && typeof (err as { httpStatus?: unknown }).httpStatus === 'number';
}

function argValue(name: string, value: unknown): string {
  const text = String(value);
  return AMOUNT_ARGS.has(name) && /^\d+$/.test(text) ? `${ethers.formatEther(BigInt(text))} TRAC` : text;
}

/**
 * An error as lines for stderr: a refusal of the node with its HTTP status,
 * the revert's arguments (amounts in TRAC), the code and hint of the answer,
 * and what to do next; any other error by its message.
 */
export function caErrorLines(err: unknown): string[] {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return [
      `${err.message}: the node did not answer in time, and may still complete the request.`,
      'Check the account (dkg ca status, dkg ca assignments) before running the command again.',
    ];
  }
  if (!isHttpError(err)) return [err instanceof Error ? err.message : String(err)];
  const body = (typeof err.responseBody === 'object' && err.responseBody !== null ? err.responseBody : {}) as Record<string, unknown>;
  const args = (typeof body.args === 'object' && body.args !== null ? body.args : {}) as Record<string, unknown>;
  const name = err.message;
  const argText = Object.entries(args).map(([key, value]) => `${key} ${argValue(key, value)}`).join(', ');
  const lines = [`${name} (HTTP ${err.httpStatus}${typeof body.code === 'string' ? `, ${body.code}` : ''})${argText ? `: ${argText}` : ''}`];
  lines.push(...BODY_FIELDS.filter((field) => typeof body[field] === 'string').map((field) => `  ${field}: ${String(body[field])}`));
  const reason = typeof args.reason === 'string' ? args.reason : undefined;
  if (name === 'InvalidAssignmentTerms' && reason !== undefined) lines.push(`The caps are refused: ${TERMS_REASONS[reason] ?? reason}.`);
  else if (name === 'InvalidFundingRequest' && reason !== undefined) lines.push(`The plan is refused: ${FUNDING_REASONS[reason] ?? reason}.`);
  else if (REVERT_HINTS[name] !== undefined) lines.push(REVERT_HINTS[name]!);
  if (typeof body.hint === 'string') lines.push(`Hint: ${body.hint}`);
  return lines;
}

/**
 * What to do after a funding whose answer never came: the period may be
 * funded, and repeating the same command, whose plan file holds the periodId,
 * answers it without funding it twice.
 */
export function fundOutcomeUnknownLines(err: Error, accountId: string, planFile: string, periodId: string): string[] {
  return [
    err.message,
    `The period's periodId ${periodId} is in ${planFile}. Run the same command again: dkg ca fund ${accountId} --plan ${planFile}`,
    'If the period was funded, it is answered as already funded and nothing is sent; if not, it is funded once.',
  ];
}

/**
 * What to do after an assignment whose answer never came. Repeating it is
 * safe: an assignment uses up the account's nonce, so the same terms are then
 * refused with InvalidAssignmentNonce and assign nothing twice.
 */
export function assignOutcomeUnknownLines(err: Error, accountId: string): string[] {
  return [
    err.message,
    `Check dkg ca assignments ${accountId} to see whether it landed. Running the same command again is safe: once the`
      + ' assignment lands, its nonce is used up, and the same consent is refused with InvalidAssignmentNonce.',
  ];
}
