import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

import { createProfile } from './profile-helpers';
import { Ask, Staking, Token, Profile } from '../../typechain';

export function getDefaultPublishingNode(accounts: SignerWithAddress[]) {
  return {
    admin: accounts[1],
    operational: accounts[2],
  };
}

export function getDefaultReceivingNodes(
  accounts: SignerWithAddress[],
  receivingNodesNumber: number = 3,
) {
  return Array.from({ length: receivingNodesNumber }, (_, i) => ({
    admin: accounts[3 + i],
    operational: accounts[4 + i],
  }));
}

export function getDefaultKACreator(accounts: SignerWithAddress[]) {
  return accounts[9];
}

export async function setNodeStake(
  node: { operational: SignerWithAddress; admin: SignerWithAddress },
  identityId: bigint,
  amount: bigint,
  deps: { Token: Token; Staking: Staking; Ask: Ask },
) {
  const { Token, Staking } = deps;

  await Token.mint(node.operational.address, amount);
  await Token.connect(node.operational).approve(
    await Staking.getAddress(),
    amount,
  );
  await Staking.connect(node.operational).stake(identityId, amount);
}

export async function setupNodeWithStakeAndAsk(
  accountIndex: number,
  stakeAmount: bigint,
  askAmount: bigint,
  deps: {
    accounts: SignerWithAddress[];
    Profile: Profile;
    Token: Token;
    Staking: Staking;
    Ask: Ask;
  },
): Promise<{
  node: { operational: SignerWithAddress; admin: SignerWithAddress };
  identityId: number;
}> {
  const { accounts, Profile, Token, Staking, Ask } = deps;
  // Use distinct accounts for operational and admin keys
  const operationalAccountIndex = accountIndex;
  const adminAccountIndex = operationalAccountIndex + 1;

  if (adminAccountIndex >= accounts.length) {
    throw new Error(
      `Not enough accounts for score test setup (needed index ${adminAccountIndex})`,
    );
  }

  const node = {
    operational: accounts[operationalAccountIndex],
    admin: accounts[adminAccountIndex],
  };
  // create profile
  const { identityId } = await createProfile(Profile, node);
  // set stake
  await setNodeStake(node, BigInt(identityId), stakeAmount, {
    Token,
    Staking,
    Ask,
  });
  // set ask
  await Profile.connect(node.operational).updateAsk(identityId, askAmount);
  await Ask.connect(accounts[0]).recalculateActiveSet();

  return { node, identityId };
}
