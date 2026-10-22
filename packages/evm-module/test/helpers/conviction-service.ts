// Shared set-up for the Conviction Account service spending tests (OT-RFC-27):
// Hub registration of ConvictionServiceStorage and ServiceSubscriptions, and
// the EIP-712 ServiceAssignment consent.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import hre from 'hardhat';

import { ConvictionServiceStorage, Hub, ServiceSubscriptions } from '../../typechain';

export const TRAC = 10n ** 18n;
export const DAY = 86_400n;

/**
 * Deploy ConvictionServiceStorage and ServiceSubscriptions and register both in
 * the Hub's contract set, as the development deploy helper does: the Hub
 * registration, then `initialize()` through `Hub.forwardCall`. The storage
 * comes first, because ServiceSubscriptions wires it at initialization.
 */
export async function registerServiceContracts(hub: Hub): Promise<{
  CSS: ConvictionServiceStorage;
  SS: ServiceSubscriptions;
}> {
  const hubAddress = await hub.getAddress();

  const CSS = (await (
    await hre.ethers.getContractFactory('ConvictionServiceStorage')
  ).deploy(hubAddress)) as unknown as ConvictionServiceStorage;
  await CSS.waitForDeployment();
  await hub.setContractAddress('ConvictionServiceStorage', await CSS.getAddress());
  await hub.forwardCall(await CSS.getAddress(), CSS.interface.encodeFunctionData('initialize'));

  const SS = (await (
    await hre.ethers.getContractFactory('ServiceSubscriptions')
  ).deploy(hubAddress)) as unknown as ServiceSubscriptions;
  await SS.waitForDeployment();
  await hub.setContractAddress('ServiceSubscriptions', await SS.getAddress());
  await hub.forwardCall(await SS.getAddress(), SS.interface.encodeFunctionData('initialize'));

  return { CSS, SS };
}

// ---------------------------------------------------------------------------
// EIP-712 consent
// ---------------------------------------------------------------------------

export const SERVICE_ASSIGNMENT_TYPES = {
  ServiceAssignment: [
    { name: 'accountId', type: 'uint256' },
    { name: 'assignee', type: 'address' },
    { name: 'maxCostPerPeriod', type: 'uint96' },
    { name: 'maxInferenceCostPerPeriod', type: 'uint96' },
    { name: 'maxQueryCostPerPeriod', type: 'uint96' },
    { name: 'maxCostPerWindow', type: 'uint96' },
    { name: 'maxTotalCost', type: 'uint96' },
    { name: 'maxPeriodSeconds', type: 'uint32' },
    { name: 'expiresAt', type: 'uint40' },
    { name: 'nonce', type: 'uint64' },
  ],
};

export type Terms = {
  accountId: bigint;
  assignee: string;
  maxCostPerPeriod: bigint;
  maxInferenceCostPerPeriod: bigint;
  maxQueryCostPerPeriod: bigint;
  maxCostPerWindow: bigint;
  maxTotalCost: bigint;
  maxPeriodSeconds: bigint;
  expiresAt: bigint;
  nonce: bigint;
};

export type Domain = { name: string; version: string; chainId: bigint; verifyingContract: string };

export async function domainOf(ss: ServiceSubscriptions): Promise<Domain> {
  return {
    name: 'DKGConvictionServices',
    version: '1',
    chainId: (await hre.ethers.provider.getNetwork()).chainId,
    verifyingContract: await ss.getAddress(),
  };
}

/** A 65-byte (r, s, v) EIP-712 signature over the terms. */
export async function signTerms(
  signer: SignerWithAddress,
  ss: ServiceSubscriptions,
  terms: Terms,
  domain?: Domain,
): Promise<string> {
  return signer.signTypedData(domain ?? (await domainOf(ss)), SERVICE_ASSIGNMENT_TYPES, terms);
}
