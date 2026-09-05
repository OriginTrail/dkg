import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PHASE = [
  { args: ['run', 'typecheck:devnet:rfc64-evidence'] },
  { args: ['run', 'test:devnet:rfc64-evidence'] },
  { args: ['run', 'typecheck:gate0:rfc64-persistence-lifecycle'] },
  // Preserve the generator's existing 20-minute bound; the workflow bounds
  // the entire matrix job separately. The dependency closure is already built.
  { args: ['run', 'test:gate0:rfc64-persistence-lifecycle:generate:only'], timeout: 20 * 60_000 },
  { args: ['run', 'test:gate0:rfc64-persistence-lifecycle:verify'] },
  { args: ['exec', 'tsc', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--types', 'node,vitest/globals', '--skipLibCheck',
    'packages/agent/test/rfc64-inventory-v1-lifecycle.test.ts',
    'packages/agent/test/fixtures/rfc64-inventory-v1-child.ts'] },
];

export function runPersistenceEvidence({ run = spawnSync, pnpm = process.env.npm_execpath } = {}) {
  if (!pnpm) throw new Error('Run through pnpm ci:rfc64-persistence-evidence');
  for (const { args, timeout } of PHASE) {
    // Launch pnpm through Node on both Windows and POSIX, without shell quoting.
    const result = run(process.execPath, [pnpm, ...args], { stdio: 'inherit', timeout });
    if (result.error || result.status !== 0) {
      throw new Error(`Persistence evidence phase failed: pnpm ${args.join(' ')} (${result.error?.message ?? result.status})`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runPersistenceEvidence();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
