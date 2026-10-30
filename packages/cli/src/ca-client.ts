// SPDX-License-Identifier: Apache-2.0

/**
 * The daemon API client of Conviction Account service spending (OT-RFC-27):
 * `ApiClient.ca`, one method per /api/ca route, with the wire types of its
 * answers.
 *
 * - Inputs: caps and bucket values are decimal TRAC strings, `expiresAt` an
 *   ISO-8601 time with its zone, `maxAskWeiPerUnit` wei.
 * - Answers: amounts are decimal strings of wei, each with a `…Trac` sibling
 *   for display, except the signed `terms` of a consent, which travel exactly
 *   as they were signed: a consent answer is itself a valid `assign` body.
 * - An error answer throws the client's HTTP error, whose `responseBody`
 *   holds the route's body: `error` is the revert's name for a contract
 *   refusal (`args` its arguments), or a message with a `code`.
 */
import { randomBytes } from 'node:crypto';

/** A decimal string of TRAC wei. */
export type CaWei = string;

export interface CaDomainWire {
  name: 'DKGConvictionServices';
  version: '1';
  chainId: number;
  /** The ServiceSubscriptions contract. */
  verifyingContract: string;
}

export interface CaContractsResponse {
  serviceSubscriptions: string;
  convictionServiceStorage: string;
  publishingConviction: string;
  logicVersion: string;
  domain: CaDomainWire;
  primaryType: 'ServiceAssignment';
  /** The EIP-712 types of the consent, for signing away from the node. */
  types: Record<string, Array<{ name: string; type: string }>>;
}

export interface CaCapsWire {
  maxCostPerPeriod: CaWei; maxCostPerPeriodTrac: string;
  maxInferenceCostPerPeriod: CaWei; maxInferenceCostPerPeriodTrac: string;
  maxQueryCostPerPeriod: CaWei; maxQueryCostPerPeriodTrac: string;
  /** 0: no window cap. */
  maxCostPerWindow: CaWei; maxCostPerWindowTrac: string;
  maxTotalCost: CaWei; maxTotalCostTrac: string;
  maxPeriodSeconds: number;
  /** Unix seconds. */
  expiresAt: number;
}

export interface CaUsageWire {
  totalCost: CaWei; totalCostTrac: string;
  windowCost: CaWei; windowCostTrac: string;
  window: number;
  periods: number;
}

export interface CaAssignmentWire extends CaCapsWire {
  assignee: string;
  assignedAt: number;
  /** 0: not revoked. */
  revokedAt: number;
  /** The account nonce the assignment consumed. */
  nonce: string;
  /** Assigned, not revoked and not expired. */
  active: boolean;
  usage: CaUsageWire;
}

export interface CaStatusResponse {
  accountId: string;
  owner: string;
  /** The node's primary wallet owns the account, so it can drive the owner's writes. */
  ownedByNode: boolean;
  /** The node's buyer key, or null when it holds no signer for it. */
  buyerKey: string | null;
  logicVersion: string;
  serviceSpending: { enabled: boolean; enabledAt: number };
  discountBps: number;
  lockDurationEpochs: number;
  expiresAtTimestamp: number;
  window: {
    index: number;
    baseAllowance: CaWei; baseAllowanceTrac: string;
    baseRemaining: CaWei; baseRemainingTrac: string;
    topUpBuffer: CaWei; topUpBufferTrac: string;
    expired: boolean;
  };
  schedule: { exact: boolean; firstEpoch: number; lastEpoch: number };
  labels: { total: CaWei; totalTrac: string; cursor: number; remainingBaseCapacity: CaWei; remainingBaseCapacityTrac: string };
  assignments: { count: number; active: number };
  treasuryWired: boolean;
}

/** Signed terms: the ten fields of the EIP-712 `ServiceAssignment`, amounts in wei. */
export interface CaTermsWire {
  accountId: string;
  assignee: string;
  maxCostPerPeriod: CaWei;
  maxInferenceCostPerPeriod: CaWei;
  maxQueryCostPerPeriod: CaWei;
  maxCostPerWindow: CaWei;
  maxTotalCost: CaWei;
  maxPeriodSeconds: number;
  expiresAt: number;
  nonce: string;
}

/**
 * The caps a buyer key consents to. The inference and query caps default to
 * the period cap, the window cap to 0 (no window cap), `maxPeriodSeconds` to
 * 31 days, `nonce` to `"auto"`: the account's current one.
 */
export interface CaConsentInput {
  maxCostPerPeriod: string;
  maxTotalCost: string;
  /** ISO-8601 with its zone, such as `2026-11-30T00:00:00Z`. */
  expiresAt: string;
  maxInferenceCostPerPeriod?: string;
  maxQueryCostPerPeriod?: string;
  maxCostPerWindow?: string;
  maxPeriodSeconds?: number;
  nonce?: 'auto' | string;
}

export interface CaConsentResponse {
  terms: CaTermsWire;
  digest: string;
  assigneeSignature: string;
  domain: CaDomainWire;
}

/**
 * An assignment to submit: the owner node sends it with the assignee's
 * signature, the assignee node with the owner's. A consent answer is one as
 * it is; its `domain` and `digest` are checked against the node's chain.
 */
export interface CaAssignInput {
  terms: CaTermsWire;
  assigneeSignature?: string;
  ownerSignature?: string;
  digest?: string;
  domain?: CaDomainWire;
}

export interface CaTxWire {
  txHash: string;
  blockNumber: number;
}

export interface CaAssignResponse extends CaTxWire {
  accountId: string;
  assignee: string;
  digest: string;
  sentAs: 'owner' | 'assignee';
}

/** New caps in TRAC, as in a consent; fields left out keep their stored values. */
export type CaCapsInput = Partial<Omit<CaConsentInput, 'nonce'>>;

export interface CaCapsResponse extends Partial<CaTxWire> {
  accountId: string;
  assignee: string;
  /** The caps equal the stored ones: nothing was sent, and there is no transaction. */
  unchanged: boolean;
  caps: CaCapsWire;
  usage: CaUsageWire;
}

export interface CaLabelWire {
  epoch: number;
  scheduled: CaWei; scheduledTrac: string;
  baseLabel: CaWei; baseLabelTrac: string;
  topUpLabel: CaWei; topUpLabelTrac: string;
  serviceLabel: CaWei; serviceLabelTrac: string;
  pool: CaWei; poolTrac: string;
}

export interface CaBucketWire {
  bucketId: string;
  serviceClass: 'inference' | 'query';
  value: CaWei;
  valueTrac: string;
  maxAskWeiPerUnit: CaWei;
}

export interface CaPeriodWire {
  subscriptionId: string;
  accountId: string;
  assignee: string;
  periodId: string;
  sessionKey: string;
  planDigest: string;
  periodStart: number;
  periodEnd: number;
  fundedEpoch: number;
  fundedWindow: number;
  discountBps: number;
  value: CaWei; valueTrac: string;
  cost: CaWei; costTrac: string;
  drawnFromWindow: CaWei; drawnFromWindowTrac: string;
  drawnFromTopUp: CaWei; drawnFromTopUpTrac: string;
  buckets: CaBucketWire[];
}

/** A plan period to fund: bucket values in TRAC, `maxAskWeiPerUnit` in wei, `bucketId`s ascending. */
export interface CaFundingPlan {
  /** The period's idempotency key; the client chooses one when it is left out. */
  periodId?: string;
  periodSeconds: number;
  /** The zero address when left out. */
  sessionKey?: string;
  planDigest: string;
  buckets: Array<{ bucketId: string; serviceClass: 'inference' | 'query'; value: string; maxAskWeiPerUnit: string }>;
}

export interface CaFundingResponse extends CaPeriodWire, CaTxWire {
  /** Index of the PeriodFunded log in its block. */
  logIndex: number;
  /** The period was already funded under this buyer key and periodId: nothing was sent. */
  existing: boolean;
}

export interface CaMineResponse {
  /** The node's primary wallet. */
  owner: string | null;
  buyerKey: string | null;
  owned: Array<{ accountId: string }>;
  assigned: Array<{ accountId: string } & CaAssignmentWire>;
}

/** A fresh random period id: 32 bytes of hex. */
export function newCaPeriodId(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

type Deadline = { timeoutMs?: number; outcomeUnknownHint?: string };

export interface CaClientTransport {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown, deadline?: Deadline): Promise<T>;
  del<T>(path: string): Promise<T>;
}

type AccountId = string | number | bigint;

function query(params: Record<string, number | undefined> = {}): string {
  const entries = Object.entries(params).filter((entry): entry is [string, number] => entry[1] !== undefined);
  return entries.length === 0 ? '' : `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
}

export function createCaClient(http: CaClientTransport) {
  const account = (id: AccountId): string => `/api/ca/${encodeURIComponent(String(id))}`;
  const assignment = (id: AccountId, assignee: string): string => `${account(id)}/assignments/${encodeURIComponent(assignee)}`;
  return {
    contracts: () => http.get<CaContractsResponse>('/api/ca/contracts'),
    /** The accounts the node's primary wallet owns, and those its buyer key is assigned on. */
    mine: () => http.get<CaMineResponse>('/api/ca/mine'),
    /** The status, read fresh. */
    status: (id: AccountId) => http.get<CaStatusResponse>(account(id)),
    /** Owner node: switch service spending on or off. */
    setServices: (id: AccountId, enabled: boolean) =>
      http.post<{ accountId: string; enabled: boolean } & CaTxWire>(`${account(id)}/services`, { enabled }),
    /** Assignee node: sign the terms with the buyer key; nothing is sent. */
    consent: (id: AccountId, input: CaConsentInput) => http.post<CaConsentResponse>(`${account(id)}/consent`, input),
    /** Owner node with the assignee's signature, or assignee node with the owner's. */
    assign: (id: AccountId, body: CaAssignInput) => http.post<CaAssignResponse>(`${account(id)}/assignments`, body, {
      outcomeUnknownHint: `Check GET ${account(id)}/assignments before retrying.`,
    }),
    assignments: (id: AccountId) => http.get<{ accountId: string; assignments: CaAssignmentWire[] }>(`${account(id)}/assignments`),
    /** Owner node: revoke an assignment; it advances the nonce. */
    revoke: (id: AccountId, assignee: string) =>
      http.del<{ accountId: string; assignee: string; revoked: true; nextNonce: string } & CaTxWire>(assignment(id, assignee)),
    /** Owner node: change an assignment's caps; a retry is safe, as equal caps send nothing. */
    updateCaps: (id: AccountId, assignee: string, caps: CaCapsInput) => http.post<CaCapsResponse>(`${assignment(id, assignee)}/caps`, caps),
    /** Owner node: advance the assignment nonce, so terms signed and not submitted no longer assign. */
    advanceNonce: (id: AccountId) => http.post<{ accountId: string; nextNonce: string } & CaTxWire>(`${account(id)}/nonce`, {}),
    /** Labels per epoch, at most 120; by default the first epochs of the account's span. */
    labels: (id: AccountId, range: { from?: number; to?: number } = {}) =>
      http.get<{ accountId: string; cursor: number; from: number; to: number; epochs: CaLabelWire[] }>(`${account(id)}/labels${query(range)}`),
    periods: (id: AccountId, page: { offset?: number; limit?: number } = {}) =>
      http.get<{ accountId: string; total: number; offset: number; limit: number; periods: CaPeriodWire[] }>(`${account(id)}/periods${query(page)}`),
    /**
     * Assignee node: fund a plan period with the buyer key. The period id is
     * the plan's, or one the client chooses, so that a request whose answer
     * was lost can be repeated with it: a funded period is answered with
     * `existing: true`, and nothing is sent.
     */
    fund: (id: AccountId, plan: CaFundingPlan) => {
      const periodId = plan.periodId ?? newCaPeriodId();
      return http.post<CaFundingResponse>(`${account(id)}/periods`, { ...plan, periodId }, {
        outcomeUnknownHint: `The period may have been funded: repeat with periodId ${periodId}, which answers it without funding it again.`,
      });
    },
  };
}

export type CaClient = ReturnType<typeof createCaClient>;
