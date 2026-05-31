import { expect } from 'chai';
import hre from 'hardhat';

describe('@unit PublishingMathLib', () => {
  it('prorates active sink rewards across current, full, and final epochs', async () => {
    const Harness = await hre.ethers.getContractFactory('PublishingMathLibHarness');
    const harness = await Harness.deploy();

    const [starts, ends, amounts] = await harness.prorateActiveSink(
      1000n,
      10,
      4,
      100,
      50,
    );

    expect(starts).to.deep.equal([10n, 11n, 14n]);
    expect(ends).to.deep.equal([10n, 13n, 14n]);
    expect(amounts).to.deep.equal([125n, 750n, 125n]);
  });

  it('leaves the final active sink slot empty when the tail allocation is zero', async () => {
    const Harness = await hre.ethers.getContractFactory('PublishingMathLibHarness');
    const harness = await Harness.deploy();

    const [starts, ends, amounts] = await harness.prorateActiveSink(
      1000n,
      10,
      4,
      100,
      100,
    );

    expect(starts).to.deep.equal([10n, 11n, 0n]);
    expect(ends).to.deep.equal([10n, 13n, 0n]);
    expect(amounts).to.deep.equal([250n, 750n, 0n]);
  });

  it('leaves the middle active sink slot empty for one storage epoch', async () => {
    const Harness = await hre.ethers.getContractFactory('PublishingMathLibHarness');
    const harness = await Harness.deploy();

    const [starts, ends, amounts] = await harness.prorateActiveSink(
      1000n,
      20,
      1,
      100,
      25,
    );

    expect(starts).to.deep.equal([20n, 0n, 21n]);
    expect(ends).to.deep.equal([20n, 0n, 21n]);
    expect(amounts).to.deep.equal([250n, 0n, 750n]);
  });

  it('places large active sink remainder dust in the final epoch', async () => {
    const Harness = await hre.ethers.getContractFactory('PublishingMathLibHarness');
    const harness = await Harness.deploy();

    const [starts, ends, amounts] = await harness.prorateActiveSink(
      hre.ethers.parseEther('123456789.123456789123456789'),
      12345,
      365,
      86_400,
      43_210,
    );

    expect(starts).to.deep.equal([12345n, 12346n, 12710n]);
    expect(ends).to.deep.equal([12345n, 12709n, 12710n]);
    expect(amounts).to.deep.equal([
      169158037101235662672011n,
      123118551345036359564214308n,
      169079741319193896570470n,
    ]);
  });

  it('leaves the current active sink slot empty when a small allocation rounds to zero', async () => {
    const Harness = await hre.ethers.getContractFactory('PublishingMathLibHarness');
    const harness = await Harness.deploy();

    const [starts, ends, amounts] = await harness.prorateActiveSink(
      10n,
      10,
      3,
      10,
      1,
    );

    expect(starts).to.deep.equal([0n, 11n, 13n]);
    expect(ends).to.deep.equal([0n, 12n, 13n]);
    expect(amounts).to.deep.equal([0n, 6n, 4n]);
  });
});
