// SPDX-License-Identifier: Apache-2.0

/**
 * Conviction Account service spending (OT-RFC-27) on the EVM adapter: the
 * accounts that have assigned a buyer key.
 *
 * `ConvictionServiceStorage` enumerates the assignees of an account but keeps
 * no index from an assignee to its accounts, so they are found from the
 * `ServiceAssigned` logs with the assignee's topic, from the deployment block
 * of `ServiceSubscriptions` to the chain head, in pages that the log reader
 * fits to each RPC's `eth_getLogs` span cap.
 *
 * - The adapter keeps what a scan found, per contract address and assignee,
 *   so the next scan reads only the blocks after it, from a reorg margin
 *   back; concurrent scans of one assignee share one pass.
 * - Every account found is then read from storage, and one without a stored
 *   assignment of the assignee (its log dropped by a reorg) is left out.
 * - Only the logs of the `ServiceSubscriptions` the Hub names now are read:
 *   after a re-registration, those of the earlier contract are not.
 *
 * Mixin holder in the pattern of `evm-adapter-conviction-service.ts`, which it
 * extends for the service contracts and the typed reads; `evm-adapter.ts`
 * assembles it into `EVMChainAdapter` with `applyMixins`.
 */

import { ethers, type Contract, type JsonRpcProvider } from 'ethers';
import { requireAddress, type CaAssignment } from './conviction-service.js';
import { CG_REGISTRY_REORG_BUFFER_BLOCKS } from './evm-adapter-constants.js';
import {
  ConvictionServiceMethods,
  READ_CONCURRENCY,
  assignmentOf,
  mapLimited,
} from './evm-adapter-conviction-service.js';

/** Blocks per `eth_getLogs` page of the assignee scan, before the reader fits them to an RPC's span cap. */
export const CA_ASSIGNEE_SCAN_PAGE_BLOCKS = 10_000;
/** Pages one scan may read, about 20 million blocks; a longer range fails with guidance. */
export const CA_ASSIGNEE_SCAN_MAX_PAGES = 2_000;
/** The RPC usage consumer of the scan's `eth_getLogs` reads. */
export const CA_ASSIGNEE_SCAN_RPC_USAGE_CONSUMER = 'conviction service ServiceAssigned logs';

interface AssigneeScan {
  /** The last block scanned. */
  throughBlock: number;
  accounts: ReadonlySet<bigint>;
}

// Mixin holders contribute methods only, so the per-adapter state lives here.
const completedScans = new WeakMap<object, Map<string, AssigneeScan>>();
const runningScans = new WeakMap<object, Map<string, Promise<bigint[]>>>();

function stateOf<V>(states: WeakMap<object, Map<string, V>>, owner: object): Map<string, V> {
  let state = states.get(owner);
  if (!state) {
    state = new Map();
    states.set(owner, state);
  }
  return state;
}

export class ConvictionServiceAssigneeMethods extends ConvictionServiceMethods {
  async listConvictionServiceAccountsByAssignee(
    assignee: string,
  ): Promise<Array<{ accountId: bigint; assignee: string } & CaAssignment>> {
    const who = requireAddress(assignee, 'assignee');
    const { ss, css } = await this.convictionServiceContracts();
    return this.convictionServiceCall(async () => {
      const accountIds = await this.scanServiceAssignedAccounts(ss, who);
      const found = await mapLimited(accountIds, READ_CONCURRENCY, async (accountId) => {
        const [a, u, active] = await Promise.all([
          this.readContract(css, 'convictionServiceStorage.getAssignment', 'getAssignment', accountId, who),
          this.readContract(css, 'convictionServiceStorage.getUsage', 'getUsage', accountId, who),
          this.readContract(css, 'convictionServiceStorage.isAssignmentActive', 'isAssignmentActive', accountId, who),
        ]);
        return { accountId, ...assignmentOf(who, a, u, Boolean(active)) };
      });
      return found.filter((entry) => entry.assignedAt !== 0);
    });
  }

  /** The ids of the accounts whose `ServiceAssigned` logs name `assignee`, ascending; one pass per key at a time. */
  protected async scanServiceAssignedAccounts(ss: Contract, assignee: string): Promise<bigint[]> {
    const address = ethers.getAddress(await ss.getAddress());
    const key = `${address.toLowerCase()}:${assignee.toLowerCase()}`;
    const running = stateOf(runningScans, this);
    const pending = running.get(key);
    if (pending) return pending;
    const scan = this.scanServiceAssignedLogs(ss, address, assignee, key).finally(() => running.delete(key));
    running.set(key, scan);
    return scan;
  }

  protected async scanServiceAssignedLogs(ss: Contract, address: string, assignee: string, key: string): Promise<bigint[]> {
    const label = 'listConvictionServiceAccountsByAssignee';
    const { fromBlock, head, scanProviders } = await this.resolveContractDeployBlock(address, label, 'ServiceSubscriptions');
    const completed = stateOf(completedScans, this);
    const known = completed.get(key);
    const start = known === undefined
      ? fromBlock
      : Math.max(fromBlock, known.throughBlock + 1 - CG_REGISTRY_REORG_BUFFER_BLOCKS);
    const accounts = new Set<bigint>(known?.accounts ?? []);
    if (start <= head) {
      const pages = Math.ceil((head - start + 1) / CA_ASSIGNEE_SCAN_PAGE_BLOCKS);
      if (pages > CA_ASSIGNEE_SCAN_MAX_PAGES) {
        throw new Error(
          `${label}: the ServiceAssigned scan of ${address} would read blocks [${start}, ${head}], `
            + `${pages} pages of ${CA_ASSIGNEE_SCAN_PAGE_BLOCKS} blocks (budget ${CA_ASSIGNEE_SCAN_MAX_PAGES}). `
            + `${fromBlock === 0 ? 'No RPC could find the contract\'s deployment block (it needs historical eth_getCode), so the scan starts at genesis. ' : ''}`
            + 'Use an archive RPC endpoint, or look the account up by id.',
        );
      }
      const filter = ss.filters.ServiceAssigned(null, assignee);
      const connected = new Map<JsonRpcProvider, Contract>();
      let preferred: JsonRpcProvider | undefined;
      for (let lo = start; lo <= head; lo += CA_ASSIGNEE_SCAN_PAGE_BLOCKS) {
        const hi = Math.min(lo + CA_ASSIGNEE_SCAN_PAGE_BLOCKS - 1, head);
        const page = await this.queryEventLogsPage(
          ss, filter, lo, hi, scanProviders, connected, `${label} ServiceAssigned`, preferred, CA_ASSIGNEE_SCAN_RPC_USAGE_CONSUMER,
        );
        preferred = page.provider;
        // topics: the event, the indexed accountId, the indexed assignee.
        for (const log of page.logs) accounts.add(BigInt(log.topics[1]!));
      }
    }
    completed.set(key, { throughBlock: Math.max(head, known?.throughBlock ?? -1), accounts });
    return [...accounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}
