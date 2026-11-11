// The rehearsal's results files. Each phase writes cache/rfc27-fork/<phase>.json
// (REHEARSAL_DIR overrides the directory), numbers as decimal strings, and
// reads what the earlier phases wrote through the types below: every field a
// later phase consumes is checked, and its numbers decoded, where the file is
// loaded.

import * as fs from 'fs';
import * as path from 'path';

import type { Range } from '../../../test/helpers/emission-model';
import { Redactor, toJson, writeJson } from '../report';

export const DIR = process.env.REHEARSAL_DIR ?? 'cache/rfc27-fork';

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export type Obj = { readonly [key: string]: unknown };

export function asObject(x: unknown, where: string): Obj {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error(`${where} is not an object`);
  return x as Obj;
}

export function asList(x: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(x)) throw new Error(`${where} is not a list`);
  return x;
}

export function asString(x: unknown, where: string): string {
  if (typeof x !== 'string') throw new Error(`${where} is not a string`);
  return x;
}

/** A number the file keeps as a decimal string, or as a JSON integer. */
export function asBigint(x: unknown, where: string): bigint {
  if (typeof x === 'string' && /^-?\d+$/.test(x)) return BigInt(x);
  if (typeof x === 'number' && Number.isInteger(x)) return BigInt(x);
  throw new Error(`${where} is not an integer`);
}

export function asNumber(x: unknown, where: string): number {
  if (typeof x !== 'number') throw new Error(`${where} is not a number`);
  return x;
}

export function asBoolean(x: unknown, where: string): boolean {
  if (typeof x !== 'boolean') throw new Error(`${where} is not a boolean`);
  return x;
}

const listOf = <T>(x: unknown, where: string, each: (v: unknown, where: string) => T): T[] =>
  asList(x, where).map((v, i) => each(v, `${where}[${i}]`));

function recordOf<T>(x: unknown, where: string, each: (v: unknown, where: string) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(asObject(x, where))) out[k] = each(v, `${where}.${k}`);
  return out;
}

function rangeOf(x: unknown, where: string): Range {
  const o = asObject(x, where);
  return { start: asBigint(o.start, `${where}.start`), end: asBigint(o.end, `${where}.end`), amount: asBigint(o.amount, `${where}.amount`) };
}

// ---------------------------------------------------------------------------
// What the phases write
// ---------------------------------------------------------------------------

/** One transaction a phase sent, as its results file lists it. */
export type TxEntry = {
  label: string;
  hash?: string;
  block?: number;
  from?: string;
  to?: string | null;
  gasUsed?: bigint;
  gasLimit?: bigint;
  /** The transaction's smallest gas limit, the estimate, which must fit under 2^24. */
  estimate?: bigint;
  overTxGasCap?: boolean;
  status: number | string;
  error?: string;
};

/** A check, as the results files list them: [label, passed, detail]. */
export type CheckEntry = [string, boolean, string | undefined];

/** A position of the staking NFT, as ConvictionStakingStorage holds it. */
export type Position = {
  tokenId: bigint;
  owner: string;
  node: bigint;
  raw: bigint;
  lastClaimedEpoch: bigint;
  migrationEpoch: bigint;
  expiryTimestamp: bigint;
  cumulativeRewardsClaimed: bigint;
};

/** A Conviction Account, as PublishingConvictionStorage holds it, when the pre phase read it. */
export type AccountSummary = {
  id: bigint;
  owner: string;
  committed: bigint;
  createdAtTimestamp: bigint;
  expiresAtTimestamp: bigint;
  lock: bigint;
  lastSettledWindow: bigint;
  fullySwept: boolean;
  topUp: bigint;
  scheduled: boolean;
  live: boolean;
  createdBefore1008: boolean;
};

/** StakingKPI's net of a node in an epoch, and the net a claim split, by `<node>:<epoch>`. */
export type NodeEpochNet = { kpiNet: bigint; split: boolean; storedNet: bigint };

/** A publish through the publishing NFT: its cost, its spends, and what it booked to the staker pool. */
export type PublishResult = {
  epoch: bigint;
  window: bigint;
  discountedCost: bigint;
  windowSpentDelta: bigint;
  topUpDelta: bigint;
  spentFromEpoch?: bigint;
  spentFromTopUp?: bigint;
  stakerCredits: Range[];
  gasUsed: bigint;
};

/** A position's claim: the reward is its cumulative-rewards delta, and rawDelta what it credited to the raw stake. */
export type ClaimResult = {
  tokenId: bigint;
  node: bigint;
  reward: bigint;
  rawDelta: bigint;
  lastClaimedEpoch: bigint;
  gasUsed: bigint;
};

/** A transaction measured in reverted snapshots: its gas used, and the smallest gas limit it goes through with. */
export type GasMeasure = { gasUsed: bigint; minGasLimit: bigint; marginTo2pow24: bigint };

// ---------------------------------------------------------------------------
// What later phases read
// ---------------------------------------------------------------------------

/** What `existing` and `cycle` read of pre.json. */
export type PreRead = {
  epoch: bigint;
  /** The operational key of each node that sent a recent proof challenge, by node id. */
  operational: Record<string, string>;
  accounts: Pick<AccountSummary, 'id' | 'live' | 'createdBefore1008'>[];
  kpiBefore: Record<string, NodeEpochNet>;
  old: {
    publish: Pick<PublishResult, 'discountedCost' | 'windowSpentDelta' | 'topUpDelta' | 'stakerCredits'>;
    settles: { id: bigint; stakerCredits: Range[]; events: string[] }[];
    claims: Pick<ClaimResult, 'tokenId' | 'reward' | 'rawDelta' | 'lastClaimedEpoch' | 'gasUsed'>[];
    netsAfterOldClaims: Record<string, { split: boolean; storedNet: bigint }>;
  };
};

/** What `cycle` reads of hub.json. */
export type HubRead = { activation: bigint };

/** What `late-booking` reads of cycle.json. */
export type CycleRead = { activation: bigint; lateAccount: { accountId: bigint } };

function decodePre(x: unknown, where: string): PreRead {
  const o = asObject(x, where);
  const old = asObject(o.old, `${where}.old`);
  const publish = asObject(old.publish, `${where}.old.publish`);
  return {
    epoch: asBigint(o.epoch, `${where}.epoch`),
    operational: recordOf(o.operational, `${where}.operational`, asString),
    accounts: listOf(o.accounts, `${where}.accounts`, (v, w) => {
      const a = asObject(v, w);
      return { id: asBigint(a.id, `${w}.id`), live: asBoolean(a.live, `${w}.live`), createdBefore1008: asBoolean(a.createdBefore1008, `${w}.createdBefore1008`) };
    }),
    kpiBefore: recordOf(o.kpiBefore, `${where}.kpiBefore`, (v, w) => {
      const n = asObject(v, w);
      return { kpiNet: asBigint(n.kpiNet, `${w}.kpiNet`), split: asBoolean(n.split, `${w}.split`), storedNet: asBigint(n.storedNet, `${w}.storedNet`) };
    }),
    old: {
      publish: {
        discountedCost: asBigint(publish.discountedCost, `${where}.old.publish.discountedCost`),
        windowSpentDelta: asBigint(publish.windowSpentDelta, `${where}.old.publish.windowSpentDelta`),
        topUpDelta: asBigint(publish.topUpDelta, `${where}.old.publish.topUpDelta`),
        stakerCredits: listOf(publish.stakerCredits, `${where}.old.publish.stakerCredits`, rangeOf),
      },
      settles: listOf(old.settles, `${where}.old.settles`, (v, w) => {
        const s = asObject(v, w);
        return { id: asBigint(s.id, `${w}.id`), stakerCredits: listOf(s.stakerCredits, `${w}.stakerCredits`, rangeOf), events: listOf(s.events, `${w}.events`, asString) };
      }),
      claims: listOf(old.claims, `${where}.old.claims`, (v, w) => {
        const c = asObject(v, w);
        return {
          tokenId: asBigint(c.tokenId, `${w}.tokenId`),
          reward: asBigint(c.reward, `${w}.reward`),
          rawDelta: asBigint(c.rawDelta, `${w}.rawDelta`),
          lastClaimedEpoch: asBigint(c.lastClaimedEpoch, `${w}.lastClaimedEpoch`),
          gasUsed: asBigint(c.gasUsed, `${w}.gasUsed`),
        };
      }),
      netsAfterOldClaims: recordOf(old.netsAfterOldClaims, `${where}.old.netsAfterOldClaims`, (v, w) => {
        const n = asObject(v, w);
        return { split: asBoolean(n.split, `${w}.split`), storedNet: asBigint(n.storedNet, `${w}.storedNet`) };
      }),
    },
  };
}

const decodeHub = (x: unknown, where: string): HubRead => ({ activation: asBigint(asObject(x, where).activation, `${where}.activation`) });

function decodeCycle(x: unknown, where: string): CycleRead {
  const o = asObject(x, where);
  const late = asObject(o.lateAccount, `${where}.lateAccount`);
  return { activation: asBigint(o.activation, `${where}.activation`), lateAccount: { accountId: asBigint(late.accountId, `${where}.lateAccount.accountId`) } };
}

/** A results file, unless its phase failed checks: what those did to the fork was undone, so nothing can build on it. */
export function passedResults(name: string, file: string, x: unknown): unknown {
  const { checks } = asObject(x, file);
  const failed = Array.isArray(checks) ? checks.filter((c) => Array.isArray(c) && c[1] === false).length : 0;
  if (failed) throw new Error(`${file} records ${failed} failed check${failed > 1 ? 's' : ''}, whose phase was undone: run PHASE=${name} again`);
  return x;
}

function load<T>(name: string, decode: (x: unknown, where: string) => T): T {
  const f = path.join(DIR, `${name}.json`);
  if (!fs.existsSync(f)) throw new Error(`${f} is missing: run PHASE=${name} first`);
  return decode(passedResults(name, f, JSON.parse(fs.readFileSync(f, 'utf8'))), f);
}

export const loadPre = (): PreRead => load('pre', decodePre);
export const loadHub = (): HubRead => load('hub', decodeHub);
export const loadCycle = (): CycleRead => load('cycle', decodeCycle);

/** Writes the phase's results file: bigints as decimal strings, undefined fields left out. */
export function save(name: string, data: { [key: string]: unknown }, redactor: Redactor): string {
  const file = path.join(DIR, `${name}.json`);
  writeJson(file, toJson(data), redactor);
  return file;
}
