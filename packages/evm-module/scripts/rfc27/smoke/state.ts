// The smoke test's run state: cache/rfc27-smoke/<run>.json, which git
// ignores. Ids, epochs, addresses and transaction hashes, never a key, bound
// to the network it ran on. Numeric fields are kept as decimal strings in the
// file and decoded to bigint where it is loaded. What the chain and the journal
// already tell is not kept: what a seller's batches counted is read from them.

import * as fs from 'fs';

import { JsonObject, Redactor, toJson, writeJson } from '../report';
import type { Journal, StepRecord, WithdrawalExpected } from './tx';

export const PHASES = ['check', 'setup', 'serve', 'claim', 'withdraw'] as const;
export type PhaseName = (typeof PHASES)[number];

export type Amounts = {
  stake: bigint;
  caValue: bigint;
  caTopUp: bigint;
  edgeValue: bigint;
  walletValue: bigint;
  keyEth: bigint;
  committed: bigint;
  committedFloor: bigint;
  lock: bigint;
  discountBps: bigint;
};

export type Withdrawal = { epoch: bigint; node: bigint; recordedScore: bigint };

export type SmokeState = {
  version: 1;
  run: string;
  network: 'fork' | 'base-sepolia';
  chainId: bigint;
  forkBlock?: bigint;
  hub: string;
  settlement: string;
  startedAt: bigint;
  addresses: { owner: string; buyer: string; edgeBuyer: string; caSession: string; walletSession: string; edgeSession: string; seller: string };
  sellerId: bigint;
  amounts: Amounts;
  /** The epoch of the run's subscriptions. */
  E?: bigint;
  tokenId?: bigint;
  stakeRaw?: bigint;
  stakeEpoch?: bigint;
  accountId?: bigint;
  accountExpiresAt?: bigint;
  buyerNonce?: bigint;
  edgeNonce?: bigint;
  subscriptions: { ca?: string; wallet?: string; edge?: string };
  costs: { ca?: bigint; topUp?: bigint; edge?: bigint };
  withdrawal?: Withdrawal;
  /** Fork-only: the score each stand-in proof writes, and the epochs that have one. */
  fork?: { mirrorScore?: bigint; proofs: string[] };
  steps: Record<string, StepRecord>;
  /** A phase that ran to its end: done, or failed when any of its checks did, and then to be run again. */
  phases: Partial<Record<PhaseName, { status: 'done' | 'failed'; failedChecks: number }>>;
};

/** A run once setup has completed: what every later phase takes for granted. */
export type SetupState = SmokeState & {
  E: bigint;
  tokenId: bigint;
  stakeRaw: bigint;
  stakeEpoch: bigint;
  accountId: bigint;
  accountExpiresAt: bigint;
  buyerNonce: bigint;
  subscriptions: { ca: string; wallet: string };
  costs: { ca: bigint };
};

/** A run once serve has completed too. */
export type ServedState = SetupState & {
  edgeNonce: bigint;
  subscriptions: { edge: string };
  costs: { topUp: bigint; edge: bigint };
};

const missingOf = (fields: Record<string, unknown>): string[] => Object.keys(fields).filter((k) => fields[k] === undefined);

/** What a completed setup must have recorded and `s` has not. */
export const setupMissing = (s: SmokeState): string[] =>
  missingOf({
    E: s.E,
    tokenId: s.tokenId,
    stakeRaw: s.stakeRaw,
    stakeEpoch: s.stakeEpoch,
    accountId: s.accountId,
    accountExpiresAt: s.accountExpiresAt,
    buyerNonce: s.buyerNonce,
    'subscriptions.ca': s.subscriptions.ca,
    'subscriptions.wallet': s.subscriptions.wallet,
    'costs.ca': s.costs.ca,
  });

/** What a completed serve must have recorded and `s` has not. */
export const serveMissing = (s: SmokeState): string[] => missingOf({ edgeNonce: s.edgeNonce, 'subscriptions.edge': s.subscriptions.edge, 'costs.topUp': s.costs.topUp, 'costs.edge': s.costs.edge });

export const isSetup = (s: SmokeState): s is SetupState => setupMissing(s).length === 0;
export const isServed = (s: SetupState): s is ServedState => serveMissing(s).length === 0;

// ---------------------------------------------------------------------------
// Decoding: every field checked and typed where the file is loaded
// ---------------------------------------------------------------------------

type Obj = { readonly [key: string]: unknown };

function obj(x: unknown, where: string): Obj {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error(`state: ${where} is not an object`);
  return x as Obj;
}
function str(o: Obj, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new Error(`state: ${where}.${k} is not a string`);
  return v;
}
function optStr(o: Obj, k: string, where: string): string | undefined {
  return o[k] === undefined || o[k] === null ? undefined : str(o, k, where);
}
function bi(o: Obj, k: string, where: string): bigint {
  const v = o[k];
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  throw new Error(`state: ${where}.${k} is not an integer`);
}
function optBi(o: Obj, k: string, where: string): bigint | undefined {
  return o[k] === undefined || o[k] === null ? undefined : bi(o, k, where);
}
function optNum(o: Obj, k: string, where: string): number | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number') throw new Error(`state: ${where}.${k} is not a number`);
  return v;
}
function oneOf<T extends string>(o: Obj, k: string, values: readonly T[], where: string): T {
  const v = str(o, k, where);
  const found = values.find((x) => x === v);
  if (found === undefined) throw new Error(`state: ${where}.${k} is "${v}", not one of ${values.join(', ')}`);
  return found;
}

const AMOUNT_KEYS = ['stake', 'caValue', 'caTopUp', 'edgeValue', 'walletValue', 'keyEth', 'committed', 'committedFloor', 'lock', 'discountBps'] as const;

function optExpected(o: Obj, k: string, where: string): WithdrawalExpected | undefined {
  if (o[k] === undefined || o[k] === null) return undefined;
  const at = `${where}.${k}`;
  const r = obj(o[k], at);
  return { epoch: bi(r, 'epoch', at), raw: bi(r, 'raw', at), auto: bi(r, 'auto', at), score: bi(r, 'score', at) };
}

function decodeStep(x: unknown, where: string): StepRecord {
  const o = obj(x, where);
  return {
    status: oneOf(o, 'status', ['sent', 'mined'] as const, where),
    label: str(o, 'label', where),
    role: str(o, 'role', where),
    hash: str(o, 'hash', where),
    estimate: bi(o, 'estimate', where),
    gasLimit: bi(o, 'gasLimit', where),
    block: optNum(o, 'block', where),
    gasUsed: optBi(o, 'gasUsed', where),
    expected: optExpected(o, 'expected', where),
    stakeFactor18: optBi(o, 'stakeFactor18', where),
  };
}

export function decodeState(raw: unknown): SmokeState {
  const o = obj(raw, 'state');
  if (o.version !== 1) throw new Error('state: unknown version');
  const a = obj(o.addresses, 'addresses');
  const am = obj(o.amounts, 'amounts');
  const amounts = Object.fromEntries(AMOUNT_KEYS.map((k) => [k, bi(am, k, 'amounts')])) as Amounts;
  const subscriptions = obj(o.subscriptions ?? {}, 'subscriptions');
  const costs = obj(o.costs ?? {}, 'costs');
  const steps: Record<string, StepRecord> = {};
  for (const [k, v] of Object.entries(obj(o.steps ?? {}, 'steps'))) steps[k] = decodeStep(v, `steps.${k}`);
  const phases: SmokeState['phases'] = {};
  for (const [k, v] of Object.entries(obj(o.phases ?? {}, 'phases'))) {
    const p = obj(v, `phases.${k}`);
    const name = oneOf({ name: k }, 'name', PHASES, 'phases');
    const failedChecks = optNum(p, 'failedChecks', `phases.${k}`) ?? 0;
    const status = oneOf(p, 'status', ['done', 'failed'] as const, `phases.${k}`);
    phases[name] = { status: failedChecks > 0 ? 'failed' : status, failedChecks };
  }
  let withdrawal: Withdrawal | undefined;
  if (o.withdrawal !== undefined) {
    const w = obj(o.withdrawal, 'withdrawal');
    withdrawal = {
      epoch: bi(w, 'epoch', 'withdrawal'),
      node: bi(w, 'node', 'withdrawal'),
      recordedScore: bi(w, 'recordedScore', 'withdrawal'),
    };
  }
  let fork: SmokeState['fork'];
  if (o.fork !== undefined) {
    const f = obj(o.fork, 'fork');
    fork = { mirrorScore: optBi(f, 'mirrorScore', 'fork'), proofs: Array.isArray(f.proofs) ? f.proofs.map(String) : [] };
  }
  return {
    version: 1,
    run: str(o, 'run', 'state'),
    network: oneOf(o, 'network', ['fork', 'base-sepolia'] as const, 'state'),
    chainId: bi(o, 'chainId', 'state'),
    forkBlock: optBi(o, 'forkBlock', 'state'),
    hub: str(o, 'hub', 'state'),
    settlement: str(o, 'settlement', 'state'),
    startedAt: bi(o, 'startedAt', 'state'),
    addresses: {
      owner: str(a, 'owner', 'addresses'),
      buyer: str(a, 'buyer', 'addresses'),
      edgeBuyer: str(a, 'edgeBuyer', 'addresses'),
      caSession: str(a, 'caSession', 'addresses'),
      walletSession: str(a, 'walletSession', 'addresses'),
      edgeSession: str(a, 'edgeSession', 'addresses'),
      seller: str(a, 'seller', 'addresses'),
    },
    sellerId: bi(o, 'sellerId', 'state'),
    amounts,
    E: optBi(o, 'E', 'state'),
    tokenId: optBi(o, 'tokenId', 'state'),
    stakeRaw: optBi(o, 'stakeRaw', 'state'),
    stakeEpoch: optBi(o, 'stakeEpoch', 'state'),
    accountId: optBi(o, 'accountId', 'state'),
    accountExpiresAt: optBi(o, 'accountExpiresAt', 'state'),
    buyerNonce: optBi(o, 'buyerNonce', 'state'),
    edgeNonce: optBi(o, 'edgeNonce', 'state'),
    subscriptions: { ca: optStr(subscriptions, 'ca', 'subscriptions'), wallet: optStr(subscriptions, 'wallet', 'subscriptions'), edge: optStr(subscriptions, 'edge', 'subscriptions') },
    costs: { ca: optBi(costs, 'ca', 'costs'), topUp: optBi(costs, 'topUp', 'costs'), edge: optBi(costs, 'edge', 'costs') },
    withdrawal,
    fork,
    steps,
    phases,
  };
}

/** The state file, and the journal of the transactions the run sent. A dry run reads it and writes nothing. */
export class StateFile implements Journal {
  state?: SmokeState;

  constructor(
    readonly file: string,
    private readonly redactor: Redactor,
    private readonly readOnly: boolean,
  ) {}

  load(): SmokeState | undefined {
    this.state = fs.existsSync(this.file) ? decodeState(JSON.parse(fs.readFileSync(this.file, 'utf8'))) : undefined;
    return this.state;
  }

  save(): void {
    if (this.state && !this.readOnly) writeJson(this.file, toJson(this.state), this.redactor);
  }

  /** The state, which must exist. */
  get s(): SmokeState {
    if (!this.state) throw new Error(`${this.file} is missing: run PHASE=setup SEND=1 first`);
    return this.state;
  }

  get(key: string): StepRecord | undefined {
    return this.state?.steps[key];
  }

  put(key: string, record: StepRecord): void {
    if (!this.state) return;
    this.state.steps[key] = record;
    this.save();
  }

  done(phase: PhaseName): boolean {
    return this.state?.phases[phase]?.status === 'done';
  }

  /** How many checks failed when the phase last ran to its end, if any did. */
  failedChecks(phase: PhaseName): number {
    const p = this.state?.phases[phase];
    return p?.status === 'failed' ? p.failedChecks : 0;
  }

  /** The phase ran to its end, with this many failed checks: with any, it is not done, and is run again. */
  finish(phase: PhaseName, failedChecks: number): void {
    if (!this.state) return;
    this.state.phases[phase] = { status: failedChecks > 0 ? 'failed' : 'done', failedChecks };
    this.save();
  }

  /** What the file holds, as JSON, for a results file. */
  snapshot(): JsonObject {
    return (this.state ? toJson(this.state) : {}) as JsonObject;
  }
}
