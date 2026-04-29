/**
 * MigratorV10Staking-extra.test.ts — audit coverage (E-11).
 *
 * Finding E-11 (MEDIUM, SPEC-GAP):
 *   "MigratorV10Staking does not exist in the repo. Spec mentions
 *    zero-token migration of V8 delegator state."
 *
 * This file pins the contract's existence + compiled artifact + the
 * critical custom-error guards on `migrateDelegator()`. The earlier
 * "baseline sanity" assertion that other historical migrators DO
 * exist was dropped because main has deliberately removed them as
 * part of the V10 fresh-chain bring-up (see `chore(evm): remove
 * orphan + out-of-scope contracts from V10.0 release`); enumerating
 * them no longer applies. The remaining assertions stay valid
 * because our branch still ships `MigratorV10Staking.sol` for the
 * zero-token V8 → V10 delegator state replay.
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
    // Spec says zero-token V8 → V10 delegator migration must ship as
    // `MigratorV10Staking`. Keep this assertion as a regression pin
    // so a future cleanup that drops the file is caught immediately.
    expect(
      fs.existsSync(contractPath),
      `Expected ${contractPath} to exist (V10 zero-token migration).`,
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
      `Expected compiled artifact ${artifactPath} to exist after compile.`,
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
  it('UnknownIdentityId error is present in the compiled ABI', () => {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
      abi: Array<{ type: string; name?: string; inputs?: Array<{ type: string; name?: string }> }>;
    };

    const unknownIdErr = artifact.abi.find(
      (entry) => entry.type === 'error' && entry.name === 'UnknownIdentityId',
    );
    expect(
      unknownIdErr,
      'MigratorV10Staking ABI must expose the UnknownIdentityId error',
    ).to.not.equal(undefined);
    expect(unknownIdErr!.inputs).to.have.length(1);
    expect(unknownIdErr!.inputs![0].type).to.equal('uint72');
  });

  // Before this fix,
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
  it('NodeAlreadyFrozen error is present in the compiled ABI', () => {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
      abi: Array<{ type: string; name?: string; inputs?: Array<{ type: string; name?: string }> }>;
    };

    const frozenErr = artifact.abi.find(
      (entry) => entry.type === 'error' && entry.name === 'NodeAlreadyFrozen',
    );
    expect(
      frozenErr,
      'MigratorV10Staking ABI must expose the NodeAlreadyFrozen error',
    ).to.not.equal(undefined);
    expect(frozenErr!.inputs).to.have.length(1);
    expect(frozenErr!.inputs![0].type).to.equal('uint72');
  });

  // Before the fix, `finalizeMigration()` only required
  // `onlyOwnerOrMultiSigOwner` and irreversibly flipped
  // `migrationFinalized = true` even when `initiateMigration` had
  // never been called. Because every write surface (`migrateDelegator`,
  // `markNodeMigrated`) is gated by `whenInitiated` (which BANS calls
  // when `migrationFinalized` is true) AND `initiateMigration` itself
  // reverts with `MigrationAlreadyFinalized` once finalised, the
  // single fat-finger would brick the migrator with no recovery
  // path — only redeployment can unfreeze it. The fix requires the
  // migration to be active (initiated AND not yet finalised) before
  // finalisation succeeds. We pin the source-level guard at the
  // statement granularity so a refactor that drops it can't slip
  // back in unnoticed.
  it('finalizeMigration requires migrationInitiated before flipping the kill switch', () => {
    const src = fs.readFileSync(contractPath, 'utf8');

    // Locate the body of finalizeMigration without depending on
    // exact whitespace.
    const fnMatch = src.match(/function\s+finalizeMigration\s*\([^)]*\)\s*[^{]*\{([^}]*)\}/);
    expect(
      fnMatch,
      'finalizeMigration must exist in MigratorV10Staking.sol',
    ).to.not.equal(null);
    const body = fnMatch![1];

    // The new guard MUST revert with MigrationNotInitiated when the
    // migration was never started.
    expect(
      /if\s*\(\s*!\s*migrationInitiated\s*\)\s*revert\s+MigrationNotInitiated\s*\(\s*\)\s*;/.test(body),
      'finalizeMigration must `revert MigrationNotInitiated()` when migrationInitiated is false',
    ).to.equal(true);

    // And it MUST also revert with MigrationAlreadyFinalized when
    // already finalised — keeps finalize idempotent (no double flip).
    expect(
      /if\s*\(\s*migrationFinalized\s*\)\s*revert\s+MigrationAlreadyFinalized\s*\(\s*\)\s*;/.test(body),
      'finalizeMigration must `revert MigrationAlreadyFinalized()` when already finalised',
    ).to.equal(true);
  });

  it('baseline sanity: contracts/migrations/ contains MigratorV10Staking.sol (pins detection)', () => {
    // Meta-test: confirms `fs.readdirSync` itself sees the migrations
    // directory the way the SPEC-GAP test above expects. The legacy
    // migrators (Migrator.sol, MigratorV6*, MigratorV8*, MigratorM1V8*)
    // were removed from this directory by main's V10 cleanup commit
    // (`468b739d chore(evm): remove orphan + out-of-scope contracts
    // from V10.0 release`), so we now pin only the file we still ship.
    // If this assertion ever fails the detection path is broken, not
    // the product — flags false-positive risk in the SPEC-GAP test.
    const migrationsDir = path.join(repoRoot, 'contracts', 'migrations');
    const entries = fs.readdirSync(migrationsDir);
    expect(entries).to.include('MigratorV10Staking.sol');
  });
});
