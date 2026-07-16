// relay-reservation-count.test.ts
//
// Unit tests for the multi-reservation tuning landed in
// `feat/libp2p-multi-reservation` (PR3 of the libp2p reachability
// hardening series). Two surfaces under test:
//
//   1. `validateRelayReservationCount(input)` — input-validation gate
//      modelled on `validateRelayServerCapacity` from PR1. Defends
//      against operator config containing 0, negatives, NaN, Infinity,
//      fractional, non-numbers, and over-cap (> 16) values. Same
//      shape (`{ ok, value | reason } | null`) so the call sites can
//      share the warn-and-fall-back pattern.
//
//   2. The exported constants `DEFAULT_RELAY_RESERVATION_COUNT` and
//      `MAX_RELAY_RESERVATION_COUNT` — pinned at 3 / 16 by intent
//      (see node.ts JSDoc); changing them is a breaking config
//      contract for operators and should be a deliberate decision,
//      not an accidental edit.
//
// The wiring into `start()` (N `/p2p-circuit` listen entries +
// `reservationConcurrency: N`) is exercised at the integration level
// — it depends on real libp2p transport bring-up, which the unit
// suite intentionally doesn't simulate. The source-reading spike
// documented in the PR description is what gives us confidence the
// wiring is correct: each `/p2p-circuit` listen addr triggers one
// `reserveRelay()` call in `@libp2p/circuit-relay-v2/transport/
// reservation-store.js`, so N entries produces N pending IDs, and
// `reservationConcurrency: N` lets all N be fulfilled in parallel
// rather than serialised through the default-1 PeerQueue.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RELAY_RESERVATION_COUNT,
  MAX_RELAY_RESERVATION_COUNT,
  validateRelayReservationCount,
} from '../src/node.js';

describe('relay reservation-count constants', () => {
  it('default is 3 — N-2 tolerance to simultaneous relay blackouts', () => {
    // The point of multi-reservation is that 1 reserved relay is a
    // single point of failure. 2 gives N-1 (one blink tolerated); 3
    // gives N-2 (two blinks tolerated). We pick 3 because the
    // observed Miles ↔ Lex blackouts that motivated this PR series
    // were rarely individual: the underlying causes (NAT pinhole
    // expiry, ISP routing flaps) tend to affect multiple peers in a
    // burst. Bumping past 3 is configurable but defaults stay
    // conservative — every reservation costs a held connection on
    // the relay host.
    expect(DEFAULT_RELAY_RESERVATION_COUNT).toBe(3);
  });

  it('hard cap is 16 — beyond this the marginal benefit is dwarfed by per-relay cost', () => {
    // The cap is intentional. Reserving on every public relay would
    // make every edge node O(N_public_relays) memory / control
    // streams, which doesn't scale as the network grows. 16 is the
    // ceiling we're willing to defend; operators wanting more
    // should be opening a discussion, not editing a config.
    expect(MAX_RELAY_RESERVATION_COUNT).toBe(16);
  });
});

describe('validateRelayReservationCount', () => {
  it('returns null for unset/undefined input (so callers can apply their own default)', () => {
    expect(validateRelayReservationCount(undefined)).toBeNull();
    expect(validateRelayReservationCount(null)).toBeNull();
  });

  it('accepts positive integers up to the cap', () => {
    expect(validateRelayReservationCount(1)).toEqual({ ok: true, value: 1 });
    expect(validateRelayReservationCount(3)).toEqual({ ok: true, value: 3 });
    expect(validateRelayReservationCount(MAX_RELAY_RESERVATION_COUNT)).toEqual({
      ok: true,
      value: MAX_RELAY_RESERVATION_COUNT,
    });
  });

  it('rejects 0 and negatives — would disable relay listening or produce garbage limits', () => {
    expect(validateRelayReservationCount(0)).toEqual({
      ok: false,
      reason: expect.stringContaining('>= 1'),
    });
    expect(validateRelayReservationCount(-1)).toEqual({
      ok: false,
      reason: expect.stringContaining('>= 1'),
    });
  });

  it('rejects NaN and Infinity — non-finite values would propagate undefined behaviour', () => {
    expect(validateRelayReservationCount(NaN)).toEqual({
      ok: false,
      reason: expect.stringContaining('finite'),
    });
    expect(validateRelayReservationCount(Infinity)).toEqual({
      ok: false,
      reason: expect.stringContaining('finite'),
    });
    expect(validateRelayReservationCount(-Infinity)).toEqual({
      ok: false,
      reason: expect.stringContaining('finite'),
    });
  });

  it('rejects fractional values — listen-addr count must be a whole number', () => {
    expect(validateRelayReservationCount(1.5)).toEqual({
      ok: false,
      reason: expect.stringContaining('integer'),
    });
    expect(validateRelayReservationCount(3.0001)).toEqual({
      ok: false,
      reason: expect.stringContaining('integer'),
    });
  });

  it('rejects values above the hard cap to prevent O(N_relays) reservation storms', () => {
    expect(validateRelayReservationCount(MAX_RELAY_RESERVATION_COUNT + 1)).toEqual({
      ok: false,
      reason: expect.stringContaining(`<= ${MAX_RELAY_RESERVATION_COUNT}`),
    });
    expect(validateRelayReservationCount(100)).toEqual({
      ok: false,
      reason: expect.stringContaining(`<= ${MAX_RELAY_RESERVATION_COUNT}`),
    });
  });

  it('rejects non-number types (strings, booleans, objects, arrays)', () => {
    expect(validateRelayReservationCount('3' as any)).toEqual({
      ok: false,
      reason: expect.stringContaining('number'),
    });
    expect(validateRelayReservationCount(true as any)).toEqual({
      ok: false,
      reason: expect.stringContaining('number'),
    });
    expect(validateRelayReservationCount({} as any)).toEqual({
      ok: false,
      reason: expect.stringContaining('number'),
    });
    expect(validateRelayReservationCount([] as any)).toEqual({
      ok: false,
      reason: expect.stringContaining('number'),
    });
  });
});
