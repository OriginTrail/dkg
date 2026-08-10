import { describe, expect, it, vi } from 'vitest';

import type { PublishOptions, PublishResult, Publisher } from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';

import { ProfileManager } from '../src/profile-manager.js';

/**
 * A local/no-chain publish carries no minted knowledge-asset id, so a republish
 * has nothing on chain to update and must publish again. Observed in the agent
 * suite as "No positive on-chain context graph id resolved from 'agents' —
 * skipping on-chain publish", then "Storing N triples in local store (no
 * on-chain CG id)"; the resulting PublishResult carries `kaId: 0n`.
 */
const LOCAL_ONLY_KA_ID = 0n;

function publishResult(kaId: bigint): PublishResult {
  return {
    kaId,
    ual: `did:dkg:ka:${kaId.toString()}`,
    merkleRoot: new Uint8Array(32),
    kaManifest: [],
    status: 'tentative',
  } as unknown as PublishResult;
}

function stubStore(): TripleStore {
  return {
    query: async () => ({ type: 'bindings', bindings: [] }),
    deleteBySubjectPrefix: async () => undefined,
  } as unknown as TripleStore;
}

/** Mirrors the real update guard, which rejects before validating the id. */
function stubPublisher(mintedKaId: bigint) {
  const publish = vi.fn(async (_options: PublishOptions) => publishResult(mintedKaId));
  const update = vi.fn(async (_kaId: bigint, _options: PublishOptions) => {
    throw new Error(
      'Update rejected: on-chain update requires precomputedUpdateAttestation. ' +
        'Sign UpdateAuthorAttestation(kaId, newMerkleRoot, authorAddress) off-band ' +
        'and pass the seal in this call.',
    );
  });
  return { publisher: { publish, update } as unknown as Publisher, publish, update };
}

describe('ProfileManager republish routing', () => {
  it('republishes rather than updating when the first publish minted no on-chain id', async () => {
    const { publisher, publish, update } = stubPublisher(LOCAL_ONLY_KA_ID);
    const manager = new ProfileManager(publisher, stubStore());
    const config = { peerId: 'QmLocalOnly', name: 'LocalBot', skills: [] };

    await manager.publishProfile(config);
    await manager.publishProfile(config);

    // 0n is "no knowledge asset yet", not an id to update. Routing it to
    // update() trips the attestation guard, and the publisher never validates
    // the id at all, so the failure names the attestation and nothing ever
    // mentions the zero id that caused it.
    expect(update).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(2);
    // Gate the routing decision, not the stored id: profileKcId still mirrors
    // what the publisher returned. A fix that nulls the field instead would
    // pass the routing assertions above and silently break this one.
    expect(manager.profileKcId).toBe(LOCAL_ONLY_KA_ID);
  });

  it('updates on republish once a real on-chain id has been minted', async () => {
    const { publisher, publish, update } = stubPublisher(7n);
    const manager = new ProfileManager(publisher, stubStore());
    const config = { peerId: 'QmMinted', name: 'MintedBot', skills: [] };

    await manager.publishProfile(config);
    expect(manager.profileKcId).toBe(7n);

    await expect(manager.publishProfile(config)).rejects.toThrow(
      /requires precomputedUpdateAttestation/,
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toBe(7n);
  });
});
