/** Synchronous, best-effort boundary observations; hooks never control lock ownership. */
export interface ClaimLockObservation {
  queued?: () => void;
  acquired?: () => void;
  released?: () => void;
}

export type ClaimLockKind = 'claim' | 'admission' | 'transition' | 'recovery' | 'sweep' | 'admin';

interface ClaimWaiter {
  readonly kind: ClaimLockKind;
  readonly granted: Promise<void>;
  readonly grant: () => void;
  bypassed: boolean;
}

export interface ClaimLockQueue {
  owner: ClaimWaiter;
  readonly waiting: ClaimWaiter[];
}

/**
 * One owner per claim domain. A claim may pass the oldest waiting admission once,
 * before that admission must run. Every other operation kind is an ordering barrier.
 * Business callbacks stay in their originating caller's await continuation.
 */
export async function withClaimDomainLock<T>(
  queues: Map<string, ClaimLockQueue>,
  key: string,
  kind: ClaimLockKind,
  work: () => Promise<T>,
  observation?: ClaimLockObservation,
): Promise<T> {
  let grant!: () => void;
  const granted = new Promise<void>((resolve) => { grant = resolve; });
  const waiter: ClaimWaiter = { kind, granted, grant, bypassed: false };
  let queue = queues.get(key);
  const first = queue === undefined;
  if (queue === undefined) {
    queue = { owner: waiter, waiting: [] };
    queues.set(key, queue);
  } else {
    queue.waiting.push(waiter);
  }
  // Ownership is reserved before a queued observer can synchronously reenter.
  observe(observation, 'queued');
  if (first) waiter.grant();
  await waiter.granted;
  observe(observation, 'acquired');
  try {
    return await work();
  } finally {
    const next = selectNext(queue.waiting);
    if (next !== undefined) {
      queue.owner = next;
      next.grant();
    } else if (queues.get(key) === queue) {
      queues.delete(key);
    }
    // A successor's await continuation cannot run until this synchronous release ends.
    observe(observation, 'released');
  }
}

function selectNext(waiting: ClaimWaiter[]): ClaimWaiter | undefined {
  const head = waiting[0];
  if (head?.kind === 'admission' && !head.bypassed) {
    for (let index = 1; index < waiting.length; index += 1) {
      const candidate = waiting[index]!;
      if (candidate.kind === 'claim') {
        head.bypassed = true;
        return waiting.splice(index, 1)[0];
      }
      if (candidate.kind !== 'admission') break;
    }
  }
  return waiting.shift();
}

function observe(observation: ClaimLockObservation | undefined, phase: keyof ClaimLockObservation): void {
  try {
    observation?.[phase]?.();
  } catch { /* Observers cannot control ownership or settlement. */ }
}
