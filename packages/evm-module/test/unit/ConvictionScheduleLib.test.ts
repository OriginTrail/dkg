// ConvictionScheduleLib: a Conviction Account's scheduled staker emission per
// epoch, S(e), rebuilt from its stored terms (through ConvictionScheduleLibHarness).
//
// S(e) is checked to the wei against the shared emission model
// (test/helpers/emission-model.ts), which the emission schedule suite checks
// against the contracts themselves:
//   - directly: each window amount R_w spread by prorateActiveSink from epoch
//     anchor + w, summed per epoch, for L in {1, 2, 12, 60}, a time remaining
//     tr of 1 second, a third of an epoch and a whole epoch, and commitments
//     with dust, plus seeded window amounts that differ per window and include
//     zeros;
//   - through a real Chronos: the per-window schedule scheduleModel derives
//     from each window's close equals S with a single anchor and tr, which is
//     the property that makes S exact for accounts scheduled at creation.
// It also checks that the sum over the span is the sum of R_w, that S is 0
// outside the span, and the build reverts.

import { expect } from 'chai';
import hre from 'hardhat';

import { Chronos, ConvictionScheduleLibHarness } from '../../typechain';
import { PoolModel, prorateActiveSink, scheduleModel } from '../helpers/emission-model';

const DAY = 86_400n;
const TRAC = 10n ** 18n;
const MAX_UINT96 = (1n << 96n) - 1n;

/** Per-epoch emission of the windows, with no EpochStorage remainder carry. */
function emissionModel(
  anchor: bigint,
  lock: bigint,
  epLen: bigint,
  timeRemaining: bigint,
  windowAmounts: bigint[],
): Map<bigint, bigint> {
  const pool = new PoolModel(0n);
  windowAmounts.forEach((amount, w) => {
    if (amount === 0n) return;
    for (const r of prorateActiveSink(amount, anchor + BigInt(w), lock, epLen, timeRemaining)) {
      pool.add(r);
    }
  });
  // Every range divides evenly, so no carry ever builds up.
  expect(pool.remainder).to.equal(0n);
  return pool.perEpoch;
}

/** Window amounts of an account scheduled at creation: B per window, dust on the last. */
function exactWindows(committed: bigint, lock: bigint): bigint[] {
  const base = committed / lock;
  const dust = committed - base * lock;
  return Array.from({ length: Number(lock) }, (_, w) => (BigInt(w) === lock - 1n ? base + dust : base));
}

/** Deterministic window amounts that differ per window: zeros, sub-lock dust and large values. */
function seededWindows(lock: bigint, seed: bigint): bigint[] {
  let x = seed;
  const next = () => {
    x = (x * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
    return x;
  };
  return Array.from({ length: Number(lock) }, () => {
    const r = next();
    switch (r % 5n) {
      case 0n:
        return 0n;
      case 1n:
        return r % lock; // below the lock: the whole amount lands on the final epoch
      default:
        return (r * next()) % (1n << 90n);
    }
  });
}

describe('@unit ConvictionScheduleLib', () => {
  let harness: ConvictionScheduleLibHarness;

  before(async () => {
    const Factory = await hre.ethers.getContractFactory('ConvictionScheduleLibHarness');
    harness = (await Factory.deploy()) as unknown as ConvictionScheduleLibHarness;
    await harness.waitForDeployment();
  });

  /** Check S against the model over the span and two epochs either side of it. */
  async function expectMatchesModel(
    anchor: bigint,
    lock: bigint,
    epLen: bigint,
    timeRemaining: bigint,
    windowAmounts: bigint[],
    expected: Map<bigint, bigint>,
  ): Promise<void> {
    const first = anchor;
    const last = anchor + 2n * lock - 1n;
    const from = anchor >= 2n ? anchor - 2n : 0n;
    const to = last + 2n;
    const got = await harness.emissionRange(anchor, lock, epLen, timeRemaining, windowAmounts, from, to);

    let sum = 0n;
    for (let e = from; e <= to; e++) {
      const s = got[Number(e - from)];
      expect(s, `S(${e}) for L=${lock}, tr=${timeRemaining}`).to.equal(expected.get(e) ?? 0n);
      if (e < first || e > last) expect(s, `S(${e}) outside the span`).to.equal(0n);
      sum += s;
    }
    expect(sum, 'the sum over the span is the sum of the window amounts').to.equal(
      windowAmounts.reduce((a, b) => a + b, 0n),
    );

    // emissionAt agrees with emissionRange at the span's edges and its middle.
    for (const e of [first, anchor + lock - 1n, anchor + lock, last]) {
      expect(await harness.emissionAt(anchor, lock, epLen, timeRemaining, windowAmounts, e)).to.equal(
        got[Number(e - from)],
      );
    }
  }

  const E = DAY;
  for (const lock of [1n, 2n, 12n, 60n]) {
    for (const [trName, tr] of [
      ['1 s', 1n],
      ['E/3', E / 3n],
      ['E', E],
    ] as const) {
      it(`L=${lock}, tr=${trName}: S equals the model for commitments with dust`, async () => {
        const anchor = 1_000n + lock;
        for (const committed of [
          lock * (4_166n * TRAC + 3n) + lock - 1n, // the largest dust a lock allows, L − 1 wei
          lock * (83_333n * TRAC) + 1n, // one wei of dust (none when L is 1)
          lock * 3n, // a tiny commitment: every window's base is 3 wei
        ]) {
          const windows = exactWindows(committed, lock);
          await expectMatchesModel(anchor, lock, E, tr, windows, emissionModel(anchor, lock, E, tr, windows));
        }
      });

      it(`L=${lock}, tr=${trName}: S equals the model for seeded window amounts with zeros`, async () => {
        const anchor = 7n;
        const windows = seededWindows(lock, 0x5eed0000n + lock * 7n + tr);
        await expectMatchesModel(anchor, lock, E, tr, windows, emissionModel(anchor, lock, E, tr, windows));
      });
    }
  }

  it('S is 0 for every epoch when every window amount is 0', async () => {
    const windows = Array.from({ length: 12 }, () => 0n);
    const got = await harness.emissionRange(100n, 12n, E, E / 2n, windows, 90n, 140n);
    expect(got.every((s) => s === 0n)).to.equal(true);
  });

  it('span is [anchor, anchor + 2L - 1]', async () => {
    expect(await harness.span(0n, 1n)).to.deep.equal([0n, 1n]);
    expect(await harness.span(10n, 12n)).to.deep.equal([10n, 33n]);
    expect(await harness.span(500n, 60n)).to.deep.equal([500n, 619n]);
  });

  it('an epoch before the anchor, after the span or far away has no emission', async () => {
    const windows = exactWindows(12_000n * TRAC + 5n, 12n);
    const at = (e: bigint) => harness.emissionAt(100n, 12n, E, E / 3n, windows, e);
    expect(await at(0n)).to.equal(0n);
    expect(await at(99n)).to.equal(0n);
    expect(await at(124n)).to.equal(0n);
    expect(await at(10n ** 30n)).to.equal(0n);
    expect(await at(100n)).to.be.greaterThan(0n);
    expect(await at(123n)).to.be.greaterThan(0n);
  });

  describe('S against the schedule anchored on a real Chronos', () => {
    // Every window closes at T0 + (w + 1)·E, so with fixed-length epochs window w
    // closes in epoch anchor + w with the same time remaining tr. scheduleModel
    // derives each window's anchor and tr from Chronos separately.
    const START = 1_700_000_000n;

    for (const [epLen, label] of [
      [DAY, '1-day epochs'],
      [30n * DAY, '30-day epochs'],
    ] as const) {
      for (const [offsetName, offset] of [
        ['on an epoch boundary', 0n],
        ['mid-epoch', epLen / 3n + 17n],
        ['one second before a boundary', epLen - 1n],
      ] as const) {
        for (const lock of [12n, 60n]) {
          it(`${label}, created ${offsetName}, L=${lock}`, async () => {
            const Factory = await hre.ethers.getContractFactory('Chronos');
            const chronos = (await Factory.deploy(START, epLen)) as unknown as Chronos;
            await chronos.waitForDeployment();

            const createdAt = START + 5n * epLen + offset;
            const committed = 100_000n * TRAC + 11n;
            const model = new PoolModel(0n);
            const { scheduled } = await scheduleModel({
              chronos,
              model,
              committed,
              createdAtTimestamp: createdAt,
              lock,
              epLen,
            });
            expect(scheduled).to.equal(committed);

            const anchor = await chronos.epochAtTimestamp(createdAt + epLen);
            const tr = (await chronos.timestampForEpoch(anchor + 1n)) - (createdAt + epLen);
            expect(tr > 0n && tr <= epLen).to.equal(true);
            await expectMatchesModel(anchor, lock, epLen, tr, exactWindows(committed, lock), model.perEpoch);
          });
        }
      }
    }
  });

  describe('build refusals', () => {
    it('reverts ZeroLock for a lock of 0', async () => {
      await expect(harness.emissionAt(1n, 0n, E, E, [], 1n)).to.be.revertedWithCustomError(harness, 'ZeroLock');
      await expect(harness.span(1n, 0n)).to.be.revertedWithCustomError(harness, 'ZeroLock');
    });

    it('reverts WindowAmountsLengthMismatch unless there is one amount per window', async () => {
      await expect(harness.emissionAt(1n, 3n, E, E, [1n, 2n], 1n))
        .to.be.revertedWithCustomError(harness, 'WindowAmountsLengthMismatch')
        .withArgs(3n, 2n);
      await expect(harness.emissionAt(1n, 1n, E, E, [1n, 2n], 1n))
        .to.be.revertedWithCustomError(harness, 'WindowAmountsLengthMismatch')
        .withArgs(1n, 2n);
    });

    it('reverts InvalidTimeRemaining for a time remaining of 0 or above the epoch length', async () => {
      await expect(harness.emissionAt(1n, 1n, E, 0n, [5n], 1n))
        .to.be.revertedWithCustomError(harness, 'InvalidTimeRemaining')
        .withArgs(0n, E);
      await expect(harness.emissionAt(1n, 1n, E, E + 1n, [5n], 1n))
        .to.be.revertedWithCustomError(harness, 'InvalidTimeRemaining')
        .withArgs(E + 1n, E);
      // An epoch length of 0 can never hold a positive time remaining.
      await expect(harness.emissionAt(1n, 1n, 0n, 1n, [5n], 1n))
        .to.be.revertedWithCustomError(harness, 'InvalidTimeRemaining')
        .withArgs(1n, 0n);
    });

    it('reverts on a uint96 overflow instead of truncating', async () => {
      // Window 0 carries the most dust a lock of 12 allows, the other windows
      // the uint96 maximum, and tr is too small a share of a huge epoch for a
      // first-epoch credit. Epoch anchor + 12 then sums window 0's final
      // credit with eleven full-epoch credits: 7 wei above the maximum. Real
      // windows sum to at most the commitment and cannot get here.
      const q = MAX_UINT96 / 12n;
      const windows = [12n * q - 1n, ...Array.from({ length: 11 }, () => MAX_UINT96)];
      const hugeEpoch = 1n << 200n;
      await expect(harness.emissionAt(0n, 12n, hugeEpoch, 1n, windows, 12n))
        .to.be.revertedWithCustomError(harness, 'SafeCastOverflowedUintDowncast')
        .withArgs(96n, MAX_UINT96 + 7n);
      // The epoch before it still fits: window 0's base (q − 1) plus ten more.
      expect(await harness.emissionAt(0n, 12n, hugeEpoch, 1n, windows, 11n)).to.equal(11n * q - 1n);
    });
  });
});
