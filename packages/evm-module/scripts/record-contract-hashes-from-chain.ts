/**
 * Backfill `deployedBytecodeHash` for every `deployed: true` entry in
 * `deployments/<network>_contracts.json` by querying `eth_getCode(addr)`
 * on the configured network and writing `keccak256(code)` into the JSON.
 *
 * Use cases:
 *   - One-shot bootstrap on networks whose deploy predates this hash
 *     mechanism (records the on-chain hash so subsequent
 *     `check-contract-hashes` can compare against current artifacts).
 *   - Sanity check / drift recovery — re-runs after an external upgrade
 *     pick up the new on-chain bytecode.
 *
 * After running, commit the updated JSON.
 *
 * Run:
 *   pnpm --filter @origintrail-official/dkg-evm-module \
 *     exec hardhat run scripts/record-contract-hashes-from-chain.ts \
 *     --network base_sepolia_v10 --config hardhat.node.config.ts
 */
import hre from 'hardhat';
import {
  loadDeployments,
  saveDeployments,
  getOnChainBytecodeHash,
  resolveArtifactName,
} from './contract-hashing-lib';

async function main(): Promise<void> {
  const networkName = hre.network.name;
  const data = loadDeployments(networkName);
  const provider = hre.ethers.provider;

  let updated = 0;
  let skippedNotDeployed = 0;
  const failed: Array<{ name: string; err: string }> = [];

  for (const [name, entry] of Object.entries(data.contracts)) {
    if (!entry.deployed) {
      skippedNotDeployed++;
      continue;
    }
    try {
      const hash = await getOnChainBytecodeHash(entry.evmAddress, provider);
      const wasSet = entry.deployedBytecodeHash;
      const change =
        wasSet && wasSet.toLowerCase() !== hash.toLowerCase()
          ? ' (changed)'
          : wasSet
            ? ''
            : ' (new)';
      console.log(`${name.padEnd(36)} ${entry.evmAddress}  →  ${hash}${change}`);
      entry.deployedBytecodeHash = hash;

      // Also backfill `contractClassName` when missing so the check
      // script's prefix-fallback lookup becomes an explicit, audited
      // assignment. Soft-failure: if no artifact resolves, leave the
      // field unset — check script will retry the fallback there.
      if (!entry.contractClassName) {
        try {
          entry.contractClassName = await resolveArtifactName(
            hre,
            name,
            entry,
          );
        } catch {
          // Leave undefined — check script will surface the error.
        }
      }

      updated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[record]  FAILED  ${name} @ ${entry.evmAddress}: ${msg}`);
      failed.push({ name, err: msg });
    }
  }

  saveDeployments(networkName, data);
  console.log(
    `\n[record] Wrote ${updated} hashes to ${networkName}_contracts.json ` +
      `(skipped ${skippedNotDeployed} not-deployed, ${failed.length} failed).`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
