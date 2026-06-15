// Creates one DKG node profile and prints its identityId — used as the
// allocate() target in the OT-RFC-50 rehearsal (a fresh deploy has none).
//   [OPERATOR_IDX=1] [OP_FEE=0] npx hardhat run scripts/create-profile.ts --network localhost
import hre from 'hardhat';

async function main() {
  const opIdx = Number(process.env.OPERATOR_IDX ?? '1');
  const opFee = Number(process.env.OP_FEE ?? '0');
  const accounts = await hre.ethers.getSigners();
  const Profile = (await hre.ethers.getContract('Profile')) as any;
  const nodeId = hre.ethers.hexlify(hre.ethers.randomBytes(32));
  const tx = await Profile.connect(accounts[opIdx]).createProfile(
    accounts[0].address, // admin key
    [], // operational keys
    `Rehearsal-Node-${opIdx}`,
    nodeId,
    opFee,
  );
  const receipt = await tx.wait();
  const identityId = Number(receipt.logs[0].topics[1]);
  console.log(`created profile identityId=${identityId} operator=${accounts[opIdx].address}`);
  console.log(`IDENTITY_ID=${identityId}`);
}

main().catch((e) => {
  console.error('createProfile failed:', e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
