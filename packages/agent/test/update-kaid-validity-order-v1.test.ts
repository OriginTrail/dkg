import { describe, expect, it } from 'vitest';

import { PublishMethods } from '../src/dkg-agent-publish.js';

// This pins ORDER, not existence. The id check already existed here -- it just
// fired third, after the rootless-update lock had been taken on the very id
// being rejected and after the attestation requirement had already thrown. So
// an invalid id was reported as a missing seal, the same wrong-subsystem
// diagnosis the publisher produced.
//
// Scope of the pin, stated exactly because an earlier revision of this file
// overclaimed it: these rows pin the guard ahead of the ATTESTATION and ahead of
// any `this` access. The lock boundary specifically is NOT pinned -- see the
// note on the last row.
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

  // NOTE ON WHAT THIS ROW DOES *NOT* PROVE, measured rather than assumed.
  // It proves the guard runs before any `this` access -- with an empty receiver,
  // reaching the callback body throws a TypeError on `this.log` instead of this
  // message. It does NOT prove the guard runs before `withRootlessUpdateLock`.
  // Moving the guard to be the callback's first statement leaves this file
  // 3/3 green: the lock would be taken and the id still refused with this exact
  // error. The guard IS above the lock in source, and the rationale is at the
  // site, but that position is currently unpinned -- see the residual on #2052.
  // Asserting it needs the lock held pending across the call, and both
  // `withRootlessUpdateLock` and `rootlessUpdateLocks` are module-private while
  // the first `await` inside the callback (`skolemizeKnowledgeAssetParts`) sits
  // past a working `this.log`, a supplied attestation and the named-graph
  // assertion -- i.e. a near-real agent, not a prototype call.
  it('rejects before any dependency access', async () => {
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
