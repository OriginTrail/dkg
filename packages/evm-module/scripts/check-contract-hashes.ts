/**
 * Check which contracts changed since the last recorded deploy on a
 * given network. Compares the keccak256 of each contract's current
 * artifact `deployedBytecode` against the `deployedBytecodeHash`
 * recorded in `deployments/<network>_contracts.json`.
 *
 * Exit codes:
 *   0 — all deployed contracts match their recorded hash
 *   1 — at least one contract has drifted; output lists which
 *   2 — script-level error (artifact missing, RPC failure, etc.)
 *
 * Run:
 *   pnpm --filter @origintrail-official/dkg-evm-module \
 *     exec hardhat run scripts/check-contract-hashes.ts \
 *     --network base_sepolia_v10 --config hardhat.node.config.ts
 *
 * Note: the network flag is consulted only for the network NAME (which
 * deployments file to read). No RPC calls are made — the script
 * compares artifact hashes vs the JSON, both local.
 */
import hre from 'hardhat';
import {
  loadDeployments,
  getArtifactBytecodeHash,
  resolveArtifactName,
} from './contract-hashing-lib';

async function main(): Promise<void> {
  const networkName = hre.network.name;
  const data = loadDeployments(networkName);

  const changed: string[] = [];
  const missingHash: string[] = [];
  const okCount = { value: 0 };
  const errors: Array<{ name: string; err: string }> = [];
  let skippedNotDeployed = 0;

  for (const [name, entry] of Object.entries(data.contracts)) {
    if (!entry.deployed) {
      skippedNotDeployed++;
      continue;
    }

    let artifactName: string;
    let artifactHash: string;
    try {
      artifactName = await resolveArtifactName(hre, name, entry);
      artifactHash = await getArtifactBytecodeHash(hre, artifactName);
    } catch (err) {
      errors.push({
        name,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!entry.deployedBytecodeHash) {
      missingHash.push(name);
      continue;
    }

    if (
      artifactHash.toLowerCase() !== entry.deployedBytecodeHash.toLowerCase()
    ) {
      changed.push(name);
    } else {
      okCount.value++;
    }
  }

  console.log(`\n[hash-check] Network: ${networkName}`);
  console.log(`  Up-to-date:                 ${okCount.value}`);
  console.log(`  Changed since last deploy:  ${changed.length}`);
  console.log(`  Missing recorded hash:      ${missingHash.length}`);
  console.log(`  Artifact lookup errors:     ${errors.length}`);
  console.log(`  Skipped (deployed: false):  ${skippedNotDeployed}`);

  if (missingHash.length > 0) {
    console.log(`\n[hash-check] Missing 'deployedBytecodeHash' (backfill needed):`);
    for (const n of missingHash) console.log(`  - ${n}`);
    console.log(
      `\nBackfill with:\n  pnpm --filter @origintrail-official/dkg-evm-module \\\n` +
        `    exec hardhat run scripts/record-contract-hashes-from-chain.ts \\\n` +
        `    --network ${networkName} --config hardhat.node.config.ts`,
    );
  }

  if (errors.length > 0) {
    console.log(`\n[hash-check] Could not load artifact (rename or missing compile?):`);
    for (const { name, err } of errors) console.log(`  - ${name}: ${err}`);
  }

  if (changed.length === 0) {
    console.log(`\n[hash-check] No bytecode drift detected.`);
    process.exit(missingHash.length > 0 || errors.length > 0 ? 1 : 0);
  }

  console.log(`\n[hash-check] CHANGED contracts (redeploy candidates):`);
  for (const n of changed) console.log(`  - ${n}`);
  console.log(
    `\nTo redeploy: flip 'deployed: false' on each of the above in:\n` +
      `  packages/evm-module/deployments/${networkName}_contracts.json\n` +
      `then run:\n` +
      `  pnpm --filter @origintrail-official/dkg-evm-module \\\n` +
      `    exec hardhat deploy --network ${networkName} --config hardhat.node.config.ts`,
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
