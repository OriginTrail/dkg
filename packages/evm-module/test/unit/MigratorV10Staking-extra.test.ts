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
  const typechainPath = path.join(repoRoot, 'typechain', 'MigratorV10Staking.ts');

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

  it('SPEC-GAP: typechain export for MigratorV10Staking must resolve', () => {
    // Companion assertion: even if the .sol file is stubbed, if the
    // contract never compiles/emits a typechain entry the frontend can't
    // use it. Both must be true for the spec to be satisfied.
    expect(
      fs.existsSync(typechainPath),
      `Expected typechain entry ${typechainPath} to exist after compile. See BUGS_FOUND.md E-11.`,
    ).to.equal(true);
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
