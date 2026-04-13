import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { Chronos, ContextGraphValueStorage, Hub } from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  CGV: ContextGraphValueStorage;
  Chronos: Chronos;
  Hub: Hub;
};

describe('@unit ContextGraphValueStorage', () => {
  let accounts: SignerWithAddress[];
  let CGV: ContextGraphValueStorage;
  let ChronosCtr: Chronos;
  let HubCtr: Hub;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture(['ContextGraphValueStorage']);
    const CGVLocal = await hre.ethers.getContract<ContextGraphValueStorage>(
      'ContextGraphValueStorage',
    );
    const ChronosLocal = await hre.ethers.getContract<Chronos>('Chronos');
    const HubLocal = await hre.ethers.getContract<Hub>('Hub');
    const accountsLocal = await hre.ethers.getSigners();
    return {
      accounts: accountsLocal,
      CGV: CGVLocal,
      Chronos: ChronosLocal,
      Hub: HubLocal,
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      CGV,
      Chronos: ChronosCtr,
      Hub: HubCtr,
    } = await loadFixture(deployFixture));
  });

  it('Should have correct name and version', async () => {
    expect(await CGV.name()).to.equal('ContextGraphValueStorage');
    expect(await CGV.version()).to.equal('1.0.0');
  });

  it('Single-epoch publish: value lives in start epoch, zero after', async () => {
    const cgId = 1n;
    const currentEpoch = await ChronosCtr.getCurrentEpoch();

    await CGV.addCGValueForEpochRange(cgId, currentEpoch, 1, 1000);

    expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch)).to.equal(1000);
    expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch + 1n)).to.equal(0);

    expect(await CGV.getTotalValueAtEpoch(currentEpoch)).to.equal(1000);
    expect(await CGV.getTotalValueAtEpoch(currentEpoch + 1n)).to.equal(0);
  });

  it('Multi-epoch publish: V/L per epoch for L epochs, zero thereafter', async () => {
    const cgId = 2n;
    const currentEpoch = await ChronosCtr.getCurrentEpoch();

    await CGV.addCGValueForEpochRange(cgId, currentEpoch, 10, 1000);

    for (let i = 0n; i < 10n; i++) {
      expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch + i)).to.equal(100);
      expect(await CGV.getTotalValueAtEpoch(currentEpoch + i)).to.equal(100);
    }
    expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch + 10n)).to.equal(0);
    expect(await CGV.getTotalValueAtEpoch(currentEpoch + 10n)).to.equal(0);
  });

  it('Two concurrent CGs: per-CG totals correct, global total equals sum', async () => {
    const cgA = 10n;
    const cgB = 11n;
    const currentEpoch = await ChronosCtr.getCurrentEpoch();

    // CG A: 1000 over 5 epochs => 200/epoch
    await CGV.addCGValueForEpochRange(cgA, currentEpoch, 5, 1000);
    // CG B: 600 over 3 epochs => 200/epoch
    await CGV.addCGValueForEpochRange(cgB, currentEpoch, 3, 600);

    for (let i = 0n; i < 3n; i++) {
      expect(await CGV.getCGValueAtEpoch(cgA, currentEpoch + i)).to.equal(200);
      expect(await CGV.getCGValueAtEpoch(cgB, currentEpoch + i)).to.equal(200);
      expect(await CGV.getTotalValueAtEpoch(currentEpoch + i)).to.equal(400);
    }
    // Epochs 3-4: only CG A active
    for (let i = 3n; i < 5n; i++) {
      expect(await CGV.getCGValueAtEpoch(cgA, currentEpoch + i)).to.equal(200);
      expect(await CGV.getCGValueAtEpoch(cgB, currentEpoch + i)).to.equal(0);
      expect(await CGV.getTotalValueAtEpoch(currentEpoch + i)).to.equal(200);
    }
    // Epoch 5: both expired
    expect(await CGV.getCGValueAtEpoch(cgA, currentEpoch + 5n)).to.equal(0);
    expect(await CGV.getTotalValueAtEpoch(currentEpoch + 5n)).to.equal(0);
  });

  it('Overlapping publishes on same CG sum per epoch', async () => {
    const cgId = 20n;
    const currentEpoch = await ChronosCtr.getCurrentEpoch();

    // 4000 over 4 epochs starting at currentEpoch => 1000/epoch, range
    // [currentEpoch, currentEpoch+3]
    await CGV.addCGValueForEpochRange(cgId, currentEpoch, 4, 4000);
    // 900 over 3 epochs starting at currentEpoch+2 => 300/epoch, range
    // [currentEpoch+2, currentEpoch+4]
    await CGV.addCGValueForEpochRange(cgId, currentEpoch + 2n, 3, 900);

    expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch)).to.equal(1000);
    expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch + 1n)).to.equal(1000);
    // Overlap region
    expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch + 2n)).to.equal(1300);
    expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch + 3n)).to.equal(1300);
    // Only second publish active
    expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch + 4n)).to.equal(300);
    expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch + 5n)).to.equal(0);
  });

  it('Finalize is idempotent across the post-advance boundary: second call in same epoch is a no-op on lastFinalized', async () => {
    // Regression guard: we must exercise the `if (currentEpoch > 1)` branch in
    // addCGValueForEpochRange so _finalizeCGValueUpTo actually writes to
    // storage. Starting at epoch 1 (fresh fixture) skips the branch entirely
    // and makes the idempotency assertion vacuous — advance Chronos first.
    const cgId = 30n;
    const epoch1 = await ChronosCtr.getCurrentEpoch();

    // Seed epoch 1 with a publish we can later finalize.
    await CGV.addCGValueForEpochRange(cgId, epoch1, 2, 600);

    // Advance past epoch 1 so the next call triggers finalization up to
    // epoch1.
    const epochLength = await ChronosCtr.epochLength();
    await time.increase(Number(epochLength) + 1);

    const epoch2 = await ChronosCtr.getCurrentEpoch();
    expect(epoch2).to.be.gt(epoch1);

    // First post-advance call finalizes [epoch1, epoch2 - 1]. Use a
    // different cgId for the triggering publish so we observe finalize
    // behaviour without mutating cgId's diffs.
    const triggerCg = 31n;
    const tx1 = await CGV.addCGValueForEpochRange(triggerCg, epoch2, 1, 10);
    await expect(tx1)
      .to.emit(CGV, 'CGValueFinalized')
      .withArgs(triggerCg, epoch1, epoch2 - 1n);

    // cgId has NOT been touched by tx1, so its lastFinalized is still 0.
    // Force-finalize it with another publish on cgId itself.
    const tx2 = await CGV.addCGValueForEpochRange(cgId, epoch2, 1, 10);
    await expect(tx2)
      .to.emit(CGV, 'CGValueFinalized')
      .withArgs(cgId, epoch1, epoch2 - 1n);

    const lastFinalizedAfterFirstCgTouch = await CGV.cgLastFinalizedEpoch(cgId);
    expect(lastFinalizedAfterFirstCgTouch).to.equal(epoch2 - 1n);

    // Snapshot the crystallized cumulative at epoch1 so we can prove the
    // second call is a no-op for that slot.
    const cgCumulativeAtEpoch1Before = await CGV.cgValueCumulative(
      cgId,
      epoch1,
    );

    // Second call in the same epoch. _finalizeCGValueUpTo's early return
    // (epoch <= lastFinalized) must fire — cgLastFinalizedEpoch must NOT
    // advance, cumulative at epoch1 must NOT be mutated, and NO
    // CGValueFinalized event must be emitted for cgId.
    const tx3 = await CGV.addCGValueForEpochRange(cgId, epoch2, 1, 10);
    await expect(tx3).to.not.emit(CGV, 'CGValueFinalized');

    expect(await CGV.cgLastFinalizedEpoch(cgId)).to.equal(
      lastFinalizedAfterFirstCgTouch,
    );
    expect(await CGV.cgValueCumulative(cgId, epoch1)).to.equal(
      cgCumulativeAtEpoch1Before,
    );
  });

  it('Finalize writes cumulative to storage after Chronos advances past the publish epoch', async () => {
    // Direct coverage for the mutate-path finalize branch: starts at epoch 1,
    // publishes into epoch 1, advances a full epoch, then triggers
    // finalization by calling addCGValueForEpochRange again. After the second
    // call the cumulative at epoch 1 must be crystallized in storage (not
    // just simulated).
    const cgId = 35n;
    const epoch1 = await ChronosCtr.getCurrentEpoch();
    expect(epoch1).to.equal(1n);

    // Publish 1000 over 10 epochs → 100/epoch active in epoch1..epoch10.
    await CGV.addCGValueForEpochRange(cgId, epoch1, 10, 1000);

    // Pre-advance: lastFinalized still 0, cumulative[cgId][1] still 0
    // (simulate-only).
    expect(await CGV.cgLastFinalizedEpoch(cgId)).to.equal(0n);
    expect(await CGV.cgValueCumulative(cgId, epoch1)).to.equal(0n);
    expect(await CGV.globalLastFinalizedEpoch()).to.equal(0n);
    expect(await CGV.totalValueCumulative(epoch1)).to.equal(0n);

    // Advance one full epoch.
    const epochLength = await ChronosCtr.epochLength();
    await time.increase(Number(epochLength) + 1);
    const epoch2 = await ChronosCtr.getCurrentEpoch();
    expect(epoch2).to.equal(epoch1 + 1n);

    // Second call: startEpoch == currentEpoch (not backfill), triggers
    // _finalizeCGValueUpTo(cgId, epoch2 - 1) == _finalizeCGValueUpTo(cgId, 1).
    await CGV.addCGValueForEpochRange(cgId, epoch2, 1, 50);

    // Per-CG: cumulative[epoch1] is now 100 (V/L = 1000/10), lastFinalized = 1.
    expect(await CGV.cgLastFinalizedEpoch(cgId)).to.equal(epoch1);
    expect(await CGV.cgValueCumulative(cgId, epoch1)).to.equal(100n);

    // Global mirror.
    expect(await CGV.globalLastFinalizedEpoch()).to.equal(epoch1);
    expect(await CGV.totalValueCumulative(epoch1)).to.equal(100n);
  });

  it('Finalize across a gap: dormant for N epochs then single call finalizes all intermediate epochs', async () => {
    const cgId = 40n;
    const startEpoch = await ChronosCtr.getCurrentEpoch();

    // Publish spanning 10 epochs.
    await CGV.addCGValueForEpochRange(cgId, startEpoch, 10, 1000);

    const epochLength = await ChronosCtr.epochLength();
    // Advance time by 5 epochs without touching CGV — finalization becomes stale.
    await time.increase(Number(epochLength) * 5 + 1);

    const nowEpoch = await ChronosCtr.getCurrentEpoch();
    expect(nowEpoch).to.be.gte(startEpoch + 5n);

    // Trigger finalization by publishing a new value to a DIFFERENT cgId —
    // exercises the global finalize path but leaves cgId dormant.
    await CGV.addCGValueForEpochRange(cgId + 1n, nowEpoch, 1, 1);

    // cgId has NOT been finalized yet (different cgId triggered only global + cgId+1).
    // The simulation path must still return correct values for cgId across the gap.
    for (let i = 0n; i < 10n; i++) {
      expect(await CGV.getCGValueAtEpoch(cgId, startEpoch + i)).to.equal(100);
    }
    expect(await CGV.getCGValueAtEpoch(cgId, startEpoch + 10n)).to.equal(0);

    // Now call into cgId directly to force its finalization up to currentEpoch-1.
    await CGV.addCGValueForEpochRange(cgId, nowEpoch + 100n, 1, 1);
    const lastFinalized = await CGV.cgLastFinalizedEpoch(cgId);
    expect(lastFinalized).to.equal(nowEpoch - 1n);

    // Finalized values for the gap epochs must match the simulated values.
    for (let i = 0n; i < 10n; i++) {
      if (startEpoch + i <= lastFinalized) {
        expect(await CGV.cgValueCumulative(cgId, startEpoch + i)).to.equal(100);
      }
    }
  });

  it('Simulation returns correct value for non-finalized future epoch', async () => {
    const cgId = 50n;
    const currentEpoch = await ChronosCtr.getCurrentEpoch();

    await CGV.addCGValueForEpochRange(cgId, currentEpoch + 5n, 4, 800);

    // lastFinalized still <= currentEpoch - 1; reading currentEpoch+6 must
    // traverse the diff map via _simulateCGValueFinalization.
    expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch + 5n)).to.equal(200);
    expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch + 6n)).to.equal(200);
    expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch + 8n)).to.equal(200);
    expect(await CGV.getCGValueAtEpoch(cgId, currentEpoch + 9n)).to.equal(0);
    // Global same semantics
    expect(await CGV.getTotalValueAtEpoch(currentEpoch + 5n)).to.equal(200);
    expect(await CGV.getTotalValueAtEpoch(currentEpoch + 9n)).to.equal(0);
  });

  it('getCurrentCGValue / getCurrentTotalValue mirror getCGValueAtEpoch at current epoch', async () => {
    const cgId = 60n;
    const currentEpoch = await ChronosCtr.getCurrentEpoch();
    await CGV.addCGValueForEpochRange(cgId, currentEpoch, 2, 500);

    // 500/2 = 250 per epoch
    expect(await CGV.getCurrentCGValue(cgId)).to.equal(250);
    expect(await CGV.getCurrentTotalValue()).to.equal(250);
  });

  it('onlyContracts: non-Hub-registered EOA cannot call addCGValueForEpochRange', async () => {
    const currentEpoch = await ChronosCtr.getCurrentEpoch();
    // accounts[1] is not the Hub owner nor registered as a Hub contract.
    const stranger = accounts[1];
    await expect(
      CGV.connect(stranger).addCGValueForEpochRange(
        1n,
        currentEpoch,
        1,
        1000,
      ),
    ).to.be.reverted;
  });

  it('Reverts on zero lifetime and zero value', async () => {
    const currentEpoch = await ChronosCtr.getCurrentEpoch();
    await expect(
      CGV.addCGValueForEpochRange(1n, currentEpoch, 0, 1000),
    ).to.be.revertedWithCustomError(CGV, 'ZeroLifetime');
    await expect(
      CGV.addCGValueForEpochRange(1n, currentEpoch, 1, 0),
    ).to.be.revertedWithCustomError(CGV, 'ZeroValue');
  });

  it('Chronos and Hub are wired via initialize', async () => {
    expect(await CGV.chronos()).to.equal(await ChronosCtr.getAddress());
    expect(await CGV.hub()).to.equal(await HubCtr.getAddress());
  });

  it('Emits CGValueAddedForEpochRange with startEpoch, endEpoch, lifetime, value, perEpoch', async () => {
    const cgId = 70n;
    const currentEpoch = await ChronosCtr.getCurrentEpoch();
    const lifetime = 5n;
    const value = 1000n;
    const perEpoch = value / lifetime;

    await expect(CGV.addCGValueForEpochRange(cgId, currentEpoch, lifetime, value))
      .to.emit(CGV, 'CGValueAddedForEpochRange')
      .withArgs(
        cgId,
        currentEpoch,
        currentEpoch + lifetime - 1n,
        lifetime,
        value,
        perEpoch,
      );
  });

  it('Emits CGValueFinalized and GlobalValueFinalized when finalize actually runs', async () => {
    const cgId = 71n;
    const epoch1 = await ChronosCtr.getCurrentEpoch();
    expect(epoch1).to.equal(1n);

    // Seed epoch 1.
    await CGV.addCGValueForEpochRange(cgId, epoch1, 2, 400);

    // Advance one epoch.
    const epochLength = await ChronosCtr.epochLength();
    await time.increase(Number(epochLength) + 1);
    const epoch2 = await ChronosCtr.getCurrentEpoch();

    // Trigger finalize up to epoch1. Assert both events fire with the
    // expected [startEpoch, endEpoch] window.
    const tx = await CGV.addCGValueForEpochRange(cgId, epoch2, 1, 50);
    await expect(tx)
      .to.emit(CGV, 'CGValueFinalized')
      .withArgs(cgId, epoch1, epoch2 - 1n);
    await expect(tx)
      .to.emit(CGV, 'GlobalValueFinalized')
      .withArgs(epoch1, epoch2 - 1n);
  });

  it('Boundary meeting: publish2 starts exactly where publish1 expires', async () => {
    // Two publishes on the same CG whose active windows touch but do not
    // overlap. Proves the negative diff at `startEpoch1 + lifetime1`
    // cancels the first publish exactly where the second begins, so the
    // epoch at the boundary reads exactly perEpoch2.
    const cgId = 72n;
    const startEpoch1 = await ChronosCtr.getCurrentEpoch();
    const lifetime1 = 3n;
    await CGV.addCGValueForEpochRange(cgId, startEpoch1, lifetime1, 900); // 300/epoch

    const startEpoch2 = startEpoch1 + lifetime1; // exactly when publish1 expires
    const lifetime2 = 2n;
    await CGV.addCGValueForEpochRange(cgId, startEpoch2, lifetime2, 1000); // 500/epoch

    // Publish1 active: startEpoch1 .. startEpoch1 + lifetime1 - 1 → 300
    for (let i = 0n; i < lifetime1; i++) {
      expect(await CGV.getCGValueAtEpoch(cgId, startEpoch1 + i)).to.equal(300);
    }
    // Boundary: must be exactly 500 (not 800, not 0).
    expect(await CGV.getCGValueAtEpoch(cgId, startEpoch2)).to.equal(500);
    expect(await CGV.getCGValueAtEpoch(cgId, startEpoch2 + 1n)).to.equal(500);
    // After publish2 expires.
    expect(await CGV.getCGValueAtEpoch(cgId, startEpoch2 + lifetime2)).to.equal(0);
  });

  it('finalizeCGValueUpTo crystallizes cgValueCumulative to storage and emits CGValueFinalized', async () => {
    const cgId = 80n;
    const epoch1 = await ChronosCtr.getCurrentEpoch();
    expect(epoch1).to.equal(1n);

    // Seed: 1000 over 10 epochs -> 100/epoch.
    await CGV.addCGValueForEpochRange(cgId, epoch1, 10, 1000);

    // Advance 2 full epochs so currentEpoch == 3 and we may finalize the
    // strictly past epochs 1 and 2. The external finalizers reject
    // current-or-future epochs (`FutureOrCurrentEpoch`) — see invariant:
    // cgLastFinalizedEpoch never catches up to currentEpoch, otherwise a
    // subsequent same-epoch write would write into cgValueDiff while the
    // crystallized cumulative goes stale and the read fast path returns it.
    const epochLength = await ChronosCtr.epochLength();
    await time.increase(Number(epochLength) * 2 + 1);
    const nowEpoch = await ChronosCtr.getCurrentEpoch();
    expect(nowEpoch).to.equal(epoch1 + 2n);

    // Pre-assert: nothing finalized yet (no mutate call touched cgId post-publish).
    expect(await CGV.cgLastFinalizedEpoch(cgId)).to.equal(0n);

    // Finalize up to epoch 2 (the last past epoch; currentEpoch is 3).
    const targetEpoch = epoch1 + 1n;
    const tx = await CGV.finalizeCGValueUpTo(cgId, targetEpoch);
    await expect(tx)
      .to.emit(CGV, 'CGValueFinalized')
      .withArgs(cgId, epoch1, targetEpoch);

    expect(await CGV.cgLastFinalizedEpoch(cgId)).to.equal(targetEpoch);
    expect(await CGV.cgValueCumulative(cgId, epoch1)).to.equal(100n);
    expect(await CGV.cgValueCumulative(cgId, epoch1 + 1n)).to.equal(100n);
  });

  it('finalizeGlobalValueUpTo crystallizes totalValueCumulative to storage and emits GlobalValueFinalized', async () => {
    const cgId = 81n;
    const epoch1 = await ChronosCtr.getCurrentEpoch();
    expect(epoch1).to.equal(1n);

    await CGV.addCGValueForEpochRange(cgId, epoch1, 10, 1000);

    // Advance 2 full epochs (see sibling test for invariant rationale).
    const epochLength = await ChronosCtr.epochLength();
    await time.increase(Number(epochLength) * 2 + 1);
    const nowEpoch = await ChronosCtr.getCurrentEpoch();
    expect(nowEpoch).to.equal(epoch1 + 2n);

    expect(await CGV.globalLastFinalizedEpoch()).to.equal(0n);

    const targetEpoch = epoch1 + 1n;
    const tx = await CGV.finalizeGlobalValueUpTo(targetEpoch);
    await expect(tx)
      .to.emit(CGV, 'GlobalValueFinalized')
      .withArgs(epoch1, targetEpoch);

    expect(await CGV.globalLastFinalizedEpoch()).to.equal(targetEpoch);
    expect(await CGV.totalValueCumulative(epoch1)).to.equal(100n);
    expect(await CGV.totalValueCumulative(epoch1 + 1n)).to.equal(100n);
  });

  it('External finalizers are idempotent no-ops when epoch already finalized', async () => {
    const cgId = 82n;
    const epoch1 = await ChronosCtr.getCurrentEpoch();
    expect(epoch1).to.equal(1n);

    await CGV.addCGValueForEpochRange(cgId, epoch1, 5, 500);

    // Advance 2 full epochs so currentEpoch == 3 and target epoch 1 is in
    // the strictly-past window the external finalizers accept.
    const epochLength = await ChronosCtr.epochLength();
    await time.increase(Number(epochLength) * 2 + 1);
    const nowEpoch = await ChronosCtr.getCurrentEpoch();
    expect(nowEpoch).to.equal(epoch1 + 2n);

    // First call finalizes up to epoch1 (a past epoch).
    await CGV.finalizeCGValueUpTo(cgId, epoch1);
    await CGV.finalizeGlobalValueUpTo(epoch1);

    const cgLastFinalizedBefore = await CGV.cgLastFinalizedEpoch(cgId);
    const globalLastFinalizedBefore = await CGV.globalLastFinalizedEpoch();
    expect(cgLastFinalizedBefore).to.equal(epoch1);
    expect(globalLastFinalizedBefore).to.equal(epoch1);

    // Second call with the same (already-finalized) past epoch: must not
    // emit and must not advance state.
    const tx1 = await CGV.finalizeCGValueUpTo(cgId, epoch1);
    await expect(tx1).to.not.emit(CGV, 'CGValueFinalized');

    const tx2 = await CGV.finalizeGlobalValueUpTo(epoch1);
    await expect(tx2).to.not.emit(CGV, 'GlobalValueFinalized');

    expect(await CGV.cgLastFinalizedEpoch(cgId)).to.equal(cgLastFinalizedBefore);
    expect(await CGV.globalLastFinalizedEpoch()).to.equal(
      globalLastFinalizedBefore,
    );
  });

  it('onlyContracts: non-Hub-registered EOA cannot call external finalizers', async () => {
    const stranger = accounts[1];
    // Use a past epoch as the target so the FutureOrCurrentEpoch guard does
    // not trip first — we want to assert the access-control revert. Advance
    // Chronos so epoch 1 is strictly in the past.
    const epoch1 = await ChronosCtr.getCurrentEpoch();
    const epochLength = await ChronosCtr.epochLength();
    await time.increase(Number(epochLength) + 1);
    const nowEpoch = await ChronosCtr.getCurrentEpoch();
    expect(nowEpoch).to.be.gt(epoch1);

    await expect(
      CGV.connect(stranger).finalizeCGValueUpTo(1n, epoch1),
    ).to.be.reverted;
    await expect(
      CGV.connect(stranger).finalizeGlobalValueUpTo(epoch1),
    ).to.be.reverted;
  });

  it('finalizeCGValueUpTo reverts FutureOrCurrentEpoch on current epoch', async () => {
    const cgId = 90n;
    const epochLength = await ChronosCtr.epochLength();
    // Advance so we are past epoch 1, otherwise the guard could be confused
    // with an off-by-one boundary test.
    await time.increase(Number(epochLength) * 2 + 1);
    const nowEpoch = await ChronosCtr.getCurrentEpoch();

    await expect(
      CGV.finalizeCGValueUpTo(cgId, nowEpoch),
    ).to.be.revertedWithCustomError(CGV, 'FutureOrCurrentEpoch');
  });

  it('finalizeCGValueUpTo reverts FutureOrCurrentEpoch on future epoch', async () => {
    const cgId = 91n;
    const epochLength = await ChronosCtr.epochLength();
    await time.increase(Number(epochLength) * 2 + 1);
    const nowEpoch = await ChronosCtr.getCurrentEpoch();

    await expect(
      CGV.finalizeCGValueUpTo(cgId, nowEpoch + 5n),
    ).to.be.revertedWithCustomError(CGV, 'FutureOrCurrentEpoch');
  });

  it('finalizeGlobalValueUpTo reverts FutureOrCurrentEpoch on current epoch', async () => {
    const epochLength = await ChronosCtr.epochLength();
    await time.increase(Number(epochLength) * 2 + 1);
    const nowEpoch = await ChronosCtr.getCurrentEpoch();

    await expect(
      CGV.finalizeGlobalValueUpTo(nowEpoch),
    ).to.be.revertedWithCustomError(CGV, 'FutureOrCurrentEpoch');
  });

  it('finalizeGlobalValueUpTo reverts FutureOrCurrentEpoch on future epoch', async () => {
    const epochLength = await ChronosCtr.epochLength();
    await time.increase(Number(epochLength) * 2 + 1);
    const nowEpoch = await ChronosCtr.getCurrentEpoch();

    await expect(
      CGV.finalizeGlobalValueUpTo(nowEpoch + 5n),
    ).to.be.revertedWithCustomError(CGV, 'FutureOrCurrentEpoch');
  });

  it('Cannot finalize current epoch; subsequent same-epoch write is visible via simulation', async () => {
    // Regression pin for the stale-read invariant: even if a caller tries to
    // crystallize the current epoch, the contract must reject it so that
    // later same-epoch diff writes remain visible to readers via the
    // simulation path.
    const cgId = 100n;
    const epochLength = await ChronosCtr.epochLength();
    // Advance so currentEpoch == 3.
    await time.increase(Number(epochLength) * 2 + 1);
    const nowEpoch = await ChronosCtr.getCurrentEpoch();
    expect(nowEpoch).to.equal(3n);

    // Publish 1: 500 over 1 epoch at currentEpoch.
    await CGV.addCGValueForEpochRange(cgId, nowEpoch, 1, 500);

    // Attempt to finalize the current epoch — must revert.
    await expect(
      CGV.finalizeCGValueUpTo(cgId, nowEpoch),
    ).to.be.revertedWithCustomError(CGV, 'FutureOrCurrentEpoch');

    // Read via simulation reflects publish 1.
    expect(await CGV.getCGValueAtEpoch(cgId, nowEpoch)).to.equal(500n);

    // Publish 2: another 300 over 1 epoch at the same currentEpoch.
    await CGV.addCGValueForEpochRange(cgId, nowEpoch, 1, 300);

    // Read via simulation reflects BOTH publishes.
    expect(await CGV.getCGValueAtEpoch(cgId, nowEpoch)).to.equal(800n);

    // Sanity: both single-epoch publishes have already expired by next epoch.
    expect(await CGV.getCGValueAtEpoch(cgId, nowEpoch + 1n)).to.equal(0n);
  });

  it('Reverts BackfillForbidden when startEpoch < currentEpoch', async () => {
    // Seed the state at epoch 1 so there is "state to backfill into".
    const cgId = 73n;
    const epoch1 = await ChronosCtr.getCurrentEpoch();
    await CGV.addCGValueForEpochRange(cgId, epoch1, 2, 200);

    // Advance to epoch 2.
    const epochLength = await ChronosCtr.epochLength();
    await time.increase(Number(epochLength) + 1);
    const epoch2 = await ChronosCtr.getCurrentEpoch();
    expect(epoch2).to.be.gt(epoch1);

    // Backfill attempt into epoch1 (now finalized) must revert.
    await expect(
      CGV.addCGValueForEpochRange(cgId, epoch1, 1, 100),
    ).to.be.revertedWithCustomError(CGV, 'BackfillForbidden');
  });
});
