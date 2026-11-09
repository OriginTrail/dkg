// SPDX-License-Identifier: Apache-2.0

/**
 * The standing plan: what the node funds each epoch, from which source, and
 * until which epoch. The user confirms it once; the node then funds every
 * epoch through `renewUntilEpoch` from it (OT-RFC-27).
 *
 * In its wire form, as `GET` and `PUT /api/marketplace/plan` carry it, amounts
 * are decimal strings of TRAC wei and the class is `inference` or `query`.
 */
import { ethers } from 'ethers';
import { SERVICE_CLASS_INFERENCE, SERVICE_CLASS_QUERY, type ServiceBudget } from '@origintrail-official/dkg-chain';

export type FundingSource = { kind: 'wallet' } | { kind: 'account'; accountId: bigint };

/** One service of a plan or a funding: its budget for one epoch. */
export interface PlannedService {
  serviceId: string;
  serviceClass: number;
  /** TRAC wei, before an account's discount. */
  value: bigint;
  maxPricePerUnit: bigint;
  /** A seller the router tries first. */
  pinnedSeller?: bigint;
}

export interface StandingPlan {
  services: PlannedService[];
  source: FundingSource;
  /** When true, the node funds each epoch on its own, through `renewUntilEpoch`. */
  renew: boolean;
  /** The last epoch the node funds; required when `renew` is true. */
  renewUntilEpoch?: number;
}

export interface PlannedServiceWire {
  serviceId: string;
  serviceClass: 'inference' | 'query';
  value: string;
  maxPricePerUnit: string;
  pinnedSeller?: number;
}

export type FundingSourceWire = { kind: 'wallet' } | { kind: 'account'; accountId: string };

export interface StandingPlanWire {
  services: PlannedServiceWire[];
  source: FundingSourceWire;
  renew: boolean;
  renewUntilEpoch?: number;
}

/** A plan, a source or services the node cannot accept, with the reason. */
export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

const UINT96_MAX = (1n << 96n) - 1n;

/** A wei amount from the wire: a decimal string, above 0 and within 96 bits. */
export function parseWei(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new PlanError(`${field} must be a decimal string of wei`);
  const wei = BigInt(value);
  if (wei === 0n || wei > UINT96_MAX) throw new PlanError(`${field} must be above 0 and fit 96 bits`);
  return wei;
}

export function parseSource(raw: unknown): FundingSource {
  const source = raw as { kind?: unknown; accountId?: unknown } | undefined;
  if (source?.kind === 'wallet') return { kind: 'wallet' };
  if (source?.kind === 'account' && typeof source.accountId === 'string' && /^[1-9]\d*$/.test(source.accountId)) {
    return { kind: 'account', accountId: BigInt(source.accountId) };
  }
  throw new PlanError("source must be { kind: 'wallet' } or { kind: 'account', accountId }");
}

/** Services from the wire, sorted by `serviceId` as the contracts require, each id once. */
export function parseServices(raw: unknown): PlannedService[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new PlanError('services must be a non-empty array');
  const services = raw.map((entry: Partial<PlannedServiceWire> | undefined, i): PlannedService => {
    if (typeof entry?.serviceId !== 'string' || !ethers.isHexString(entry.serviceId, 32)) {
      throw new PlanError(`services[${i}].serviceId must be a 32-byte hex string`);
    }
    if (entry.serviceClass !== 'inference' && entry.serviceClass !== 'query') {
      throw new PlanError(`services[${i}].serviceClass must be inference or query`);
    }
    const pinned = entry.pinnedSeller;
    if (pinned !== undefined && (!Number.isSafeInteger(pinned) || pinned <= 0)) {
      throw new PlanError(`services[${i}].pinnedSeller must be a positive identity id`);
    }
    return {
      serviceId: entry.serviceId.toLowerCase(),
      serviceClass: entry.serviceClass === 'inference' ? SERVICE_CLASS_INFERENCE : SERVICE_CLASS_QUERY,
      value: parseWei(entry.value, `services[${i}].value`),
      maxPricePerUnit: parseWei(entry.maxPricePerUnit, `services[${i}].maxPricePerUnit`),
      ...(pinned !== undefined ? { pinnedSeller: BigInt(pinned) } : {}),
    };
  });
  services.sort((a, b) => (BigInt(a.serviceId) < BigInt(b.serviceId) ? -1 : 1));
  for (let i = 1; i < services.length; i++) {
    if (services[i]!.serviceId === services[i - 1]!.serviceId) throw new PlanError(`service ${services[i]!.serviceId} is listed twice`);
  }
  return services;
}

export function parsePlan(raw: unknown): StandingPlan {
  const plan = raw as Partial<StandingPlanWire> | undefined;
  if (typeof plan?.renew !== 'boolean') throw new PlanError('renew must be true or false');
  const until = plan.renewUntilEpoch;
  if (until !== undefined && (!Number.isSafeInteger(until) || until <= 0)) {
    throw new PlanError('renewUntilEpoch must be a positive epoch');
  }
  if (plan.renew && until === undefined) throw new PlanError('a plan that renews needs renewUntilEpoch, the last epoch to fund');
  return {
    services: parseServices(plan.services),
    source: parseSource(plan.source),
    renew: plan.renew,
    ...(until !== undefined ? { renewUntilEpoch: until } : {}),
  };
}

/** `current`, `next` or an epoch's number, against the chain's current epoch. */
export function parseEpoch(raw: unknown, current: number): number {
  if (raw === 'current') return current;
  if (raw === 'next') return current + 1;
  const epoch = typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : raw;
  if (typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch > 0) return epoch;
  throw new PlanError('epoch must be current, next or an epoch number');
}

export function sourceToWire(source: FundingSource): FundingSourceWire {
  return source.kind === 'wallet' ? { kind: 'wallet' } : { kind: 'account', accountId: source.accountId.toString() };
}

export function serviceToWire(service: PlannedService): PlannedServiceWire {
  return {
    serviceId: service.serviceId,
    serviceClass: service.serviceClass === SERVICE_CLASS_INFERENCE ? 'inference' : 'query',
    value: service.value.toString(),
    maxPricePerUnit: service.maxPricePerUnit.toString(),
    ...(service.pinnedSeller !== undefined ? { pinnedSeller: Number(service.pinnedSeller) } : {}),
  };
}

export function planToWire(plan: StandingPlan): StandingPlanWire {
  return {
    services: plan.services.map(serviceToWire),
    source: sourceToWire(plan.source),
    renew: plan.renew,
    ...(plan.renewUntilEpoch !== undefined ? { renewUntilEpoch: plan.renewUntilEpoch } : {}),
  };
}

/** The budgets the contracts take, in strictly increasing `serviceId`. */
export function budgetsOf(services: readonly PlannedService[]): ServiceBudget[] {
  return [...services]
    .sort((a, b) => (BigInt(a.serviceId) < BigInt(b.serviceId) ? -1 : 1))
    .map(({ serviceId, serviceClass, value, maxPricePerUnit }) => ({ serviceId, serviceClass, value, maxPricePerUnit }));
}

export function valueOf(services: readonly { value: bigint }[]): bigint {
  return services.reduce((total, s) => total + s.value, 0n);
}

/** The commitment a subscription's `planDigest` makes: the buyer's budgets in the epoch, as keccak256 of their terms. */
export function planDigestOf(epoch: number, buyer: string, budgets: readonly ServiceBudget[]): string {
  return ethers.id(JSON.stringify({
    epoch,
    buyer: ethers.getAddress(buyer),
    budgets: budgets.map((b) => [b.serviceId.toLowerCase(), String(b.serviceClass), b.value.toString(), b.maxPricePerUnit.toString()]),
  }));
}
