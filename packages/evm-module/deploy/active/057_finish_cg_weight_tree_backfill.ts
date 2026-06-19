import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

// Phase 10.x — bring the value-weighted draw live after deployment.
//
// CGWeightTreeStorage ships backfill-LOCKED so a (future, mainnet) seed migration can
// run against a paused draw. On a clean deploy with a fresh ledger (devnet / a clean
// testnet redeploy) there is nothing to seed, so we go live immediately by calling
// finishBackfill() — no manual migration step.
//
// - development + testnet: auto-unlock here, but ONLY on a provably fresh ledger
//   (ContextGraphStorage counter == 0) and only if the deployer is the Hub owner.
// - mainnet: SKIP — going live is a deliberate operator step (seed existing CGs first,
//   then finishBackfill, typically via the Hub-owner multisig + scripts/migrate-cg-weight-tree.ts).
//
// Tagged separately and depending ON CGWeightTreeStorage, so the CGWeightTreeStorage
// unit-test fixture (which requests just ['CGWeightTreeStorage']) still gets a LOCKED tree.
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, deployments } = hre;

  if (hre.network.config.environment === 'mainnet') {
    console.log('[CGWeightTree] mainnet: finishBackfill is a deliberate operator step — skipping.');
    return;
  }

  const treeDep = await deployments.getOrNull('CGWeightTreeStorage');
  if (!treeDep) {
    console.log('[CGWeightTree] not deployed — skipping finishBackfill.');
    return;
  }

  const { deployer } = await hre.getNamedAccounts();
  const signer = await ethers.getSigner(deployer);
  const tree = await ethers.getContractAt('CGWeightTreeStorage', treeDep.address, signer);

  if (!(await tree.backfillLocked())) {
    console.log('[CGWeightTree] already unlocked — skipping.');
    return;
  }

  // Only auto-unlock on a PROVABLY FRESH ledger. If ContextGraphStorage already has CGs
  // (an upgrade-in-place / redeploy that kept the value ledger), unlocking with an empty
  // BIT would orphan all existing weight (draw reverts NoEligibleContextGraph until each CG
  // is re-settled). In that case the operator must seed first (scripts/migrate-cg-weight-tree.ts)
  // then finishBackfill. A clean redeploy of ContextGraphStorage has counter == 0 → safe.
  const cgStorageDep = await deployments.getOrNull('ContextGraphStorage');
  if (cgStorageDep) {
    const cgStorage = await ethers.getContractAt('ContextGraphStorage', cgStorageDep.address, signer);
    const cgCount: bigint = await cgStorage.getLatestContextGraphId();
    if (cgCount > 0n) {
      console.log(
        `[CGWeightTree] ContextGraphStorage already has ${cgCount} CGs — NOT auto-unlocking. ` +
          'Seed the BIT (scripts/migrate-cg-weight-tree.ts) then call finishBackfill().',
      );
      return;
    }
  }

  // finishBackfill is onlyContracts (Hub owner bypasses). Only call if the deployer is the owner;
  // otherwise leave it locked and print the manual go-live step (e.g. multisig-owned Hub).
  const hub = await ethers.getContractAt('Hub', (await deployments.get('Hub')).address);
  const owner: string = await hub.owner();
  if (owner.toLowerCase() !== deployer.toLowerCase()) {
    console.log(
      `[CGWeightTree] deployer ${deployer} is not the Hub owner ${owner}. ` +
        'Call CGWeightTreeStorage.finishBackfill() as the owner to bring the draw live.',
    );
    return;
  }

  await (await tree.finishBackfill()).wait();
  console.log('[CGWeightTree] finishBackfill() done — value-weighted draw is LIVE.');
};

export default func;
func.tags = ['CGWeightTreeFinishBackfill'];
func.dependencies = ['CGWeightTreeStorage'];
func.runAtTheEnd = true;
