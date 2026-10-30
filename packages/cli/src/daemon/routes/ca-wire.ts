// Conviction Account service spending (OT-RFC-27): the wire forms of the
// /api/ca routes. Inputs are parsed here (amounts as decimal TRAC strings,
// times as ISO-8601, the signed terms as wei strings) and every answer is
// serialized here: amounts as decimal strings of wei, each with a `…Trac`
// sibling for display, except inside the signed `terms`, which travel exactly
// as they are signed.

import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import {
  CA_SERVICE_CLASS_INFERENCE,
  CA_SERVICE_CLASS_QUERY,
  type CaAssignment,
  type CaAssignmentCaps,
  type CaAssignmentTerms,
  type CaAssignmentUsage,
  type CaBucket,
  type CaEpochLabel,
  type CaFundingRequest,
  type CaPeriod,
  type CaServiceClass,
  type CaServiceStatus,
} from '@origintrail-official/dkg-chain';

const UINT96_MAX = (1n << 96n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT40_MAX = 0xff_ffff_ffff;
const UINT32_MAX = 0xffff_ffff;

/** The longest period the contracts take by default (`ConvictionServiceStorage.maxPeriodSeconds`): 31 days. */
const CA_DEFAULT_MAX_PERIOD_SECONDS = 31 * 86_400;

/** A request the route refuses with 400 before anything is read or sent. */
export class CaBadRequest extends Error {
  constructor(message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CaBadRequest';
  }
}

const CAPS_FIELDS = [
  'maxCostPerPeriod', 'maxInferenceCostPerPeriod', 'maxQueryCostPerPeriod', 'maxCostPerWindow',
  'maxTotalCost', 'maxPeriodSeconds', 'expiresAt',
] as const satisfies ReadonlyArray<keyof CaAssignmentCaps>;
const AMOUNT_CAPS = CAPS_FIELDS.slice(0, 5) as ReadonlyArray<
  'maxCostPerPeriod' | 'maxInferenceCostPerPeriod' | 'maxQueryCostPerPeriod' | 'maxCostPerWindow' | 'maxTotalCost'
>;

export function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CaBadRequest(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function refuseUnknownFields(body: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new CaBadRequest(`${what} has unknown field(s): ${unknown.join(', ')}`);
}

/** A decimal TRAC amount (string or number) as wei, from 0 (or 1 wei with `positive`) to the uint96 range. */
function parseTracAmount(raw: unknown, field: string, opts: { positive?: boolean } = {}): bigint {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new CaBadRequest(`${field} must be a decimal string of TRAC`);
  }
  const s = String(raw).trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new CaBadRequest(`${field} must be a non-negative decimal amount of TRAC, with at most 18 decimals`);
  const wei = ethers.parseEther(s);
  if (opts.positive && wei === 0n) throw new CaBadRequest(`${field} must be greater than 0`);
  if (wei > UINT96_MAX) throw new CaBadRequest(`${field} exceeds the uint96 range of the contracts`);
  return wei;
}

/** A decimal integer of wei (string, or a safe-integer number) up to `max`. */
function parseWei(raw: unknown, field: string, max = UINT96_MAX): bigint {
  const s = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof s !== 'string' || !/^\d+$/.test(s.trim())) throw new CaBadRequest(`${field} must be a decimal string of wei`);
  const value = BigInt(s.trim());
  if (value > max) throw new CaBadRequest(`${field} exceeds its range (at most ${max})`);
  return value;
}

/** A whole number (number, or a decimal string) from `min` to `max`. */
export function parseInteger(raw: unknown, field: string, min: number, max: number): number {
  const value = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new CaBadRequest(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/**
 * An ISO-8601 time with its zone (`Z` or `±hh:mm`) as unix seconds: a time
 * without one would mean whatever the node's local zone makes of it.
 */
function parseIsoTime(raw: unknown, field: string): number {
  if (typeof raw !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw.trim())) {
    throw new CaBadRequest(`${field} must be an ISO-8601 time with a zone, such as 2026-11-30T00:00:00Z`);
  }
  const ms = Date.parse(raw.trim());
  const seconds = Math.floor(ms / 1000);
  if (!Number.isFinite(ms) || seconds <= 0 || seconds > UINT40_MAX) throw new CaBadRequest(`${field} is not a valid time`);
  return seconds;
}

export function parseAddress(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !ethers.isAddress(raw)) throw new CaBadRequest(`${field} must be a 0x-prefixed 20-byte EVM address`);
  return ethers.getAddress(raw);
}

function parseBytes32(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !ethers.isHexString(raw, 32)) throw new CaBadRequest(`${field} must be a 32-byte 0x-prefixed hex string`);
  return raw.toLowerCase();
}

/** A consent signature: 0x-prefixed hex bytes, or `undefined` when absent. */
export function parseSignature(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !ethers.isHexString(raw) || raw.length < 4 || raw.length % 2 !== 0) {
    throw new CaBadRequest(`${field} must be 0x-prefixed hex bytes`);
  }
  return raw.toLowerCase();
}

/** Caps given as decimal TRAC amounts, an ISO-8601 `expiresAt` and whole `maxPeriodSeconds`; fields left out stay absent. */
export function parseCapsInput(body: Record<string, unknown>, extraFields: readonly string[] = []): Partial<CaAssignmentCaps> {
  refuseUnknownFields(body, [...CAPS_FIELDS, ...extraFields], 'The caps');
  const caps: Partial<CaAssignmentCaps> = {};
  for (const field of AMOUNT_CAPS) {
    if (body[field] !== undefined) caps[field] = parseTracAmount(body[field], field, { positive: field === 'maxCostPerPeriod' || field === 'maxTotalCost' });
  }
  if (body.maxPeriodSeconds !== undefined) caps.maxPeriodSeconds = parseInteger(body.maxPeriodSeconds, 'maxPeriodSeconds', 1, UINT32_MAX);
  if (body.expiresAt !== undefined) caps.expiresAt = parseIsoTime(body.expiresAt, 'expiresAt');
  return caps;
}

/**
 * The caps of a consent: `maxCostPerPeriod`, `maxTotalCost` and `expiresAt`
 * are required; the inference and query caps default to the period cap, the
 * window cap to 0 (no window cap), `maxPeriodSeconds` to 31 days. `nonce` is
 * `"auto"` (the default: the account's current nonce) or a decimal number.
 */
export function parseConsentInput(body: Record<string, unknown>): { caps: CaAssignmentCaps; nonce: bigint | 'auto' } {
  const given = parseCapsInput(body, ['nonce']);
  for (const field of ['maxCostPerPeriod', 'maxTotalCost', 'expiresAt'] as const) {
    if (given[field] === undefined) throw new CaBadRequest(`${field} is required`);
  }
  const caps: CaAssignmentCaps = {
    maxCostPerPeriod: given.maxCostPerPeriod!,
    maxInferenceCostPerPeriod: given.maxInferenceCostPerPeriod ?? given.maxCostPerPeriod!,
    maxQueryCostPerPeriod: given.maxQueryCostPerPeriod ?? given.maxCostPerPeriod!,
    maxCostPerWindow: given.maxCostPerWindow ?? 0n,
    maxTotalCost: given.maxTotalCost!,
    maxPeriodSeconds: given.maxPeriodSeconds ?? CA_DEFAULT_MAX_PERIOD_SECONDS,
    expiresAt: given.expiresAt!,
  };
  const raw = body.nonce ?? 'auto';
  return { caps, nonce: raw === 'auto' ? 'auto' : parseWei(raw, 'nonce', UINT64_MAX) };
}

/** Signed terms, as the consent answer gives them: amounts in wei, times in unix seconds. */
export function parseTermsWire(raw: unknown, accountId: bigint): CaAssignmentTerms {
  const t = requireObject(raw, 'terms');
  refuseUnknownFields(t, ['accountId', 'assignee', ...CAPS_FIELDS, 'nonce'], 'terms');
  const termsAccount = parseWei(t.accountId, 'terms.accountId', (1n << 256n) - 1n);
  if (termsAccount !== accountId) throw new CaBadRequest(`terms.accountId ${termsAccount} is not account ${accountId}`);
  const terms = {
    accountId,
    assignee: parseAddress(t.assignee, 'terms.assignee'),
    maxPeriodSeconds: parseInteger(t.maxPeriodSeconds, 'terms.maxPeriodSeconds', 0, UINT32_MAX),
    expiresAt: parseInteger(t.expiresAt, 'terms.expiresAt', 0, UINT40_MAX),
    nonce: parseWei(t.nonce, 'terms.nonce', UINT64_MAX),
  } as CaAssignmentTerms;
  for (const field of AMOUNT_CAPS) terms[field] = parseWei(t[field], `terms.${field}`);
  return terms;
}

function parseServiceClass(raw: unknown, field: string): CaServiceClass {
  if (raw === 'inference' || raw === CA_SERVICE_CLASS_INFERENCE) return CA_SERVICE_CLASS_INFERENCE;
  if (raw === 'query' || raw === CA_SERVICE_CLASS_QUERY) return CA_SERVICE_CLASS_QUERY;
  throw new CaBadRequest(`${field} must be "inference" or "query"`);
}

/**
 * A plan period to fund. `periodId` defaults to a random one, which a retry
 * cannot repeat: a caller that may retry chooses its own. `sessionKey`
 * defaults to the zero address. Bucket values are decimal TRAC, `maxAskWeiPerUnit` wei.
 */
export function parseFundingInput(body: Record<string, unknown>, accountId: bigint): CaFundingRequest {
  refuseUnknownFields(body, ['periodId', 'periodSeconds', 'sessionKey', 'planDigest', 'buckets'], 'The plan');
  if (!Array.isArray(body.buckets) || body.buckets.length === 0) throw new CaBadRequest('buckets must be a non-empty array');
  return {
    accountId,
    periodId: body.periodId === undefined ? ethers.hexlify(randomBytes(32)) : parseBytes32(body.periodId, 'periodId'),
    sessionKey: body.sessionKey === undefined ? ethers.ZeroAddress : parseAddress(body.sessionKey, 'sessionKey'),
    periodSeconds: parseInteger(body.periodSeconds, 'periodSeconds', 1, UINT32_MAX),
    planDigest: parseBytes32(body.planDigest, 'planDigest'),
    buckets: body.buckets.map((raw, i): CaBucket => {
      const b = requireObject(raw, `buckets[${i}]`);
      refuseUnknownFields(b, ['bucketId', 'serviceClass', 'value', 'maxAskWeiPerUnit'], `buckets[${i}]`);
      return {
        bucketId: parseBytes32(b.bucketId, `buckets[${i}].bucketId`),
        serviceClass: parseServiceClass(b.serviceClass, `buckets[${i}].serviceClass`),
        value: parseTracAmount(b.value, `buckets[${i}].value`, { positive: true }),
        maxAskWeiPerUnit: parseWei(b.maxAskWeiPerUnit, `buckets[${i}].maxAskWeiPerUnit`),
      };
    }),
  };
}

// ---------------------------------------------------------------- answers

function tracPair(name: string, wei: bigint): Record<string, string> {
  return { [name]: wei.toString(), [`${name}Trac`]: ethers.formatEther(wei) };
}

/** The signed terms, exactly the ten fields of the EIP-712 `ServiceAssignment`. */
export function termsWire(t: CaAssignmentTerms): Record<string, unknown> {
  return {
    accountId: t.accountId.toString(),
    assignee: t.assignee,
    maxCostPerPeriod: t.maxCostPerPeriod.toString(),
    maxInferenceCostPerPeriod: t.maxInferenceCostPerPeriod.toString(),
    maxQueryCostPerPeriod: t.maxQueryCostPerPeriod.toString(),
    maxCostPerWindow: t.maxCostPerWindow.toString(),
    maxTotalCost: t.maxTotalCost.toString(),
    maxPeriodSeconds: t.maxPeriodSeconds,
    expiresAt: t.expiresAt,
    nonce: t.nonce.toString(),
  };
}

export function capsWire(c: CaAssignmentCaps): Record<string, unknown> {
  return {
    ...Object.assign({}, ...AMOUNT_CAPS.map((field) => tracPair(field, c[field]))),
    maxPeriodSeconds: c.maxPeriodSeconds,
    expiresAt: c.expiresAt,
  };
}

export function capsOf(a: CaAssignmentCaps): CaAssignmentCaps {
  return Object.fromEntries(CAPS_FIELDS.map((field) => [field, a[field]])) as unknown as CaAssignmentCaps;
}

export function sameCaps(a: CaAssignmentCaps, b: CaAssignmentCaps): boolean {
  return CAPS_FIELDS.every((field) => a[field] === b[field]);
}

export function usageWire(u: CaAssignmentUsage): Record<string, unknown> {
  return { ...tracPair('totalCost', u.totalCost), ...tracPair('windowCost', u.windowCost), window: u.window, periods: u.periods };
}

export function assignmentWire(a: { assignee: string } & CaAssignment): Record<string, unknown> {
  return {
    assignee: a.assignee,
    ...capsWire(a),
    assignedAt: a.assignedAt,
    revokedAt: a.revokedAt,
    nonce: a.nonce.toString(),
    active: a.active,
    usage: usageWire(a.usage),
  };
}

export function statusWire(
  s: CaServiceStatus,
  node: { ownedByNode: boolean; buyerKey: string | null },
): Record<string, unknown> {
  return {
    accountId: s.accountId.toString(),
    owner: s.owner,
    ownedByNode: node.ownedByNode,
    buyerKey: node.buyerKey,
    logicVersion: s.logicVersion,
    serviceSpending: { enabled: s.serviceSpendingEnabledAt !== 0, enabledAt: s.serviceSpendingEnabledAt },
    discountBps: s.discountBps,
    lockDurationEpochs: s.lockDurationEpochs,
    expiresAtTimestamp: s.expiresAtTimestamp,
    window: {
      index: s.window.index,
      ...tracPair('baseAllowance', s.window.baseAllowance),
      ...tracPair('baseRemaining', s.window.baseRemaining),
      ...tracPair('topUpBuffer', s.window.topUpBuffer),
      expired: s.window.expired,
    },
    schedule: { exact: s.schedule.exact, firstEpoch: s.schedule.firstEpoch, lastEpoch: s.schedule.lastEpoch },
    labels: {
      ...tracPair('total', s.labels.total),
      cursor: s.labels.cursor,
      ...tracPair('remainingBaseCapacity', s.labels.remainingBaseCapacity),
    },
    assignments: { count: s.assignments.count, active: s.assignments.active },
    treasuryWired: s.treasuryWired,
  };
}

export function labelWire(l: CaEpochLabel): Record<string, unknown> {
  return {
    epoch: l.epoch,
    ...tracPair('scheduled', l.scheduled),
    ...tracPair('baseLabel', l.baseLabel),
    ...tracPair('topUpLabel', l.topUpLabel),
    ...tracPair('serviceLabel', l.serviceLabel),
    ...tracPair('pool', l.pool),
  };
}

export function periodWire(p: CaPeriod): Record<string, unknown> {
  return {
    subscriptionId: p.subscriptionId,
    accountId: p.accountId.toString(),
    assignee: p.assignee,
    periodId: p.periodId,
    sessionKey: p.sessionKey,
    planDigest: p.planDigest,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    fundedEpoch: p.fundedEpoch,
    fundedWindow: p.fundedWindow,
    discountBps: p.discountBps,
    ...tracPair('value', p.value),
    ...tracPair('cost', p.cost),
    ...tracPair('drawnFromWindow', p.drawnFromWindow),
    ...tracPair('drawnFromTopUp', p.drawnFromTopUp),
    buckets: p.buckets.map((b) => ({
      bucketId: b.bucketId,
      serviceClass: b.serviceClass === CA_SERVICE_CLASS_QUERY ? 'query' : 'inference',
      ...tracPair('value', b.value),
      maxAskWeiPerUnit: b.maxAskWeiPerUnit.toString(),
    })),
  };
}

/** A revert's arguments for the wire: integers as decimal strings. */
export function revertArgsWire(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]));
}
