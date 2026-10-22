// SPDX-License-Identifier: Apache-2.0

/**
 * Conviction Account service spending (OT-RFC-27) on the EVM adapter.
 *
 * Mixin holder in the pattern of `evm-adapter-conviction.ts`: it extends
 * `EVMChainAdapterBase` for the shared state and plumbing, and `evm-adapter.ts`
 * assembles it into `EVMChainAdapter` with `applyMixins`.
 *
 * - `ServiceSubscriptions` and `ConvictionServiceStorage` are resolved from the
 *   Hub on every call; every path here is cold. Without them every method
 *   throws `ConvictionServiceUnavailableError`, and
 *   `getConvictionServiceContracts` answers `null`.
 * - The owner's writes are sent by the primary operational wallet. The buyer
 *   key, which consents and funds as the assignee, is
 *   `convictionServiceBuyerAddress` when configured, else the primary wallet.
 * - Every write runs under the Hub self-heal retry with custom-error
 *   enrichment, as the Publishing Conviction writes do, and invalidates the
 *   account's cached Publishing Conviction info: a funding draws its allowance.
 * - Reverts are thrown as `ConvictionServiceRevertError`. Reads of an unknown
 *   account answer `null`.
 */

import { ethers, type Contract } from 'ethers';
import { EVMChainAdapterBase } from './evm-adapter-base.js';
import type { TxResult } from './chain-adapter.js';
import type { EvmSigner } from './evm-signer.js';
import { loadAbi } from './evm-adapter-abi.js';
import { getPcaLogicInterface } from './evm-adapter-errors.js';
import {
  SERVICE_ASSIGNMENT_TYPES,
  assignmentCapsArg,
  assignmentTermsArg,
  consentSignatureArg,
  convictionServiceDomain,
  fundingRequestArg,
  requireAccountId,
  requireAddress,
  requireBytes32,
  requireLabelRange,
  requirePeriodPage,
  serviceAssignmentDigest,
  serviceSubscriptionIdOf,
  type CaAssignment,
  type CaAssignmentCaps,
  type CaAssignmentTerms,
  type CaBucket,
  type CaContracts,
  type CaEpochLabel,
  type CaFundingRequest,
  type CaPeriod,
  type CaPeriodFunding,
  type CaServiceClass,
  type CaServiceStatus,
  type CaWindowAllowance,
} from './conviction-service.js';
import {
  ConvictionServiceInputError,
  ConvictionServiceRevertError,
  ConvictionServiceUnavailableError,
  convictionServiceErrorOf,
  isConvictionServiceRevertError,
  isConvictionServiceUnavailableError,
} from './conviction-service-errors.js';

let serviceSubscriptionsInterface: ethers.Interface | null = null;

/** Lazily cached `ethers.Interface` over the `ServiceSubscriptions` ABI. */
export function getServiceSubscriptionsInterface(): ethers.Interface {
  serviceSubscriptionsInterface ??= new ethers.Interface(loadAbi('ServiceSubscriptions') as ethers.InterfaceAbi);
  return serviceSubscriptionsInterface;
}

type ReceiptLog = { address: string; topics: ReadonlyArray<string>; data: string; index: number };

/** The first log of `name` that `emitter` emitted, decoded with the `ServiceSubscriptions` ABI. */
function findServiceSubscriptionsLog(
  logs: ReadonlyArray<ReceiptLog>,
  emitter: string,
  name: string,
): ethers.LogDescription | null {
  const iface = getServiceSubscriptionsInterface();
  const topic = iface.getEvent(name)!.topicHash;
  for (const log of logs) {
    if (log.topics[0] !== topic || log.address.toLowerCase() !== emitter.toLowerCase()) continue;
    return iface.parseLog({ topics: [...log.topics], data: log.data });
  }
  return null;
}

function bucketOf(raw: ArrayLike<unknown>): CaBucket {
  return {
    bucketId: String(raw[0]).toLowerCase(),
    serviceClass: Number(raw[1]) as CaServiceClass,
    value: BigInt(raw[2] as bigint),
    maxAskWeiPerUnit: BigInt(raw[3] as bigint),
  };
}

/**
 * The period a funding receipt records: its `PeriodFunded` log, emitted by
 * `serviceSubscriptions` with `subscriptionId` as its first topic, and the
 * draw split of the `ServiceCostCovered` log `PublishingConviction` emitted
 * under the same id. `null` when the receipt lacks either.
 */
export function decodeServicePeriodFunding(
  logs: ReadonlyArray<ReceiptLog>,
  serviceSubscriptions: string,
  subscriptionId: string,
): { period: CaPeriod; logIndex: number } | null {
  const ssIface = getServiceSubscriptionsInterface();
  const pcIface = getPcaLogicInterface();
  const fundedTopic = ssIface.getEvent('PeriodFunded')!.topicHash;
  const coveredTopic = pcIface.getEvent('ServiceCostCovered')!.topicHash;
  const id = subscriptionId.toLowerCase();
  const funded = logs.find((log) => log.topics[0] === fundedTopic && log.topics[1]?.toLowerCase() === id
    && log.address.toLowerCase() === serviceSubscriptions.toLowerCase());
  const covered = logs.find((log) => log.topics[0] === coveredTopic && log.topics[3]?.toLowerCase() === id);
  if (!funded || !covered) return null;
  const f = ssIface.parseLog({ topics: [...funded.topics], data: funded.data })!.args;
  const c = pcIface.parseLog({ topics: [...covered.topics], data: covered.data })!.args;
  return {
    logIndex: funded.index,
    period: {
      subscriptionId: id,
      accountId: BigInt(f.accountId),
      assignee: ethers.getAddress(f.assignee),
      sessionKey: ethers.getAddress(f.sessionKey),
      periodId: String(f.periodId).toLowerCase(),
      planDigest: String(f.planDigest).toLowerCase(),
      periodStart: Number(f.periodStart),
      periodEnd: Number(f.periodEnd),
      fundedEpoch: Number(c.epoch),
      fundedWindow: Number(c.window),
      discountBps: Number(f.discountBps),
      value: BigInt(f.value),
      cost: BigInt(f.cost),
      drawnFromWindow: BigInt(c.drawnFromWindow),
      drawnFromTopUp: BigInt(c.drawnFromTopUp),
      buckets: Array.from(f.buckets as ArrayLike<ArrayLike<unknown>>, bucketOf),
    },
  };
}

/** `ConvictionServiceStorage.getSubscription` and `getBuckets` as a period. */
export function servicePeriodOf(subscriptionId: string, raw: ArrayLike<unknown>, buckets: ArrayLike<ArrayLike<unknown>>): CaPeriod {
  return {
    subscriptionId: subscriptionId.toLowerCase(),
    accountId: BigInt(raw[0] as bigint),
    assignee: ethers.getAddress(String(raw[1])),
    sessionKey: ethers.getAddress(String(raw[2])),
    periodId: String(raw[3]).toLowerCase(),
    planDigest: String(raw[4]).toLowerCase(),
    periodStart: Number(raw[5]),
    periodEnd: Number(raw[6]),
    fundedEpoch: Number(raw[7]),
    fundedWindow: Number(raw[8]),
    discountBps: Number(raw[9]),
    value: BigInt(raw[11] as bigint),
    cost: BigInt(raw[12] as bigint),
    drawnFromWindow: BigInt(raw[13] as bigint),
    drawnFromTopUp: BigInt(raw[14] as bigint),
    buckets: Array.from(buckets, bucketOf),
  };
}

function assignmentOf(
  assignee: string,
  a: ArrayLike<unknown>,
  u: ArrayLike<unknown>,
  active: boolean,
): { assignee: string } & CaAssignment {
  return {
    assignee,
    maxCostPerPeriod: BigInt(a[0] as bigint),
    maxInferenceCostPerPeriod: BigInt(a[1] as bigint),
    maxQueryCostPerPeriod: BigInt(a[2] as bigint),
    maxCostPerWindow: BigInt(a[3] as bigint),
    maxTotalCost: BigInt(a[4] as bigint),
    maxPeriodSeconds: Number(a[5]),
    assignedAt: Number(a[6]),
    expiresAt: Number(a[7]),
    revokedAt: Number(a[8]),
    nonce: BigInt(a[9] as bigint),
    active,
    usage: {
      totalCost: BigInt(u[0] as bigint),
      windowCost: BigInt(u[1] as bigint),
      window: Number(u[2]),
      periods: Number(u[3]),
    },
  };
}

function txResultOf(receipt: ethers.TransactionReceipt): TxResult {
  return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: receipt.status === 1 };
}

/** The account fields service spending reads, from the NFT's `ownerOf` and `accounts`. */
interface ConvictionServiceAccount {
  owner: string;
  committedTRAC: bigint;
  createdAtTimestamp: number;
  expiresAtTimestamp: number;
  lockDurationEpochs: number;
  discountBps: number;
}

function windowAllowanceOf(raw: ArrayLike<unknown>, account: ConvictionServiceAccount): CaWindowAllowance {
  return {
    index: Number(raw[0]),
    baseAllowance: account.committedTRAC / BigInt(account.lockDurationEpochs),
    baseRemaining: BigInt(raw[1] as bigint),
    topUpBuffer: BigInt(raw[2] as bigint),
    expired: Boolean(raw[3]),
  };
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the order of `items`. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const READ_CONCURRENCY = 4;

export class ConvictionServiceMethods extends EVMChainAdapterBase {
  async getConvictionServiceContracts(): Promise<CaContracts | null> {
    let ss: Contract;
    let css: Contract;
    try {
      ({ ss, css } = await this.convictionServiceContracts());
    } catch (err) {
      if (isConvictionServiceUnavailableError(err)) return null;
      throw err;
    }
    return this.convictionServiceCall(async () => {
      const pc = await this.resolveContract('PublishingConviction');
      const [logicVersion, chainId] = await Promise.all([
        this.readContract<string>(pc, 'publishingConviction.version', 'version'),
        this.getEvmChainId(),
      ]);
      const serviceSubscriptions = ethers.getAddress(await ss.getAddress());
      return {
        serviceSubscriptions,
        convictionServiceStorage: ethers.getAddress(await css.getAddress()),
        publishingConviction: ethers.getAddress(await pc.getAddress()),
        logicVersion: String(logicVersion),
        domain: convictionServiceDomain(chainId, serviceSubscriptions),
      };
    });
  }

  async getConvictionServiceStatus(accountId: bigint, _opts?: { fresh?: boolean }): Promise<CaServiceStatus | null> {
    requireAccountId(accountId);
    const { ss, css } = await this.convictionServiceContracts();
    return this.convictionServiceCall(async () => {
      const account = await this.readConvictionServiceAccount(accountId);
      if (!account) return null;
      const pc = await this.resolveContract('PublishingConviction');
      const parametersStorage = this.contracts.parametersStorage ?? await this.resolveContract('ParametersStorage');
      const [logicVersion, enabledAt, allowance, span, cutOver, total, cursor, count, treasury] = await Promise.all([
        this.readContract(pc, 'publishingConviction.version', 'version'),
        this.readContract(css, 'css.serviceSpendingEnabledAt', 'serviceSpendingEnabledAt', accountId),
        this.readContract(ss, 'ss.currentWindowAllowance', 'currentWindowAllowance', accountId),
        this.readContract(ss, 'ss.emissionSpan', 'emissionSpan', accountId),
        this.readContract(css, 'css.exactScheduleFrom', 'exactScheduleFrom'),
        this.readContract(css, 'css.accountServiceLabelTotal', 'accountServiceLabelTotal', accountId),
        this.readContract(css, 'css.labelCursor', 'labelCursor', accountId),
        this.readContract(css, 'css.assigneeCount', 'assigneeCount', accountId),
        this.readContract(parametersStorage, 'parametersStorage.protocolTreasury', 'protocolTreasury'),
      ]);
      // Until the schedule cut-over is set, `baseLabelCapacity` reverts
      // `ExactScheduleFromUnset`, and no account can be opted in.
      const cutOverAt = Number(cutOver);
      const remainingBaseCapacity = cutOverAt === 0
        ? 0n
        : BigInt(await this.readContract(ss, 'ss.baseLabelCapacity', 'baseLabelCapacity', accountId));
      const assignees = await this.readAssignees(css, accountId, Number(count));
      const actives = await mapLimited(assignees, READ_CONCURRENCY, async (assignee) => Boolean(
        await this.readContract(css, 'css.isAssignmentActive', 'isAssignmentActive', accountId, assignee),
      ));
      return {
        accountId,
        owner: account.owner,
        logicVersion: String(logicVersion),
        serviceSpendingEnabledAt: Number(enabledAt),
        discountBps: account.discountBps,
        lockDurationEpochs: account.lockDurationEpochs,
        expiresAtTimestamp: account.expiresAtTimestamp,
        window: windowAllowanceOf(allowance, account),
        schedule: {
          exact: cutOverAt !== 0 && account.createdAtTimestamp >= cutOverAt,
          firstEpoch: Number(span[0]),
          lastEpoch: Number(span[1]),
        },
        labels: { total: BigInt(total), cursor: Number(cursor), remainingBaseCapacity },
        assignments: { count: assignees.length, active: actives.filter(Boolean).length },
        treasuryWired: String(treasury) !== ethers.ZeroAddress,
      };
    }, { unknownAccount: null });
  }

  async getConvictionServiceWindowAllowance(accountId: bigint): Promise<CaWindowAllowance | null> {
    requireAccountId(accountId);
    const { ss } = await this.convictionServiceContracts();
    return this.convictionServiceCall(async () => {
      const account = await this.readConvictionServiceAccount(accountId);
      if (!account) return null;
      return windowAllowanceOf(
        await this.readContract(ss, 'ss.currentWindowAllowance', 'currentWindowAllowance', accountId),
        account,
      );
    }, { unknownAccount: null });
  }

  async getConvictionServiceAssignmentNonce(accountId: bigint): Promise<bigint> {
    requireAccountId(accountId);
    const { css } = await this.convictionServiceContracts();
    return this.convictionServiceCall(async () => BigInt(
      await this.readContract(css, 'css.assignmentNonce', 'assignmentNonce', accountId),
    ));
  }

  async setConvictionServiceSpending(accountId: bigint, enabled: boolean): Promise<TxResult> {
    requireAccountId(accountId);
    if (typeof enabled !== 'boolean') throw new ConvictionServiceInputError('enabled must be a boolean');
    return this.convictionServiceWrite(accountId, async () => {
      const { ss } = await this.convictionServiceContracts();
      return txResultOf(await this.sendContractTransaction(
        ss, 'setServiceSpending', [accountId, enabled], this.signer, 'set conviction account service spending',
      ));
    });
  }

  async signConvictionServiceConsent(terms: CaAssignmentTerms): Promise<{ digest: string; signature: string }> {
    const message = assignmentTermsArg(terms);
    const buyer = this.convictionServiceBuyer();
    if (message.assignee !== buyer.address) {
      throw new ConvictionServiceInputError(
        `terms.assignee ${message.assignee} is not this node's buyer key ${buyer.address}`,
      );
    }
    const { ss } = await this.convictionServiceContracts();
    const domain = convictionServiceDomain(await this.getEvmChainId(), await ss.getAddress());
    const signature = await buyer.signTypedData(domain, SERVICE_ASSIGNMENT_TYPES, message);
    return { digest: serviceAssignmentDigest(domain, terms), signature };
  }

  async assignConvictionServiceBuyer(
    terms: CaAssignmentTerms,
    signatures: { owner?: string; assignee?: string },
    sendAs: 'owner' | 'assignee',
  ): Promise<TxResult & { digest: string }> {
    const t = assignmentTermsArg(terms);
    if (sendAs !== 'owner' && sendAs !== 'assignee') {
      throw new ConvictionServiceInputError("sendAs must be 'owner' or 'assignee'");
    }
    const sender = sendAs === 'owner' ? this.signer : this.convictionServiceBuyer();
    return this.convictionServiceWrite(t.accountId, async () => {
      const { ss } = await this.convictionServiceContracts();
      // The contract checks the opt-in before the owner, so an account it
      // cannot find is left for it to refuse.
      const owner = (await this.readConvictionServiceAccount(t.accountId))?.owner ?? null;
      const receipt = await this.sendContractTransaction(ss, 'assign', [
        t,
        consentSignatureArg(owner, sender.address, signatures.owner),
        consentSignatureArg(t.assignee, sender.address, signatures.assignee),
      ], sender, 'assign conviction account service buyer');
      const assigned = findServiceSubscriptionsLog(receipt.logs, await ss.getAddress(), 'ServiceAssigned');
      const digest = assigned
        ? String(assigned.args.termsDigest)
        : serviceAssignmentDigest(convictionServiceDomain(await this.getEvmChainId(), await ss.getAddress()), terms);
      return { ...txResultOf(receipt), digest };
    });
  }

  async revokeConvictionServiceBuyer(accountId: bigint, assignee: string): Promise<TxResult & { nextNonce: bigint }> {
    requireAccountId(accountId);
    const who = requireAddress(assignee, 'assignee');
    return this.convictionServiceWrite(accountId, async () => {
      const { ss, css } = await this.convictionServiceContracts();
      const receipt = await this.sendContractTransaction(
        ss, 'revoke', [accountId, who], this.signer, 'revoke conviction account service buyer',
      );
      return { ...txResultOf(receipt), nextNonce: await this.nextAssignmentNonceOf(receipt, ss, css, accountId) };
    });
  }

  async updateConvictionServiceCaps(accountId: bigint, assignee: string, caps: CaAssignmentCaps): Promise<TxResult> {
    requireAccountId(accountId);
    const who = requireAddress(assignee, 'assignee');
    const c = assignmentCapsArg(caps);
    return this.convictionServiceWrite(accountId, async () => {
      const { ss } = await this.convictionServiceContracts();
      return txResultOf(await this.sendContractTransaction(
        ss, 'updateAssignmentCaps', [accountId, who, c], this.signer, 'update conviction account service caps',
      ));
    });
  }

  async advanceConvictionServiceNonce(accountId: bigint): Promise<TxResult & { nextNonce: bigint }> {
    requireAccountId(accountId);
    return this.convictionServiceWrite(accountId, async () => {
      const { ss, css } = await this.convictionServiceContracts();
      const receipt = await this.sendContractTransaction(
        ss, 'advanceAssignmentNonce', [accountId], this.signer, 'advance conviction account assignment nonce',
      );
      return { ...txResultOf(receipt), nextNonce: await this.nextAssignmentNonceOf(receipt, ss, css, accountId) };
    });
  }

  async listConvictionServiceAssignments(accountId: bigint): Promise<Array<{ assignee: string } & CaAssignment>> {
    requireAccountId(accountId);
    const { css } = await this.convictionServiceContracts();
    return this.convictionServiceCall(async () => {
      const count = Number(await this.readContract(css, 'css.assigneeCount', 'assigneeCount', accountId));
      const assignees = await this.readAssignees(css, accountId, count);
      return mapLimited(assignees, READ_CONCURRENCY, async (assignee) => {
        const [a, u, active] = await Promise.all([
          this.readContract(css, 'css.getAssignment', 'getAssignment', accountId, assignee),
          this.readContract(css, 'css.getUsage', 'getUsage', accountId, assignee),
          this.readContract(css, 'css.isAssignmentActive', 'isAssignmentActive', accountId, assignee),
        ]);
        return assignmentOf(assignee, a, u, Boolean(active));
      });
    });
  }

  async getConvictionServiceLabels(accountId: bigint, fromEpoch: number, toEpoch: number): Promise<CaEpochLabel[]> {
    requireLabelRange(fromEpoch, toEpoch);
    requireAccountId(accountId);
    const { ss, css } = await this.convictionServiceContracts();
    return this.convictionServiceCall(async () => {
      if (!await this.readConvictionServiceAccount(accountId)) {
        throw new ConvictionServiceRevertError('UnknownAccount', { accountId });
      }
      const epochStorage = await this.resolveContract('EpochStorageV8', 'EpochStorage');
      // Until the schedule cut-over is set there is no schedule basis, and
      // `scheduledEmission` reverts `ExactScheduleFromUnset`.
      const scheduleSet = Number(await this.readContract(css, 'css.exactScheduleFrom', 'exactScheduleFrom')) !== 0;
      const epochs = Array.from({ length: toEpoch - fromEpoch + 1 }, (_, i) => fromEpoch + i);
      return mapLimited(epochs, READ_CONCURRENCY, async (epoch) => {
        const [scheduled, label, serviceLabel, pool] = await Promise.all([
          scheduleSet ? this.readContract(ss, 'ss.scheduledEmission', 'scheduledEmission', accountId, epoch) : 0n,
          this.readContract(css, 'css.accountLabel', 'accountLabel', accountId, epoch),
          this.readContract(css, 'css.serviceLabel', 'serviceLabel', epoch),
          this.readContract(epochStorage, 'epochStorage.getEpochPool', 'getEpochPool', 1, epoch),
        ]);
        return {
          epoch,
          scheduled: BigInt(scheduled),
          baseLabel: BigInt(label[0]),
          topUpLabel: BigInt(label[1]),
          serviceLabel: BigInt(serviceLabel),
          pool: BigInt(pool),
        };
      });
    });
  }

  async fundServicePeriodFromConviction(req: CaFundingRequest): Promise<CaPeriodFunding> {
    const r = fundingRequestArg(req);
    const buyer = this.convictionServiceBuyer();
    const subscriptionId = serviceSubscriptionIdOf(buyer.address, r.periodId);
    const { css } = await this.convictionServiceContracts();
    // A lost reply must never fund twice: a period id this buyer key already
    // funded is answered from the chain, and nothing is sent.
    const funded = await this.convictionServiceCall(async () => Boolean(
      await this.readContract(css, 'css.subscriptionExists', 'subscriptionExists', subscriptionId),
    ));
    if (funded) return this.existingServicePeriodFunding(subscriptionId);
    let receipt: ethers.TransactionReceipt;
    let serviceSubscriptions: string;
    try {
      ({ receipt, serviceSubscriptions } = await this.convictionServiceWrite(r.accountId, async () => {
        const { ss } = await this.convictionServiceContracts();
        return {
          receipt: await this.sendContractTransaction(ss, 'fundFromConviction', [r], buyer, 'fund service period from conviction'),
          serviceSubscriptions: await ss.getAddress(),
        };
      }));
    } catch (err) {
      // A concurrent request with the same period id was funded first.
      if (isConvictionServiceRevertError(err) && err.revertName === 'PeriodAlreadyFunded') {
        return this.existingServicePeriodFunding(subscriptionId);
      }
      throw err;
    }
    const decoded = decodeServicePeriodFunding(receipt.logs, serviceSubscriptions, subscriptionId);
    if (!decoded) {
      // The contracts always log both events; read the record back if not.
      const recovered = await this.existingServicePeriodFunding(subscriptionId);
      return { ...recovered, existing: recovered.hash !== receipt.hash };
    }
    return {
      ...txResultOf(receipt),
      subscriptionId,
      cost: decoded.period.cost,
      logIndex: decoded.logIndex,
      existing: false,
      period: decoded.period,
    };
  }

  async getServicePeriod(subscriptionId: string): Promise<CaPeriod | null> {
    const id = requireBytes32(subscriptionId, 'subscriptionId');
    const { css } = await this.convictionServiceContracts();
    return this.convictionServiceCall(() => this.readServicePeriod(css, id));
  }

  async listServicePeriods(accountId: bigint, offset: number, limit: number): Promise<{ total: number; periods: CaPeriod[] }> {
    requireAccountId(accountId);
    requirePeriodPage(offset, limit);
    const { css } = await this.convictionServiceContracts();
    return this.convictionServiceCall(async () => {
      const total = Number(await this.readContract(css, 'css.accountSubscriptionCount', 'accountSubscriptionCount', accountId));
      const indexes = Array.from({ length: Math.max(0, Math.min(total, offset + limit) - offset) }, (_, i) => offset + i);
      const periods = await mapLimited(indexes, READ_CONCURRENCY, async (index) => {
        const id = String(await this.readContract(css, 'css.accountSubscriptionAt', 'accountSubscriptionAt', accountId, index));
        const period = await this.readServicePeriod(css, id);
        if (!period) throw new Error(`ConvictionServiceStorage lists ${id} for account ${accountId} but holds no record of it`);
        return period;
      });
      return { total, periods };
    });
  }

  getConvictionServiceBuyerAddress(): string | null {
    const configured = this.convictionServiceBuyerAddress;
    if (configured === undefined) return this.signer.address;
    if (typeof configured !== 'string' || !ethers.isAddress(configured)) return null;
    return this.findSignerByAddress(configured)?.address ?? null;
  }

  // ---------------------------------------------------------------- helpers

  /** `ServiceSubscriptions` and `ConvictionServiceStorage`, resolved from the Hub. */
  protected async convictionServiceContracts(): Promise<{ ss: Contract; css: Contract }> {
    await this.init();
    try {
      const [ss, css] = await Promise.all([
        this.resolveContract('ServiceSubscriptions'),
        this.resolveContract('ConvictionServiceStorage'),
      ]);
      return { ss, css };
    } catch (err) {
      throw convictionServiceErrorOf(err) ?? err;
    }
  }

  /**
   * Run a read with its reverts typed. With `unknownAccount: null`, an unknown
   * account (`UnknownAccount`, `ERC721NonexistentToken`) answers `null`.
   */
  protected async convictionServiceCall<T>(read: () => Promise<T>): Promise<T>;
  protected async convictionServiceCall<T>(read: () => Promise<T>, opts: { unknownAccount: null }): Promise<T | null>;
  protected async convictionServiceCall<T>(read: () => Promise<T>, opts?: { unknownAccount: null }): Promise<T | null> {
    try {
      return await read();
    } catch (err) {
      const typed = convictionServiceErrorOf(err);
      if (opts && typed?.kind === 'not-found') return opts.unknownAccount;
      throw typed ?? err;
    }
  }

  /**
   * A write under the Hub self-heal retry with custom-error enrichment (what
   * `pcaWrite` does for the Publishing Conviction writes), which invalidates
   * the account's cached Publishing Conviction info once it succeeds. `op`
   * resolves the contracts itself, so the retry sends to fresh ones.
   */
  protected async convictionServiceWrite<T>(accountId: bigint, op: () => Promise<T>): Promise<T> {
    try {
      const result = await this.withHubStaleRetryAny(op);
      this.pcaReadCache.invalidateMutation({ kind: 'account-changed', accountId }, result);
      return result;
    } catch (err) {
      throw convictionServiceErrorOf(err) ?? err;
    }
  }

  /** The buyer key's signer, or `ConvictionServiceUnavailableError` when the node holds no signer for it. */
  protected convictionServiceBuyer(): EvmSigner {
    const address = this.getConvictionServiceBuyerAddress();
    const signer = address === null ? undefined : this.findSignerByAddress(address);
    if (!signer) {
      throw new ConvictionServiceUnavailableError(
        `The configured buyer key ${String(this.convictionServiceBuyerAddress)} is not one of this node's operational wallets, so the node cannot sign for it.`,
      );
    }
    return signer;
  }

  /** The account's owner and terms, or `null` when the NFT or the account storage has no such account. */
  protected async readConvictionServiceAccount(accountId: bigint): Promise<ConvictionServiceAccount | null> {
    const nft = this.contracts.dkgPublishingConvictionNFT;
    if (!nft) throw new ConvictionServiceUnavailableError('DKGPublishingConvictionNFT is not deployed on this Hub.');
    let owner: string;
    let acct: ArrayLike<unknown>;
    try {
      [owner, acct] = await Promise.all([
        this.readContract<string>(nft, 'pcaNFT.ownerOf', 'ownerOf', accountId),
        this.readContract(nft, 'pcaNFT.accounts', 'accounts', accountId),
      ]);
    } catch (err) {
      if (convictionServiceErrorOf(err)?.kind === 'not-found') return null;
      throw err;
    }
    // `accounts` is a mapping getter: a record without a lock is no account.
    if (Number(acct[5]) === 0) return null;
    return {
      owner: ethers.getAddress(owner),
      committedTRAC: BigInt(acct[0] as bigint),
      createdAtTimestamp: Number(acct[3]),
      expiresAtTimestamp: Number(acct[4]),
      lockDurationEpochs: Number(acct[5]),
      discountBps: Number(acct[6]),
    };
  }

  protected async readAssignees(css: Contract, accountId: bigint, count: number): Promise<string[]> {
    const indexes = Array.from({ length: count }, (_, i) => i);
    return mapLimited(indexes, READ_CONCURRENCY, async (index) => ethers.getAddress(
      await this.readContract<string>(css, 'css.assigneeAt', 'assigneeAt', accountId, index),
    ));
  }

  protected async readServicePeriod(css: Contract, subscriptionId: string): Promise<CaPeriod | null> {
    const raw = await this.readContract(css, 'css.getSubscription', 'getSubscription', subscriptionId);
    if (Number(raw[5]) === 0) return null;
    const buckets = await this.readContract(css, 'css.getBuckets', 'getBuckets', subscriptionId);
    return servicePeriodOf(subscriptionId, raw, buckets);
  }

  /** `AssignmentNonceAdvanced.nextNonce` from the receipt, else the stored nonce. */
  protected async nextAssignmentNonceOf(
    receipt: ethers.TransactionReceipt,
    ss: Contract,
    css: Contract,
    accountId: bigint,
  ): Promise<bigint> {
    const advanced = findServiceSubscriptionsLog(receipt.logs, await ss.getAddress(), 'AssignmentNonceAdvanced');
    if (advanced) return BigInt(advanced.args.nextNonce);
    return BigInt(await this.readContract(css, 'css.assignmentNonce', 'assignmentNonce', accountId));
  }

  /**
   * The answer to a period id this buyer key already funded: the stored period
   * and the transaction of its `PeriodFunded` log. The log is found in the
   * one block whose timestamp is the period's start (block timestamps rise
   * strictly), so no wide log range is scanned.
   */
  protected async existingServicePeriodFunding(subscriptionId: string): Promise<CaPeriodFunding> {
    const { css } = await this.convictionServiceContracts();
    const period = await this.convictionServiceCall(() => this.readServicePeriod(css, subscriptionId));
    if (!period) throw new Error(`Service period ${subscriptionId} is reported funded but has no record`);
    const blockNumber = await this.blockNumberAtTimestamp(period.periodStart);
    const iface = getServiceSubscriptionsInterface();
    const logs = await this.readProvider('conviction service PeriodFunded log', (p) => p.getLogs({
      topics: [iface.getEvent('PeriodFunded')!.topicHash, subscriptionId],
      fromBlock: blockNumber,
      toBlock: blockNumber,
    }));
    for (const log of logs) {
      const event = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!event || BigInt(event.args.accountId) !== period.accountId
        || ethers.getAddress(event.args.assignee) !== period.assignee
        || String(event.args.periodId).toLowerCase() !== period.periodId
        || BigInt(event.args.cost) !== period.cost) continue;
      return {
        hash: log.transactionHash,
        blockNumber: log.blockNumber,
        txIndex: log.transactionIndex,
        success: true,
        subscriptionId: period.subscriptionId,
        cost: period.cost,
        logIndex: log.index,
        existing: true,
        period,
      };
    }
    throw new Error(`No PeriodFunded log for service period ${subscriptionId} in block ${blockNumber}`);
  }

  /** The first block at or after `timestamp`: a binary search over block headers. */
  protected async blockNumberAtTimestamp(timestamp: number): Promise<number> {
    let lo = 0;
    let hi = await this.readTipProvider('conviction service block search head', (p) => p.getBlockNumber());
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const block = await this.readProviderRetryingNull('conviction service block search', (p) => p.getBlock(mid));
      if (!block) throw new Error(`Block ${mid} is not available from any RPC endpoint`);
      if (block.timestamp < timestamp) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
