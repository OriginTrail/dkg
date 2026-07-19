import { WalWireError } from './wire-error.js';
import { WAL_WIRE_DETAIL_CODE, WAL_WIRE_ERROR_CODE } from './wire-types.js';

export type WalRequesterState =
  | 'idle'
  | 'head-known'
  | 'reconciling'
  | 'enumerating'
  | 'fetching'
  | 'complete'
  | 'cancelled'
  | 'failed';

export type WalRequesterEvent =
  | 'HEAD_RECEIVED'
  | 'ROOTS_EQUAL'
  | 'START_IBLT'
  | 'NEED_MORE_SYMBOLS'
  | 'IBLT_DECODED'
  | 'FALLBACK_ENUMERATION'
  | 'ENUMERATION_VERIFIED'
  | 'OBJECTS_VERIFIED'
  | 'PROVIDER_SWITCH'
  | 'CANCEL'
  | 'FAIL';

const REQUESTER_TRANSITIONS: Readonly<Record<WalRequesterState, Partial<Record<WalRequesterEvent, WalRequesterState>>>> = Object.freeze({
  idle: Object.freeze({ HEAD_RECEIVED: 'head-known', CANCEL: 'cancelled', FAIL: 'failed' }),
  'head-known': Object.freeze({ ROOTS_EQUAL: 'complete', START_IBLT: 'reconciling', FALLBACK_ENUMERATION: 'enumerating', PROVIDER_SWITCH: 'head-known', CANCEL: 'cancelled', FAIL: 'failed' }),
  reconciling: Object.freeze({ NEED_MORE_SYMBOLS: 'reconciling', IBLT_DECODED: 'fetching', FALLBACK_ENUMERATION: 'enumerating', PROVIDER_SWITCH: 'reconciling', CANCEL: 'cancelled', FAIL: 'failed' }),
  enumerating: Object.freeze({ ENUMERATION_VERIFIED: 'fetching', PROVIDER_SWITCH: 'enumerating', CANCEL: 'cancelled', FAIL: 'failed' }),
  fetching: Object.freeze({ OBJECTS_VERIFIED: 'complete', PROVIDER_SWITCH: 'fetching', CANCEL: 'cancelled', FAIL: 'failed' }),
  complete: Object.freeze({}),
  cancelled: Object.freeze({}),
  failed: Object.freeze({}),
});

export class WalRequesterStateMachine {
  state: WalRequesterState = 'idle';

  transition(event: WalRequesterEvent): WalRequesterState {
    const next = REQUESTER_TRANSITIONS[this.state][event];
    if (!next) {
      throw new WalWireError(WAL_WIRE_ERROR_CODE.NON_CANONICAL, `invalid requester transition ${this.state} -> ${event}`, WAL_WIRE_DETAIL_CODE.RESPONSE_BINDING);
    }
    this.state = next;
    return next;
  }
}

export type WalProviderState = 'received' | 'authorized' | 'queued' | 'running' | 'responded' | 'cancelled' | 'failed';
export type WalProviderEvent = 'AUTHORIZE' | 'QUEUE' | 'START' | 'RESPOND' | 'CANCEL' | 'FAIL';

const PROVIDER_TRANSITIONS: Readonly<Record<WalProviderState, Partial<Record<WalProviderEvent, WalProviderState>>>> = Object.freeze({
  received: Object.freeze({ AUTHORIZE: 'authorized', CANCEL: 'cancelled', FAIL: 'failed' }),
  authorized: Object.freeze({ QUEUE: 'queued', START: 'running', CANCEL: 'cancelled', FAIL: 'failed' }),
  queued: Object.freeze({ START: 'running', CANCEL: 'cancelled', FAIL: 'failed' }),
  running: Object.freeze({ RESPOND: 'responded', CANCEL: 'cancelled', FAIL: 'failed' }),
  responded: Object.freeze({}),
  cancelled: Object.freeze({}),
  failed: Object.freeze({}),
});

export class WalProviderRequestStateMachine {
  state: WalProviderState = 'received';

  transition(event: WalProviderEvent): WalProviderState {
    const next = PROVIDER_TRANSITIONS[this.state][event];
    if (!next) {
      throw new WalWireError(WAL_WIRE_ERROR_CODE.NON_CANONICAL, `invalid provider transition ${this.state} -> ${event}`, WAL_WIRE_DETAIL_CODE.RESPONSE_BINDING);
    }
    this.state = next;
    return next;
  }
}
