// Accounts that PublishingConviction 10.0.8 or 10.1.0 scheduled: those builds
// booked every billing window's budget to the staker pool when the account was
// created (or at an older account's first touch), and left `lastSettledWindow`
// at the lock. Since 10.2.0 no path writes such a schedule, so the suites make
// these accounts with PublishingConvictionScheduleHarness, which runs the
// contract's own per-window booking over every window at once.

import hre from 'hardhat';

import { Hub, PublishingConvictionScheduleHarness } from '../../typechain';

/**
 * Deploy the harness, register it in the Hub's contract set under its own name
 * (so its storage writes pass `onlyContracts`) and initialize it through
 * `Hub.forwardCall`, as the development deploy initializes a logic contract.
 */
export async function deployScheduleHarness(hub: Hub): Promise<PublishingConvictionScheduleHarness> {
  const factory = await hre.ethers.getContractFactory('PublishingConvictionScheduleHarness');
  const harness = (await factory.deploy(await hub.getAddress())) as unknown as PublishingConvictionScheduleHarness;
  await harness.waitForDeployment();
  const address = await harness.getAddress();
  await hub.setContractAddress('PublishingConvictionScheduleHarness', address);
  await hub.forwardCall(address, harness.interface.encodeFunctionData('initialize'));
  return harness;
}
