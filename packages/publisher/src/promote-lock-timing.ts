import { ShareStoreHold } from '@origintrail-official/dkg-storage';
import { Logger, createOperationContext, currentAsyncAdmissionDiagnosticContext } from '@origintrail-official/dkg-core';

export type PromoteLockOperation =
  | 'enqueue' | 'enqueueAndClaim' | 'bindRecovery' | 'getStatus' | 'reconcileShare'
  | 'retirement' | 'cancel' | 'recover' | 'claimNext' | 'heartbeat' | 'recordCommitMarker' | 'succeed' | 'fail'
  | 'recoverOnStartup' | 'clearTerminalJob' | 'retention' | 'unlabelled'
  | 'listKeys' | 'listPayloads' | 'listRetries' | 'listPage' | 'getStats' | 'listForSelector'
  | 'sweepCandidates' | 'sweepDecisions';

interface Chain {
  readonly id: number;
  ticket: number;
  waitingShares: number;
  totals: Map<PromoteLockOperation, number>;
  owner?: { operation: PromoteLockOperation; since: number; ticket: number; store: ShareStoreHold; observed: boolean };
}

// Follow the existing FIFO tails. Each busy period has fixed-cardinality totals and no history.
let chainSequence = 0;
const chains = new WeakMap<Promise<void>, Chain>();
const logger = new Logger('AsyncPromoteLock');

function snapshot(chain: Chain, now: number) {
  const totals = new Map(chain.totals);
  if (chain.owner) {
    const { operation, since } = chain.owner;
    totals.set(operation, (totals.get(operation) ?? 0) + now - since);
  }
  return totals;
}

function report(requestId: string | undefined, fields: Record<string, unknown>) {
  try {
    logger.info(createOperationContext('publish', 'admission'), JSON.stringify({
      event: 'async_share_lock_timing', requestId, ...fields,
    }));
  } catch { /* Diagnostic output must never affect lock ownership. */ }
}

export function tracePromoteLock(previous: Promise<void>, next: Promise<void>, operation: PromoteLockOperation) {
  const chain: Chain = chains.get(previous) ?? { id: ++chainSequence, ticket: 0, waitingShares: 0, totals: new Map() };
  chains.set(next, chain);
  const ticket = ++chain.ticket;
  const store = new ShareStoreHold();
  const context = operation === 'enqueue' ? currentAsyncAdmissionDiagnosticContext() : undefined;
  const requestId = context?.route === 'share_async' ? context.requestId : undefined;
  const queued = performance.now();
  const before = requestId ? snapshot(chain, queued) : undefined;
  const ids = { chainId: chain.id, ticket };
  const snapshotOwner = () => chain.owner && ({
    operation: chain.owner.operation, ticket: chain.owner.ticket,
    heldMs: Math.round(performance.now()-chain.owner.since), ...chain.owner.store.snapshot(),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (requestId) {
    chain.waitingShares++;
    if (chain.owner) chain.owner.observed = true;
    timer = setTimeout(() => report(requestId, { phase: 'still_waiting', ...ids, current: snapshotOwner() }), 5_000);
    timer.unref();
    report(requestId, { phase: 'queued', ...ids, ownerTicket: chain.owner?.ticket, owner: chain.owner?.operation ?? null,
      ownerHeldMs: chain.owner ? Math.round(queued - chain.owner.since) : 0 });
  }
  return {
    run<T>(fn: () => Promise<T>) { return store.run(fn); },
    acquired() {
      const now = performance.now();
      if (requestId && before) {
        clearTimeout(timer);
        chain.waitingShares--;
        const blockedByMs: Partial<Record<PromoteLockOperation, number>> = {};
        let accounted = 0;
        for (const [op, total] of chain.totals) {
          const overlap = total - (before.get(op) ?? 0);
          if (overlap > 0) {
            blockedByMs[op] = Math.round(overlap);
            accounted += overlap;
          }
        }
        report(requestId, { phase: 'acquired', ...ids, waitedMs: Math.round(now - queued), blockedByMs,
          betweenOwnersMs: Math.round(Math.max(0, now - queued - accounted)) });
      }
      chain.owner = { operation, since: now, ticket, store, observed: chain.waitingShares > 0 };
      if (requestId) {
        timer = setTimeout(() => report(requestId, { phase: 'still_holding', ...ids, current: snapshotOwner() }), 5_000);
        timer.unref();
      }
    },
    releasing() {
      clearTimeout(timer);
      store.active = false;
      if (chain.owner) {
        const duration = performance.now() - chain.owner.since;
        if (chain.owner.observed || requestId || duration >= 1_000) {
          report(requestId, { phase: 'released', ...ids, operation, acquiredAtUnixMs: Math.round(performance.timeOrigin + chain.owner.since),
            heldMs: Math.round(duration), ...store.snapshot() });
        }
        chain.totals.set(operation, (chain.totals.get(operation) ?? 0) + duration);
        chain.owner = undefined;
      }
    },
  };
}
