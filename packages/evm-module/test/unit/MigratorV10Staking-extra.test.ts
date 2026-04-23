/**
 * MigratorV10Staking-extra.test.ts — audit coverage (E-11).
 *
 * Finding E-11 (MEDIUM, SPEC-GAP, see .test-audit/BUGS_FOUND.md):
 *   "MigratorV10Staking does not exist in the repo. Spec mentions
 *    zero-token migration of V8 delegator state. Only Migrator,
 *    MigratorV6*, MigratorV8* exist."
 *
 * This file is a standing red test that fails the moment the V10 migration
 * story is advertised but the contract is missing. The assertion is a
 * module-resolution attempt against the generated typechain entry. If
 * `MigratorV10Staking.sol` gets added and compiled, the typechain export
 * will resolve and this test flips to green.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('@unit MigratorV10Staking — extra audit coverage (E-11)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const contractPath = path.join(repoRoot, 'contracts', 'migrations', 'MigratorV10Staking.sol');
  // Hardhat-typechain mirrors the contract source tree under
  // `typechain/contracts/...`. Locally we run the full
  // `hardhat.config.ts` (which loads `@typechain/hardhat`) so the
  // binding is generated. CI's Solidity shard, however, runs
  // `hardhat.node.config.ts` — a deliberately lean config that omits
  // `@typechain/hardhat` to keep the shard fast — so it never emits
  // `typechain/`. The artifact JSON is the canonical, config-agnostic
  // proof that the contract compiled (every config produces it),
  // which is what the spec gap actually requires. We assert the
  // artifact and fall back to the typechain binding only when it has
  // been generated, so neither config silently regresses.
  const typechainPath = path.join(
    repoRoot,
    'typechain',
    'contracts',
    'migrations',
    'MigratorV10Staking.ts',
  );
  const artifactPath = path.join(
    repoRoot,
    'artifacts',
    'contracts',
    'migrations',
    'MigratorV10Staking.sol',
    'MigratorV10Staking.json',
  );

  it('SPEC-GAP: contracts/migrations/MigratorV10Staking.sol must exist', () => {
    // Intentionally RED today. Spec says zero-token V8 → V10 delegator
    // migration must ship as `MigratorV10Staking`. Only Migrator,
    // MigratorV6Epochs9to12Rewards, MigratorV6TuningPeriodRewards,
    // MigratorV8TuningPeriodRewards, MigratorM1V8, MigratorM1V8_1 exist.
    expect(
      fs.existsSync(contractPath),
      `Expected ${contractPath} to exist (V10 zero-token migration). See BUGS_FOUND.md E-11.`,
    ).to.equal(true);
  });

  it('SPEC-GAP: MigratorV10Staking compiled artifact must resolve', () => {
    // Companion assertion: even if the .sol file is stubbed, if the
    // contract never compiles to a real artifact the chain bindings
    // can't use it. The artifact JSON is what `hardhat compile`
    // produces under EVERY config (lean `hardhat.node.config.ts`
    // that the CI Solidity shard runs, AND the full
    // `hardhat.config.ts` that loads typechain). It's the strongest
    // config-agnostic proof of "actually compiled". A stubbed or
    // syntax-broken contract would leave artifacts/ empty.
    expect(
      fs.existsSync(artifactPath),
      `Expected compiled artifact ${artifactPath} to exist after compile. See BUGS_FOUND.md E-11.`,
    ).to.equal(true);

    // Sanity-check the artifact actually contains a non-empty bytecode
    // and an ABI, so a 0-byte placeholder file can't sneak the gate
    // open. This also catches the historical bug pattern where
    // hardhat emitted an interface/library shell with `bytecode: "0x"`.
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
      contractName: string;
      abi: unknown[];
      bytecode: string;
    };
    expect(artifact.contractName).to.equal('MigratorV10Staking');
    expect(Array.isArray(artifact.abi) && artifact.abi.length > 0).to.equal(true);
    expect(artifact.bytecode.length, 'bytecode must be non-trivial').to.be.greaterThan(2);

    // Bonus assertion: when the typechain binding IS generated (full
    // config), validate it too — so refactors that drop the binding
    // are still caught locally even though CI cannot reach this branch.
    if (fs.existsSync(typechainPath)) {
      const tc = fs.readFileSync(typechainPath, 'utf8');
      expect(tc).to.match(/MigratorV10Staking/);
    }
  });

  // PR #229 bot review round 10 (MigratorV10Staking.sol:137).
  //
  // Before the round-10 fix `migrateDelegator` / `markNodeMigrated`
  // only rejected `identityId == 0`. Any non-zero id (including a
  // typo in the generated `epoch-snapshot.ts` CSV) would silently
  // pass the guard and permanently inflate
  // `StakingStorage.totalStake` / pollute `DelegatorsInfo` under a
  // nonexistent identity. The fix adds a `profileExists` check that
  // reverts with `UnknownIdentityId(uint72)`. Pin the new custom
  // error at the ABI/artifact layer so a refactor that drops the
  // guard also breaks this test.
  it('bot review r10-5: UnknownIdentityId error is present in the compiled ABI', () => {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
      abi: Array<{ type: string; name?: string; inputs?: Array<{ type: string; name?: string }> }>;
    };

    const unknownIdErr = artifact.abi.find(
      (entry) => entry.type === 'error' && entry.name === 'UnknownIdentityId',
    );
    expect(
      unknownIdErr,
      'MigratorV10Staking ABI must expose the UnknownIdentityId error (bot review r10-5)',
    ).to.not.equal(undefined);
    expect(unknownIdErr!.inputs).to.have.length(1);
    expect(unknownIdErr!.inputs![0].type).to.equal('uint72');
  });

  // PR #229 bot review round 24 (r24-3). Before this fix,
  // `markNodeMigrated()` flipped `nodeMigrated[id] = true` but
  // `migrateDelegator()` never re-checked the flag. A snapshot
  // replay that landed AFTER markNodeMigrated would therefore
  // silently extend `delegatorsInfo`, `stakingStorage.nodeStake`,
  // `stakingStorage.totalStake` and `migratedTotalStake` past the
  // value that markNodeMigrated had already validated against
  // the V8 snapshot's `expectedTotalStake` — corrupting the
  // V10 staking base without reverting anywhere.
  // The fix adds `if (nodeMigrated[id]) revert NodeAlreadyFrozen(id)`
  // at the top of `migrateDelegator`. Pin the new custom error at
  // the ABI layer so a refactor that drops the guard also breaks
  // this test.
  it('bot review r24-3: NodeAlreadyFrozen error is present in the compiled ABI', () => {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
      abi: Array<{ type: string; name?: string; inputs?: Array<{ type: string; name?: string }> }>;
    };

    const frozenErr = artifact.abi.find(
      (entry) => entry.type === 'error' && entry.name === 'NodeAlreadyFrozen',
    );
    expect(
      frozenErr,
      'MigratorV10Staking ABI must expose the NodeAlreadyFrozen error (bot review r24-3)',
    ).to.not.equal(undefined);
    expect(frozenErr!.inputs).to.have.length(1);
    expect(frozenErr!.inputs![0].type).to.equal('uint72');
  });

  it('baseline sanity: other historical migrators DO exist (pins detection)', () => {
    // If this assertion ever fails the detection path is broken, not the
    // product — flags false-positive risk in the two tests above.
    const migrationsDir = path.join(repoRoot, 'contracts', 'migrations');
    const entries = fs.readdirSync(migrationsDir);
    expect(entries).to.include('Migrator.sol');
    expect(entries).to.include('MigratorV8TuningPeriodRewards.sol');
  });
});
