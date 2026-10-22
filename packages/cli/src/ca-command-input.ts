// SPDX-License-Identifier: Apache-2.0

/**
 * The input side of the `dkg ca` commands (Conviction Account service
 * spending, OT-RFC-27): option values, checked before the CLI connects to the
 * node, and the consent and plan files.
 *
 * - Amounts stay the decimal TRAC strings they were given, and `--expires` the
 *   ISO-8601 time: the node converts them. Only the options given are sent, so
 *   the node's defaults apply to the rest.
 * - A plan file without a `periodId` gets one written into it before it is
 *   sent, so that running the same command again repeats the same period.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ethers } from 'ethers';
import { newCaPeriodId, type CaAssignInput, type CaCapsInput, type CaConsentInput, type CaFundingPlan } from './ca-client.js';

const TRAC_AMOUNT = /^\d+(\.\d{1,18})?$/;
const ISO_TIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const HEX_BYTES = /^0x([0-9a-fA-F]{2})+$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DAY_SECONDS = 86_400;
const UINT32_MAX = 0xffff_ffff;

/** A value the CLI refuses before it sends anything; the message names the option or file. */
export class CaUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaUsageError';
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** An account id argument, as `dkg pca` checks it. */
export function parseAccountIdArg(value: string): string {
  if (!/^\d+$/.test(value)) throw new CaUsageError('accountId must be a non-negative integer');
  return value;
}

/** An EVM address argument. */
export function parseAddressArg(value: string, what: string): string {
  if (!ethers.isAddress(value)) throw new CaUsageError(`${what} must be a 0x-prefixed 20-byte EVM address`);
  return value;
}

/** The state argument of `dkg ca services`: `enable` or `disable` (`on` and `off` too). */
export function parseServicesState(value: string): boolean {
  const state = value.trim().toLowerCase();
  if (state === 'enable' || state === 'on') return true;
  if (state === 'disable' || state === 'off') return false;
  throw new CaUsageError('The state must be enable or disable');
}

/** A decimal amount of TRAC, as given: digits, then at most 18 decimals; no sign, exponent or separator. */
export function parseTracOption(value: unknown, option: string): string {
  const amount = trimmed(value);
  if (!TRAC_AMOUNT.test(amount)) {
    throw new CaUsageError(`${option} must be a decimal amount of TRAC, such as 25 or 2.5, with at most 18 decimals`);
  }
  return amount;
}

/** An ISO-8601 time with its zone (`Z` or `±hh:mm`), as given: without one it would mean whatever the node's zone makes of it. */
export function parseExpiresOption(value: unknown, option = '--expires'): string {
  const time = trimmed(value);
  if (!ISO_TIME_WITH_ZONE.test(time) || !Number.isFinite(Date.parse(time))) {
    throw new CaUsageError(`${option} must be an ISO-8601 time with a zone, such as 2026-11-30T00:00:00Z or 2026-11-30T01:00:00+01:00`);
  }
  return time;
}

/** Whole days, as seconds: `--max-period-days 31` is 2,678,400 seconds. */
export function parseDaysOption(value: unknown, option: string): number {
  const days = trimmed(value);
  if (!/^[1-9]\d*$/.test(days) || Number(days) * DAY_SECONDS > UINT32_MAX) {
    throw new CaUsageError(`${option} must be a whole number of days, at least 1`);
  }
  return Number(days) * DAY_SECONDS;
}

/** A whole number from `min`: an epoch, a page offset (from 0) or a page size (from 1). */
export function parseWholeOption(value: unknown, option: string, min = 0): number {
  const text = trimmed(value);
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < min) {
    throw new CaUsageError(`${option} must be a whole number${min > 0 ? ` from ${min}` : ', 0 or more'}`);
  }
  return n;
}

/** The cap options of `dkg ca consent` and `dkg ca caps`, as commander parses them. */
export interface CaCapOptions {
  maxPeriod?: string;
  maxInference?: string;
  maxQuery?: string;
  maxWindow?: string;
  maxTotal?: string;
  maxPeriodDays?: string;
  expires?: string;
}

const AMOUNT_OPTIONS = [
  ['maxPeriod', '--max-period', 'maxCostPerPeriod'],
  ['maxInference', '--max-inference', 'maxInferenceCostPerPeriod'],
  ['maxQuery', '--max-query', 'maxQueryCostPerPeriod'],
  ['maxWindow', '--max-window', 'maxCostPerWindow'],
  ['maxTotal', '--max-total', 'maxTotalCost'],
] as const;

/** The caps the options give, in the route's fields; an option left out stays out. */
export function capsFromOptions(opts: CaCapOptions): CaCapsInput {
  const caps: CaCapsInput = {};
  for (const [key, option, field] of AMOUNT_OPTIONS) {
    if (opts[key] !== undefined) caps[field] = parseTracOption(opts[key], option);
  }
  if (opts.maxPeriodDays !== undefined) caps.maxPeriodSeconds = parseDaysOption(opts.maxPeriodDays, '--max-period-days');
  if (opts.expires !== undefined) caps.expiresAt = parseExpiresOption(opts.expires);
  return caps;
}

/**
 * The caps of a consent. `--max-period`, `--max-total` and `--expires` are
 * required; the node applies the defaults of the rest (the inference cap is the
 * period cap, the query and window caps 0, the longest period 31 days).
 */
export function consentFromOptions(opts: CaCapOptions): CaConsentInput {
  const caps = capsFromOptions(opts);
  for (const [field, option] of [['maxCostPerPeriod', '--max-period'], ['maxTotalCost', '--max-total'], ['expiresAt', '--expires']] as const) {
    if (caps[field] === undefined) throw new CaUsageError(`${option} is required`);
  }
  return caps as CaConsentInput;
}

/** New caps for `dkg ca caps`: at least one option, since the ones left out keep their stored values. */
export function capsUpdateFromOptions(opts: CaCapOptions): CaCapsInput {
  const caps = capsFromOptions(opts);
  if (Object.keys(caps).length === 0) {
    throw new CaUsageError('Give at least one of --max-period, --max-inference, --max-query, --max-window, --max-total, --max-period-days and --expires');
  }
  return caps;
}

async function readJsonObject(path: string, what: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new CaUsageError(`Cannot read the ${what} ${path}: ${messageOf(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CaUsageError(`The ${what} ${path} is not valid JSON: ${messageOf(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CaUsageError(`The ${what} ${path} must hold a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * The assignment to submit: the consent file as it is (a consent answer is an
 * assignment body), with the owner's signature added when one is given. A file
 * that holds only `{ "terms": … }` serves too, with the owner's signature.
 */
export async function assignmentFromFile(path: string, ownerSignature?: string): Promise<CaAssignInput> {
  const consent = await readJsonObject(path, 'consent file');
  if (typeof consent.terms !== 'object' || consent.terms === null || Array.isArray(consent.terms)) {
    throw new CaUsageError(`The consent file ${path} has no terms: use the file that dkg ca consent wrote`);
  }
  if (ownerSignature === undefined) return consent as unknown as CaAssignInput;
  const signature = ownerSignature.trim();
  if (!HEX_BYTES.test(signature)) throw new CaUsageError('--owner-signature must be 0x-prefixed hex bytes');
  return { ...consent, ownerSignature: signature } as unknown as CaAssignInput;
}

/** A plan period to fund, with the `periodId` it is funded under. */
export interface CaPreparedPlan {
  plan: CaFundingPlan & { periodId: string };
  periodId: string;
  /** The periodId was new, and is now written into the plan file. */
  written: boolean;
}

/** Replace `path` by `text` through a temporary file in its directory, keeping its mode. */
async function replaceFile(path: string, text: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777;
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, text, { flag: 'wx', mode });
    await rename(temp, path);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}

/**
 * The plan file's period and its `periodId`: the file's own, or a new one,
 * written into the file before anything is sent. The id is the period's
 * idempotency key: the node answers a period funded under it without funding
 * it again, so the same command can be repeated safely, while a plan without
 * an id would fund a second period. When the file cannot be written, nothing is
 * sent.
 */
export async function preparePlanFile(path: string): Promise<CaPreparedPlan> {
  const plan = await readJsonObject(path, 'plan file');
  if (plan.periodId !== undefined) {
    if (typeof plan.periodId !== 'string' || !BYTES32.test(plan.periodId)) {
      throw new CaUsageError(`periodId in the plan file ${path} must be 32 bytes of 0x-prefixed hex`);
    }
    return { plan: plan as unknown as CaPreparedPlan['plan'], periodId: plan.periodId, written: false };
  }
  const periodId = newCaPeriodId();
  const withId = { periodId, ...plan };
  try {
    await replaceFile(path, `${JSON.stringify(withId, null, 2)}\n`);
  } catch (err) {
    throw new CaUsageError(
      `Cannot write a periodId into the plan file ${path} (${messageOf(err)}), so nothing was sent. `
      + 'Add a "periodId" of 32 bytes of 0x-prefixed hex to the plan, and run the command again.',
    );
  }
  return { plan: withId as unknown as CaPreparedPlan['plan'], periodId, written: true };
}

/** Write a consent answer to `path`, for `dkg ca assign --consent`. */
export async function writeConsentFile(path: string, consent: unknown): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(consent, null, 2)}\n`);
  } catch (err) {
    throw new CaUsageError(`Cannot write the consent file ${path}: ${messageOf(err)}`);
  }
}
