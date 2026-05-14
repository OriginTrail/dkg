/**
 * Shared helpers for deployed-bytecode hash tracking.
 *
 * The deployed-bytecode hash anchors which Solidity build is actually
 * sitting at each `evmAddress` in `deployments/<network>_contracts.json`.
 * Recording it at deploy time + re-computing it at check time turns
 * "which contracts changed since the last deploy?" into a deterministic
 * artifact comparison, instead of a brittle dance with git diffs.
 *
 * Hash strategy: `keccak256(deployedBytecode)` where `deployedBytecode`
 * is the artifact's `deployedBytecode` (== `eth_getCode(addr)` after a
 * fresh deploy). Includes the Solidity metadata trailer, so a
 * comment-only edit will register as a change — that's fine for this
 * use case (the metadata hash IS the source-verification anchor on
 * basescan, and a comment edit without redeploy desyncs verified-source
 * displays from on-chain truth).
 *
 * The hash IS reproducible from chain alone (just hash `eth_getCode(addr)`),
 * which makes the recorded value auditable without needing the
 * artifact.
 */
import * as fs from 'fs';
import { keccak256, Provider } from 'ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

export type DeploymentEntry = {
  evmAddress: string;
  version: string | null;
  gitBranch: string;
  gitCommitHash: string;
  deploymentBlock: number;
  deploymentTimestamp: number;
  deployed: boolean;
  migration?: boolean;
  contractClassName?: string;
  deployedBytecodeHash?: string;
};

export type DeploymentsFile = {
  contracts: { [contractName: string]: DeploymentEntry };
};

export function deploymentsPath(networkName: string): string {
  return `./deployments/${networkName}_contracts.json`;
}

export function loadDeployments(networkName: string): DeploymentsFile {
  return JSON.parse(fs.readFileSync(deploymentsPath(networkName), 'utf8'));
}

export function saveDeployments(
  networkName: string,
  data: DeploymentsFile,
): void {
  // Match the existing 4-space indent + trailing newline of the hand-
  // managed deployments JSON so diffs stay minimal.
  fs.writeFileSync(
    deploymentsPath(networkName),
    JSON.stringify(data, null, 4) + '\n',
  );
}

/**
 * Resolve the artifact class name for a deployment entry. Resolution
 * order:
 *   1. Explicit `contractClassName` on the entry (set at deploy time
 *      by helpers.ts for multi-deploys).
 *   2. Direct match: the entry key is the artifact name.
 *   3. Longest-prefix fallback: e.g. `EpochStorageV6` resolves to
 *      `EpochStorage` because the latter is a strict prefix and the
 *      only artifact that matches. Handles the case where an existing
 *      JSON entry pre-dates the `contractClassName` field.
 *
 * Throws if none of the above resolve to an artifact, with a hint
 * pointing at the manual fix (set `contractClassName` in the JSON).
 */
export async function resolveArtifactName(
  hre: HardhatRuntimeEnvironment,
  entryName: string,
  entry: DeploymentEntry,
): Promise<string> {
  if (entry.contractClassName) return entry.contractClassName;

  try {
    await hre.artifacts.readArtifact(entryName);
    return entryName;
  } catch {
    // Fall through to prefix search.
  }

  const allFqNames = await hre.artifacts.getAllFullyQualifiedNames();
  let bestMatch: string | null = null;
  for (const fq of allFqNames) {
    // FQ name is "path/to/File.sol:ContractName".
    const name = fq.split(':')[1];
    if (!name) continue;
    if (entryName.startsWith(name) && name !== entryName) {
      if (!bestMatch || name.length > bestMatch.length) bestMatch = name;
    }
  }
  if (bestMatch) return bestMatch;

  throw new Error(
    `No artifact found for deployment entry '${entryName}'. Direct + ` +
      `prefix-fallback both failed. Set 'contractClassName' explicitly ` +
      `on the entry in the deployments JSON.`,
  );
}

/**
 * Hash the runtime bytecode currently sitting at `address` on chain.
 * Throws if the address has no code (contract self-destructed, never
 * deployed, or wrong network).
 */
export async function getOnChainBytecodeHash(
  address: string,
  provider: Provider,
): Promise<string> {
  const code = await provider.getCode(address);
  if (code === '0x' || code === '') {
    throw new Error(
      `No bytecode at ${address} (contract self-destructed, never deployed, or wrong network).`,
    );
  }
  return keccak256(code);
}

/**
 * Hash the runtime bytecode the current compilation produced for a
 * given contract class. For a fresh deploy, this equals
 * `getOnChainBytecodeHash(addr)` exactly. Drift between the two means
 * the source has changed since deploy.
 */
export async function getArtifactBytecodeHash(
  hre: HardhatRuntimeEnvironment,
  artifactName: string,
): Promise<string> {
  const artifact = await hre.artifacts.readArtifact(artifactName);
  return keccak256(artifact.deployedBytecode);
}
