// =============================================================================
// v10-migration-full-e2e.test.ts — FAITHFUL end-to-end migration on a local
// devnet with the REAL V8 Staking + the REAL V10 conviction stack on ONE Hub.
// =============================================================================
//
// Unlike the other suites (which seed V8 stake by writing StakingStorage slots
// directly), this deploys the actual archived V8 `Staking` logic onto the same
// Hub as the V10 stack and has delegators stake through the GENUINE V8 flow:
//   Token.approve → Staking.stake() → transferFrom(staker → StakingStorage),
//   DelegatorsInfo.addDelegator, node/total stake increase, real Transfer logs.
// Then it runs the whole OT-RFC-50 cutover (freeze → sweep → allocate → recover)
// against that real state — incl. the genesis Token.Transfer enumeration, which
// only real stake flows produce.
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

const E = (n: number | string) => hre.ethers.parseEther(String(n));
const keyOf = (a: string) => hre.ethers.keccak256(hre.ethers.solidityPacked(['address'], [a]));

async function deployFixture() {
  // 1. full V10 stack (Hub + shared storages + conviction ShardingTable/Ask/
  //    RandomSampling + CSS + StakingV10 + DKGStakingConvictionNFT).
  await hre.deployments.fixture(['DKGStakingConvictionNFT', 'StakingV10', 'Profile']);
  const accounts = await hre.ethers.getSigners();
  const owner = accounts[0];
  const Hub = (await hre.ethers.getContract('Hub')) as any;
  await Hub.setContractAddress('HubOwner', owner.address);

  // 2. add the archived V8 contracts onto the SAME Hub (not in the active deploy).
  const DI = await (await hre.ethers.getContractFactory('contracts/archive/DelegatorsInfo.sol:DelegatorsInfo')).deploy(
    await Hub.getAddress(),
  );
  await DI.waitForDeployment();
  await (await Hub.connect(owner).setContractAddress('DelegatorsInfo', await DI.getAddress())).wait();
  await (await (DI as any).connect(owner).initialize()).wait();

  const V8Staking = await (await hre.ethers.getContractFactory('contracts/archive/Staking.sol:Staking')).deploy(
    await Hub.getAddress(),
  );
  await V8Staking.waitForDeployment();
  await (await Hub.connect(owner).setContractAddress('Staking', await V8Staking.getAddress())).wait();
  await (await (V8Staking as any).connect(owner).initialize()).wait();

  return {
    accounts,
    owner,
    Hub,
    V8Staking,
    DI,
    NFT: await hre.ethers.getContract('DKGStakingConvictionNFT'),
    StakingV10: await hre.ethers.getContract('StakingV10'),
    SS: await hre.ethers.getContract('StakingStorage'),
    CSS: await hre.ethers.getContract('ConvictionStakingStorage'),
    Profile: await hre.ethers.getContract('Profile'),
    Token: await hre.ethers.getContract('Token'),
  };
}

describe('@integration OT-RFC-50 FULL e2e — real V8 Staking + real V10 on one Hub', function () {
  this.timeout(600_000);
  let fx: Awaited<ReturnType<typeof deployFixture>>;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    fx = await loadFixture(deployFixture);
  });

  const createProfile = async (opIdx: number) => {
    const tx = await (fx.Profile as any)
      .connect(fx.accounts[opIdx])
      .createProfile(fx.accounts[0].address, [], `Node-${opIdx}-${Math.floor(Math.random() * 1e6)}`, hre.ethers.hexlify(hre.ethers.randomBytes(32)), 0);
    const r = await tx.wait();
    const ps = (await hre.ethers.getContract('ProfileStorage')) as any;
    for (const log of r.logs) {
      try {
        const p = ps.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (p?.name === 'ProfileCreated') return Number(p.args.identityId);
      } catch {}
    }
    throw new Error('no ProfileCreated');
  };

  // REAL V8 stake: fund the delegator, approve, Staking.stake() — the genuine flow.
  const realStake = async (delegator: SignerWithAddress, identityId: number, amount: bigint) => {
    await (await (fx.Token as any).mint(delegator.address, amount)).wait();
    await (await (fx.Token as any).connect(delegator).approve(await fx.V8Staking.getAddress(), amount)).wait();
    await (await (fx.V8Staking as any).connect(delegator).stake(identityId, amount)).wait();
  };

  it('a delegator stakes through the REAL V8 Staking → StakingStorage + vault + DelegatorsInfo all reflect it', async () => {
    const d = fx.accounts[2];
    const id = await createProfile(1);
    const ssAddr = await fx.SS.getAddress();
    const vaultBefore: bigint = await (fx.Token as any).balanceOf(ssAddr);

    await realStake(d, id, E(5000));

    expect(await (fx.SS as any).getDelegatorStakeBase(id, keyOf(d.address))).to.equal(E(5000));
    expect(await (fx.SS as any).getNodeStake(id)).to.equal(E(5000));
    expect(await (fx.SS as any).getTotalStake()).to.equal(E(5000));
    expect((await (fx.Token as any).balanceOf(ssAddr)) - vaultBefore).to.equal(E(5000)); // TRAC really moved to the vault
    expect(await (fx.DI as any).getDelegators(id)).to.include(d.address); // real DelegatorsInfo population
  });

  it('FULL cutover: real stakes → freeze → drain (stake+pending+fees) → EMPTY vault → allocate → recover', async () => {
    const [, , d1, d2, d3] = fx.accounts;
    const owner = fx.accounts[0];
    const n1 = await createProfile(1);
    const n2 = await createProfile(3);

    // real V8 stakes through Staking.stake()
    await realStake(d1, n1, E(5000));
    await realStake(d2, n1, E(3000));
    await realStake(d3, n2, E(2000));
    // a real pending withdrawal (d3 partially withdraws → leaves getTotalStake, stays in vault)
    await (await (fx.V8Staking as any).connect(d3).requestWithdrawal(n2, E(800))).wait();
    // an operator fee on n1 (seed the balance the drain reads; accrual via rewards is out of scope)
    await (await (fx.Token as any).mint(await fx.SS.getAddress(), E(100))).wait();
    await (await (fx.SS as any).connect(owner).increaseOperatorFeeBalance(n1, E(100))).wait();

    const ssAddr = await fx.SS.getAddress();
    const cssAddr = await fx.CSS.getAddress();
    const vaultBefore: bigint = await (fx.Token as any).balanceOf(ssAddr);
    const cssBefore: bigint = await (fx.Token as any).balanceOf(cssAddr);
    const pend3: bigint = await (fx.SS as any).getDelegatorWithdrawalRequestAmount(n2, keyOf(d3.address));
    expect(pend3).to.equal(E(800));

    // ---- cutover: freeze V8 Staking, set credit ----
    await (await fx.Hub.connect(owner).removeContractByName('Staking')).wait();
    await (await (fx.NFT as any).connect(owner).setConvictionCreditSeconds(70n * 24n * 60n * 60n)).wait();

    // ---- sweep: drain all delegator stake+pending, then the operator fee ----
    await (await (fx.NFT as any).connect(owner).adminDrainBatch([d1.address, d2.address, d3.address], [n1, n1, n2])).wait();
    await (await (fx.NFT as any).connect(owner).adminDrainOperatorFeesBatch([n1], [owner.address])).wait();

    // ---- EMPTY-VAULT gate: every kind of V8 TRAC left the vault → CSS ----
    expect(await (fx.SS as any).getTotalStake()).to.equal(0n);
    expect(await (fx.SS as any).getNodeStake(n1)).to.equal(0n);
    expect(await (fx.SS as any).getNodeStake(n2)).to.equal(0n);
    expect(await (fx.SS as any).getOperatorFeeBalance(n1)).to.equal(0n);
    const drained = vaultBefore - (await (fx.Token as any).balanceOf(ssAddr));
    // 10000 delegator (d1 5000 + d2 3000 + d3 2000 = 1200 active + 800 pending) + 100 operator fee
    expect(drained).to.equal(E(10100));
    // vault is EMPTY (all stake + pending + fee moved to CSS)
    expect(await (fx.Token as any).balanceOf(ssAddr)).to.equal(0n);
    expect((await (fx.Token as any).balanceOf(cssAddr)) - cssBefore).to.equal(drained);

    // credit conservation: Σ migrationCredit == drained
    const credit = async (a: string) => (await (fx.NFT as any).migrationCredit(a)) as bigint;
    const totalCredit = (await credit(d1.address)) + (await credit(d2.address)) + (await credit(d3.address)) + (await credit(owner.address));
    expect(totalCredit).to.equal(drained);
    expect(await credit(owner.address)).to.equal(E(100)); // operator fee → operator's credit
    expect(await credit(d3.address)).to.equal(E(2000)); // d3: 1200 active + 800 pending = full 2000

    // ---- allocate: d1 → tier 12 (active-set tail against the conviction ShardingTable) ----
    const c1 = await credit(d1.address);
    await (await (fx.NFT as any).connect(d1).allocate(n1, c1, 12)).wait();
    expect(await (fx.CSS as any).getNodeStakeV10(n1)).to.equal(c1); // position landed on the FRESH CSS
    expect(await credit(d1.address)).to.equal(0n);

    // ---- tier-0 recover: d2 takes its TRAC back in two txs ----
    const walletBefore: bigint = await (fx.Token as any).balanceOf(d2.address);
    const c2 = await credit(d2.address);
    await (await (fx.NFT as any).connect(d2).allocate(n1, c2, 0)).wait();
    const tid = await (fx.NFT as any).totalSupply(); // last minted
    await (await (fx.NFT as any).connect(d2).withdraw(tid)).wait();
    expect(await (fx.Token as any).balanceOf(d2.address)).to.equal(walletBefore + c2); // real TRAC back to wallet
  });

  it('genesis Token.Transfer(to=StakingStorage) scan finds EVERY real staker (the driver enumeration source)', async () => {
    const [, , a, b, c] = fx.accounts;
    const n1 = await createProfile(1);
    const n2 = await createProfile(3);
    await realStake(a, n1, E(1500));
    await realStake(b, n2, E(2500));
    await realStake(c, n1, E(700));

    // replicate the driver's genesis enumeration: Token.Transfer(to=SS) → from-set → probe stake
    const ssAddr = await fx.SS.getAddress();
    const filter = (fx.Token as any).filters.Transfer(null, ssAddr);
    const logs = await (fx.Token as any).queryFilter(filter, 0, 'latest');
    const candidates = new Set<string>(logs.map((l: any) => (l.args.from as string).toLowerCase()).filter((x: string) => x !== hre.ethers.ZeroAddress));

    let enumerated = 0n;
    for (const addr of candidates) {
      for (const id of [n1, n2]) enumerated += (await (fx.SS as any).getDelegatorStakeBase(id, keyOf(addr))) as bigint;
    }
    // the genesis scan reconciles EXACTLY to the authoritative getTotalStake
    expect(enumerated).to.equal(await (fx.SS as any).getTotalStake());
    expect(enumerated).to.equal(E(4700));
    for (const s of [a, b, c]) expect(candidates.has(s.address.toLowerCase())).to.equal(true);
  });

  it('selfMigrate backstop: a straggler self-migrates their real V8 stake after freeze', async () => {
    const straggler = fx.accounts[6];
    const n1 = await createProfile(1);
    await realStake(straggler, n1, E(1234));
    await (await fx.Hub.connect(fx.accounts[0]).removeContractByName('Staking')).wait(); // freeze
    // the admin sweep never touched this delegator; they rescue themselves
    await (await (fx.NFT as any).connect(straggler).selfMigrate([n1])).wait();
    expect(await (fx.NFT as any).migrationCredit(straggler.address)).to.equal(E(1234));
    expect(await (fx.SS as any).getDelegatorStakeBase(n1, keyOf(straggler.address))).to.equal(0n);
  });
});
