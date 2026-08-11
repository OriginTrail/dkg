import { describe, expect, it } from 'vitest';

import { PublishMethods } from '../src/dkg-agent-publish.js';

// This pins ORDER, not existence. The id check already existed here -- it just
// fired third, after the rootless-update lock had been taken on the very id
// being rejected and after the attestation requirement had already thrown. So
// an invalid id was reported as a missing seal, the same wrong-subsystem
// diagnosis the publisher produced.
//
// The discriminating call therefore supplies an invalid id AND no attestation:
// both guards would fire, and which message comes back says which ran first.
// Before the reorder this returned the attestation error; it must now name the
// id. Restore the old order and only these go red.
describe('agent update() rejects an invalid id before capability or effect', () => {
  const callUpdate = (kaId: bigint) =>
    (PublishMethods.prototype.update as unknown as (
      this: unknown, id: bigint, contextGraphId: string, quads: unknown[],
    ) => Promise<unknown>).call({}, kaId, 'urn:test:context-graph', []);

  it('names the zero id rather than the missing attestation', async () => {
    // No attestation is supplied, so the seal guard would also throw. Getting
    // the id message back is what proves the id check runs first.
    await expect(callUpdate(0n)).rejects.toThrow(
      'Invalid graph-scoped kaId 0: expected a positive uint256',
    );
  });

  it('rejects before taking the rootless-update lock', async () => {
    // The lock is keyed on kaId and the whole body runs inside its callback, so
    // a guard placed inside would contend a lock for an id about to be refused.
    // With an empty receiver the callback cannot run at all: reaching the lock
    // throws a TypeError on `this.log` instead of this message.
    await expect(callUpdate(-5n)).rejects.toThrow(
      'Invalid graph-scoped kaId -5: expected a positive uint256',
    );
  });

  // Non-vacuity: the largest legal id must clear the guard and fail later, or
  // the predicate could refuse everything and the rows above would not notice.
  it('admits the largest legal kaId, failing only afterwards', async () => {
    await expect(callUpdate((1n << 256n) - 1n)).rejects.not.toThrow(
      /expected a positive uint256/,
    );
  });
});
