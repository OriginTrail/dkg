// The smoke test's run state: cache/rfc27-smoke/<run>.json, which git
// ignores. Ids, epochs, addresses and transaction hashes, never a key, bound
// to the network it ran on. Numeric fields are kept as decimal strings in the
// file and decoded to bigint where it is loaded.

import * as fs from 'fs';

import { JsonObject, Redactor, toJson, writeJson } from '../report';
import type { Journal, StepRecord } from './tx';

export const PHASES = ['check', 'setup', 'serve', 'finalize', 'close-claim', 'withdraw'] as const;
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

export type RefStatus = 'finalized' | 'finalized by another caller' | 'waiting on the seller' | 'void' | 'skipped';
/** A seller's claim in one bucket of one period, and what became of it. */
export type RefRecord = { subscriptionId: string; bucketIndex: bigint; seller: bigint; period: string; status?: RefStatus; reason?: string; value?: bigint };

export type Withdrawal = { epoch: bigint; node: bigint; recordedScore: bigint; ownerTracAfter: bigint; block?: number; claimed: boolean };

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
  /** The epoch of the run's periods. */
  E?: bigint;
  tokenId?: bigint;
  stakeRaw?: bigint;
  stakeEpoch?: bigint;
  accountId?: bigint;
  accountExpiresAt?: bigint;
  buyerNonce?: bigint;
  edgeNonce?: bigint;
  periods: { ca?: string; wallet?: string; edge?: string };
  costs: { ca?: bigint; topUp?: bigint; edge?: bigint };
  refs?: RefRecord[];
  finalizedValue?: bigint;
  withdrawal?: Withdrawal;
  /** Fork-only: the score each stand-in proof writes, and the epochs that have one. */
  fork?: { mirrorScore?: bigint; proofs: string[] };
  steps: Record<string, StepRecord>;
  phases: Partial<Record<PhaseName, { status: 'done'; failedChecks: number }>>;
};

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
const REF_STATUSES: readonly RefStatus[] = ['finalized', 'finalized by another caller', 'waiting on the seller', 'void', 'skipped'];

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
  };
}

export function decodeState(raw: unknown): SmokeState {
  const o = obj(raw, 'state');
  if (o.version !== 1) throw new Error('state: unknown version');
  const a = obj(o.addresses, 'addresses');
  const am = obj(o.amounts, 'amounts');
  const amounts = Object.fromEntries(AMOUNT_KEYS.map((k) => [k, bi(am, k, 'amounts')])) as Amounts;
  const periods = obj(o.periods ?? {}, 'periods');
  const costs = obj(o.costs ?? {}, 'costs');
  const steps: Record<string, StepRecord> = {};
  for (const [k, v] of Object.entries(obj(o.steps ?? {}, 'steps'))) steps[k] = decodeStep(v, `steps.${k}`);
  const phases: SmokeState['phases'] = {};
  for (const [k, v] of Object.entries(obj(o.phases ?? {}, 'phases'))) {
    const p = obj(v, `phases.${k}`);
    const name = oneOf({ name: k }, 'name', PHASES, 'phases');
    phases[name] = { status: oneOf(p, 'status', ['done'] as const, `phases.${k}`), failedChecks: optNum(p, 'failedChecks', `phases.${k}`) ?? 0 };
  }
  const refs = o.refs === undefined ? undefined : (Array.isArray(o.refs) ? o.refs : []).map((x, i): RefRecord => {
    const r = obj(x, `refs[${i}]`);
    const status = r.status === undefined ? undefined : oneOf(r, 'status', REF_STATUSES, `refs[${i}]`);
    return {
      subscriptionId: str(r, 'subscriptionId', `refs[${i}]`),
      bucketIndex: bi(r, 'bucketIndex', `refs[${i}]`),
      seller: bi(r, 'seller', `refs[${i}]`),
      period: str(r, 'period', `refs[${i}]`),
      status,
      reason: optStr(r, 'reason', `refs[${i}]`),
      value: optBi(r, 'value', `refs[${i}]`),
    };
  });
  let withdrawal: Withdrawal | undefined;
  if (o.withdrawal !== undefined) {
    const w = obj(o.withdrawal, 'withdrawal');
    withdrawal = {
      epoch: bi(w, 'epoch', 'withdrawal'),
      node: bi(w, 'node', 'withdrawal'),
      recordedScore: bi(w, 'recordedScore', 'withdrawal'),
      ownerTracAfter: bi(w, 'ownerTracAfter', 'withdrawal'),
      block: optNum(w, 'block', 'withdrawal'),
      claimed: w.claimed === true,
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
    periods: { ca: optStr(periods, 'ca', 'periods'), wallet: optStr(periods, 'wallet', 'periods'), edge: optStr(periods, 'edge', 'periods') },
    costs: { ca: optBi(costs, 'ca', 'costs'), topUp: optBi(costs, 'topUp', 'costs'), edge: optBi(costs, 'edge', 'costs') },
    refs,
    finalizedValue: optBi(o, 'finalizedValue', 'state'),
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

  /** The phase completed, with this many failed checks. */
  markDone(phase: PhaseName, failedChecks: number): void {
    if (!this.state) return;
    this.state.phases[phase] = { status: 'done', failedChecks };
    this.save();
  }

  /** What the file holds, as JSON, for a results file. */
  snapshot(): JsonObject {
    return (this.state ? toJson(this.state) : {}) as JsonObject;
  }
}
