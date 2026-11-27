import { STORE_WORK_PRIORITIES, type StoreWorkPriority } from './triple-store.js';

export interface NonAckLanePolicy {
  /** Shared normal/background capacity after the ACK and health reservations. */
  totalLimit: number;
  /** Capacity protected from background work. */
  normalFloor: number;
  /** Normal ceiling while queued background work owns its floor. */
  normalLimitWhileBackgroundQueued: number;
  /** Background progress guarantee while background work is queued. */
  backgroundFloor: number;
  /** Background ceiling that protects the normal floor. */
  backgroundLimit: number;
}

export function normalizeNonAckLanePolicy(
  totalLimit: number,
  requestedNormalFloor: number,
  requestedBackgroundFloor: number,
): NonAckLanePolicy {
  const normalFloor = Math.min(
    Math.max(0, requestedNormalFloor),
    Math.max(0, totalLimit - 1),
  );
  const backgroundLimit = Math.max(1, totalLimit - normalFloor);
  const backgroundFloor = Math.min(
    Math.max(0, requestedBackgroundFloor),
    backgroundLimit,
    Math.max(0, totalLimit - 1),
  );
  const normalLimitWhileBackgroundQueued = totalLimit - backgroundFloor;
  return {
    totalLimit,
    normalFloor,
    normalLimitWhileBackgroundQueued,
    backgroundFloor,
    backgroundLimit,
  };
}

interface DispatchState {
  maxConcurrent: number;
  ackReservedSlots: number;
  ackQueued: number;
  lanePolicy: NonAckLanePolicy;
  shareSingleOrdinarySlot: boolean;
  normalInflight: number;
  backgroundInflight: number;
  normalQueued: number;
  backgroundQueued: number;
}

/** Lane ordering owns fairness; the scheduler separately checks physical capacity. */
export class StoreDispatchPolicy {
  private singleSlotCursor: StoreWorkPriority | undefined;
  private contendedNormalDispatches = 0;
  private dispatchesWhileAckQueued = 0;

  candidates(state: DispatchState): readonly StoreWorkPriority[] {
    if (state.backgroundQueued === 0) this.contendedNormalDispatches = 0;
    if (state.ackQueued === 0) this.dispatchesWhileAckQueued = 0;
    const { lanePolicy } = state;
    const backgroundOwed = state.backgroundQueued > 0 && (
      state.backgroundInflight < lanePolicy.backgroundFloor
      || (state.shareSingleOrdinarySlot && this.contendedNormalDispatches >= 8)
    );
    const normalOwed = state.normalQueued > 0
      && state.normalInflight < Math.max(1, lanePolicy.normalFloor)
      && (state.maxConcurrent > 1 || this.singleSlotCursor === 'ack');
    // Restore an owed background floor first, then normal progress, before
    // allowing ACK traffic to borrow every slot again. With one physical slot,
    // the cursor alternates ACK and normal; background keeps its bounded turn.
    const owed: StoreWorkPriority[] = [];
    if (backgroundOwed) owed.push('background');
    if (normalOwed) owed.push('normal');
    // A floor cannot consume the only ordinary slot ahead of a queued health probe.
    const first: StoreWorkPriority[] = owed.length ? ['health', ...owed] : [];
    // Without a physical ACK reserve, restoring ordinary floors cannot occupy
    // every completion forever. Give waiting ACKs a turn after two other starts.
    if (state.maxConcurrent > 1 && state.ackReservedSlots === 0 && state.ackQueued > 0
      && this.dispatchesWhileAckQueued >= 2) first.unshift('ack');
    return [...first, ...STORE_WORK_PRIORITIES.filter(lane => !first.includes(lane))];
  }

  started(priority: StoreWorkPriority, backgroundContended: boolean, ackContended: boolean): void {
    if (priority === 'ack') this.dispatchesWhileAckQueued = 0;
    else if (ackContended) this.dispatchesWhileAckQueued += 1;
    this.singleSlotCursor = priority;
    if (priority === 'background') this.contendedNormalDispatches = 0;
    else if (priority === 'normal' && backgroundContended) this.contendedNormalDispatches += 1;
  }
}
