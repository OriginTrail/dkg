// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runRfc64PrivateGateArtifactLifecycleV1 } from '../devnet/rfc64-private-catalog/gate-artifact.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

describe('RFC-64 private release gate artifact lifecycle', () => {
  it('replaces a stale PASS before work and publishes sanitized FAIL on early failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc64-private-gate-artifact-'));
    temporaryRoots.push(root);
    const artifactPath = join(root, 'artifacts', 'latest.json');
    await mkdir(join(root, 'artifacts'), { recursive: true });
    await writeFile(artifactPath, JSON.stringify({
      schema: 'dkg-rfc64-private-release-gate-v1',
      status: 'PASS',
      secretMarker: 'prior-pass-must-not-survive',
    }));

    const timestamps = [
      new Date('2026-08-26T00:00:00.000Z'),
      new Date('2026-08-26T00:00:01.000Z'),
    ];
    const sensitiveMessage = 'wallet material must never enter the artifact';
    let startingArtifact: Record<string, unknown> | null = null;

    await expect(runRfc64PrivateGateArtifactLifecycleV1({
      artifactPath,
      sourceRevision: 'A'.repeat(40),
      now: () => timestamps.shift() ?? new Date('2026-08-26T00:00:02.000Z'),
      execute: async () => {
        startingArtifact = JSON.parse(await readFile(artifactPath, 'utf8'));
        throw Object.assign(new Error(sensitiveMessage), { code: 'owner-start-failed' });
      },
    })).rejects.toThrow(sensitiveMessage);

    expect(startingArtifact).toMatchObject({
      status: 'INCOMPLETE',
      phase: 'starting',
      sourceRevision: 'a'.repeat(40),
    });
    const rawFailureArtifact = await readFile(artifactPath, 'utf8');
    expect(rawFailureArtifact).not.toContain('prior-pass-must-not-survive');
    expect(rawFailureArtifact).not.toContain(sensitiveMessage);
    expect(rawFailureArtifact).not.toContain('owner-start-failed');
    expect(JSON.parse(rawFailureArtifact)).toMatchObject({
      schema: 'dkg-rfc64-private-release-gate-v1',
      status: 'FAIL',
      phase: 'failed',
      failure: {
        failureClass: 'gate-execution-failed',
      },
      sourceRevision: 'a'.repeat(40),
    });
  });
});
