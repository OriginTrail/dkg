import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

describe('KA lifecycle log proof artifact', () => {
  it('runs the devnet proof script and preserves metadata, publish, and grep artifacts', () => {
    const artifactDir = join(
      repoRoot,
      '.devnet',
      'ka-lifecycle-log-proof',
      `vitest-${Date.now().toString(36)}`,
    );

    execFileSync(join(repoRoot, 'scripts/devnet-ka-lifecycle-log-proof.sh'), [], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ARTIFACT_DIR: artifactDir,
      },
      stdio: 'pipe',
      timeout: 600_000,
    });

    const metadataPath = join(artifactDir, 'metadata.txt');
    const publishPath = join(artifactDir, 'publish.txt');
    const grepPath = join(artifactDir, 'grep.txt');
    expect(existsSync(metadataPath)).toBe(true);
    expect(existsSync(publishPath)).toBe(true);
    expect(existsSync(grepPath)).toBe(true);

    const metadata = readFileSync(metadataPath, 'utf8');
    const grep = readFileSync(grepPath, 'utf8');
    const assetUal = /^assetUal=(.+)$/m.exec(metadata)?.[1];
    expect(assetUal).toMatch(/^did:dkg:/);
    expect(grep).toContain(`assetUal=${assetUal}`);
    for (const token of [
      'stage=identity',
      'stage=wm',
      'stage=swm_share',
      'stage=storage_ack',
      'stage=chain',
      'stage=vm',
      'stage=finalization',
      'stage=sync',
      'stage=reconcile',
      'role=publisher',
      'role=receiver',
      'role=sync',
      'event=storage_ack_signed',
      'event=finalization_applied',
      'event=sync_apply',
      'event=reconcile_promote',
    ]) {
      expect(grep).toContain(token);
    }
  });
});
