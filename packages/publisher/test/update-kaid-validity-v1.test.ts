import { describe, expect, it } from 'vitest';

import { DKGPublisher } from '../src/dkg-publisher.js';

// An invalid update id used to have no guard at all on this path: the first
// thing it met was the attestation requirement, so a zero or garbage kaId was
// reported as a missing seal and the id that caused it was never named. That is
// how the ProfileManager zero-id routing bug presented, and naming the wrong
// subsystem is what made it expensive to diagnose.
//
// These call the real method through the prototype with an empty receiver, and
// that shape is the assertion rather than a convenience: the guard must run
// before anything touches `this`. Move it below a dependency access and these
// go red with a TypeError instead of the expected message, which is exactly the
// regression worth catching -- an entry guard that runs after the first
// dependency use is not an entry guard.
describe('DKGPublisher.update argument validity', () => {
  const callUpdate = (kaId: bigint) =>
    (DKGPublisher.prototype.update as unknown as (
      this: unknown, id: bigint, options: unknown,
    ) => Promise<unknown>).call({}, kaId, {});

  it('rejects a zero kaId by naming the id, not the missing attestation', async () => {
    await expect(callUpdate(0n)).rejects.toThrow(
      'Invalid update kaId 0: expected a positive uint256',
    );
  });

  it('rejects a negative kaId', async () => {
    await expect(callUpdate(-1n)).rejects.toThrow(
      'Invalid update kaId -1: expected a positive uint256',
    );
  });

  it('rejects a kaId at the uint256 ceiling', async () => {
    await expect(callUpdate(1n << 256n)).rejects.toThrow(/expected a positive uint256/);
  });

  // The upper bound is exclusive, so the largest legal id must pass the guard.
  // It fails later for want of a receiver, which is the point: the guard let it
  // through. Without this row the guard could be `kaId <= 0n || true` and the
  // three rejections above would all still pass.
  it('admits the largest legal kaId, failing only afterwards', async () => {
    await expect(callUpdate((1n << 256n) - 1n)).rejects.not.toThrow(
      /expected a positive uint256/,
    );
  });
});
