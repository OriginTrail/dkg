// Throwaway local-node setup for v8-sweep-driver.ts validation. Deploys +
// registers DelegatorsInfo, creates 2 nodes, and seeds a realistic V8 state:
//   node1: d1 active 5000, d2 active 3000
//   node2: d3 active 2000 + pending 500, d4 PENDING-ONLY 800 (in DelegatorAdded
//          history but removed from getDelegators — the gap the driver recovers)
//   node1 operator fee 100 (NOT drained → the expectedResidual)
// Vault is funded to back stake + pending + fee. Run on a localhost dev node.
import hre from 'hardhat';

const E = (n: number | string) => hre.ethers.parseEther(String(n));
const keyOf = (a: string) => hre.ethers.keccak256(hre.ethers.solidityPacked(['address'], [a]));

async function main() {
  const accts = await hre.ethers.getSigners();
  const owner = accts[0];
  const Hub = (await hre.ethers.getContract('Hub')) as any;
  const SS = (await hre.ethers.getContract('StakingStorage')) as any;
  const Token = (await hre.ethers.getContract('Token')) as any;
  const Profile = (await hre.ethers.getContract('Profile')) as any;
  const ssAddr = await SS.getAddress();

  // deploy + register + init DelegatorsInfo (archived V8 contract)
  const DI = await (await hre.ethers.getContractFactory('DelegatorsInfo')).deploy(await Hub.getAddress());
  await DI.waitForDeployment();
  await (await Hub.connect(owner).setContractAddress('DelegatorsInfo', await DI.getAddress())).wait();
  await (await (DI as any).connect(owner).initialize()).wait();

  const createProfile = async (opIdx: number) => {
    const tx = await Profile.connect(accts[opIdx]).createProfile(
      owner.address, [], `Node-${opIdx}-${Math.floor(Math.random() * 1e6)}`,
      hre.ethers.hexlify(hre.ethers.randomBytes(32)), 0,
    );
    const r = await tx.wait();
    const ps = (await hre.ethers.getContract('ProfileStorage')) as any;
    for (const log of r.logs) {
      try { const p = ps.interface.parseLog({ topics: [...log.topics], data: log.data }); if (p?.name === 'ProfileCreated') return Number(p.args.identityId); } catch {}
    }
    throw new Error('no ProfileCreated');
  };
  const node1 = await createProfile(1);
  const node2 = await createProfile(2);

  // seed active stake: vault mint + StakingStorage slots + DelegatorsInfo.addDelegator
  const seedActive = async (id: number, d: string, amt: bigint) => {
    await (await Token.mint(ssAddr, amt)).wait();
    await (await SS.connect(owner).increaseDelegatorStakeBase(id, keyOf(d), amt)).wait();
    await (await SS.connect(owner).increaseNodeStake(id, amt)).wait();
    await (await SS.connect(owner).increaseTotalStake(amt)).wait();
    await (await (DI as any).connect(owner).addDelegator(id, d)).wait(); // emits DelegatorAdded
  };
  // seed a pending withdrawal: vault mint + request (excluded from node/total stake)
  const seedPending = async (id: number, d: string, amt: bigint) => {
    await (await Token.mint(ssAddr, amt)).wait();
    const ts = BigInt((await hre.ethers.provider.getBlock('latest'))!.timestamp) + 1n;
    await (await SS.connect(owner).createDelegatorWithdrawalRequest(id, keyOf(d), amt, 0, ts)).wait();
  };

  const [d1, d2, d3, d4] = [accts[3].address, accts[4].address, accts[5].address, accts[6].address];
  await seedActive(node1, d1, E(5000));
  await seedActive(node1, d2, E(3000));
  await seedActive(node2, d3, E(2000));
  await seedPending(node2, d3, E(500)); // d3 also has a pending request
  // d4: pending-only — addDelegator (emits event) then removeDelegator, leaving a pending request
  await (await (DI as any).connect(owner).addDelegator(node2, d4)).wait();
  await seedPending(node2, d4, E(800));
  await (await (DI as any).connect(owner).removeDelegator(node2, d4)).wait(); // gone from getDelegators, still in DelegatorAdded

  // operator fee on node1 — NOT drained; this is the expectedResidual
  await (await Token.mint(ssAddr, E(100))).wait();
  await (await SS.connect(owner).increaseOperatorFeeBalance(node1, E(100))).wait();

  console.log(`SETUP_DONE node1=${node1} node2=${node2} d4(pending-only)=${d4}`);
  console.log(`  vault=${hre.ethers.formatEther(await Token.balanceOf(ssAddr))} totalStake=${hre.ethers.formatEther(await SS.getTotalStake())}`);
  console.log(`  getDelegators(node2)=${(await (DI as any).getDelegators(node2)).length} (d4 excluded — pending-only)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
