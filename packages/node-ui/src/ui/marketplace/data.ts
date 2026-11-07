// The marketplace section's one data source. Today every read resolves from
// fixtures (fixtures.ts); a later step replaces this module's body with calls
// to the node API and leaves the views alone. Nothing here talks to a node, a
// wallet or a chain, and no purchase is ever sent.
import {
  fixtureCatalog, fixtureOperateStatus, fixturePlanStatus, FIXTURE_OPS_WALLET, FIXTURE_SCENARIOS,
  type FixtureScenario,
} from './fixtures.js';
import type { Catalog, OperateStatus, PlanStatus, PurchaseIntent } from './types.js';

/** What the section reads. Each call is one screen's worth of data. */
export interface MarketplaceData {
  /** Every provider's offers, the buyer's meters and the reference rate. */
  catalog(): Promise<Catalog>;
  /** The buyer's plan: meters, recent activity, access keys, any open purchase. */
  planStatus(): Promise<PlanStatus>;
  /** This node as a seller: offerings and asks, subscribers, wallets. */
  operateStatus(): Promise<OperateStatus>;
  /** The node's operations wallet (gas and publishing), never a purchase wallet. */
  operationsWallet(): Promise<string | null>;
  /** A purchase drafted for the next period, if one exists. */
  nextPeriodDraft(): Promise<PurchaseIntent | null>;
}

/** A refusal in the node's error shape: plain words come from the code. */
export class MarketplaceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;
  readonly retryable: boolean;
  readonly body: unknown;
  constructor(status: number, body: { error?: string; code?: string; detail?: unknown; retryable?: boolean }) {
    const code = body.code ?? body.error ?? `HTTP_${status}`;
    super(body.error ?? code);
    this.name = 'MarketplaceError';
    this.status = status;
    this.code = code;
    this.detail = body.detail;
    this.retryable = body.retryable ?? (status === 0 || status >= 500);
    this.body = body;
  }
}

export const isMarketplaceError = (e: unknown): e is MarketplaceError => e instanceof MarketplaceError;

/** Development switch between the fixture states (localStorage key). */
export const FIXTURE_SCENARIO_KEY = 'dkg-marketplace-fixture';

export function fixtureScenario(): FixtureScenario {
  try {
    const raw = localStorage.getItem(FIXTURE_SCENARIO_KEY);
    if (raw && (FIXTURE_SCENARIOS as readonly string[]).includes(raw)) return raw as FixtureScenario;
  } catch { /* storage unavailable: use the default */ }
  return 'plan-active';
}

const resolved = <T>(value: T): Promise<T> => Promise.resolve(value);

export function fixtureData(scenario: () => FixtureScenario = fixtureScenario, now: () => number = Date.now): MarketplaceData {
  return {
    catalog: () => resolved(fixtureCatalog(now(), scenario())),
    planStatus: () => resolved(fixturePlanStatus(scenario(), now())),
    operateStatus: () => resolved(fixtureOperateStatus(now())),
    operationsWallet: () => resolved(FIXTURE_OPS_WALLET),
    nextPeriodDraft: () => resolved(null),
  };
}

export const marketplaceData: MarketplaceData = fixtureData();

/** Every action control in this step: visible and enabled, and it does nothing. */
export const noAction = (..._args: unknown[]): void => undefined;
