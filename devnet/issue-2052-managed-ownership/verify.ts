/**
 * Live managed-Oxigraph ownership gate — verifier (#2052 Stack B2).
 *
 * Enforcement is exception-based, matching the RFC-64 gate harnesses: a failing
 * check throws, so `pnpm test:live:system-record-managed-ownership` exits
 * non-zero and CI goes red. A verdict file that nobody reads cannot be the
 * enforcement mechanism.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MANAGED_OWNERSHIP_VERDICT_SCHEMA_VERSION,
  evaluateManagedOwnership,
  type ManagedOwnershipRawResultV1,
  type ManagedOwnershipVerdictV1,
} from './model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const RAW_ARTIFACT = join(HERE, 'artifacts', 'managed-ownership-result.json');
const VERDICT_ARTIFACT = join(HERE, 'artifacts', 'managed-ownership-verdict.json');

function repositoryHead(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

async function main(): Promise<void> {
  // Pin HEAD on both sides: a verdict attributed to the wrong commit is worse
  // than no verdict, because it certifies code that was never run.
  const sourceCommit = repositoryHead();

  const rawBytes = await readFile(RAW_ARTIFACT);
  const rawArtifactSha256 = `0x${createHash('sha256').update(rawBytes).digest('hex')}`;
  const raw = JSON.parse(rawBytes.toString('utf8')) as ManagedOwnershipRawResultV1;

  const checks = evaluateManagedOwnership(raw);
  const failed = checks.filter((check) => !check.pass);
  if (failed.length > 0) {
    const detail = failed
      .map((check) => `  - ${check.name}${check.detail ? `: ${check.detail}` : ''}`)
      .join('\n');
    throw new Error(
      `managed-ownership gate FAILED (${failed.length} of ${checks.length} checks):\n${detail}`,
    );
  }

  const finalCommit = repositoryHead();
  if (finalCommit !== sourceCommit) {
    throw new Error(
      `repository HEAD changed during verification: ${sourceCommit} -> ${finalCommit}`,
    );
  }

  const verdict: ManagedOwnershipVerdictV1 = {
    schemaVersion: MANAGED_OWNERSHIP_VERDICT_SCHEMA_VERSION,
    verdict: 'pass',
    scope: 'issue #2052 Stack B2 live managed-Oxigraph ownership conformance',
    sourceCommit,
    rawArtifactSha256,
    predecessors: raw.predecessors.map((entry) => ({ id: entry.id, pass: entry.pass })),
    checks: checks.map((check) => ({ name: check.name, pass: true as const })),
  };

  await mkdir(dirname(VERDICT_ARTIFACT), { recursive: true });
  await writeFile(VERDICT_ARTIFACT, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');

  console.log(`[managed-ownership-verifier] raw artifact SHA-256: ${rawArtifactSha256}`);
  console.log(`[managed-ownership-verifier] verdict artifact: ${VERDICT_ARTIFACT}`);
  console.log(
    `[managed-ownership-verifier] PASS: ${checks.length} checks, ` +
      `${raw.predecessors.length} predecessor entries`,
  );
}

await main();
