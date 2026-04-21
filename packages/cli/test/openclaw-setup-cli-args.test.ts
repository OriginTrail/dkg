import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');

// Regression test for PR #228 Codex review #1 (--no-fund backwards-compat).
// Before the adapter-bundling rework, `dkg openclaw setup` delegated to the
// standalone `dkg-openclaw` binary with `allowUnknownOption(true)`, so any
// scripted invocation passing `--no-fund` succeeded. The bundled in-process
// rewrite switched to strict commander options; this test guards against a
// regression where `--no-fund` (or `--fund`) throws `unknown option`.
describe.sequential('dkg openclaw setup — deprecated --no-fund/--fund flags', () => {
  let tmpRoot: string;
  let workspace: string;
  let openclawHome: string;
  let dkgHome: string;

  beforeAll(async () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(
        `CLI entry not found at ${CLI_ENTRY}. Run \`pnpm --filter @origintrail-official/dkg build\` before running this suite.`,
      );
    }

    tmpRoot = await mkdtemp(join(tmpdir(), 'dkg-openclaw-flag-test-'));
    workspace = join(tmpRoot, 'workspace');
    openclawHome = join(tmpRoot, 'openclaw');
    dkgHome = join(tmpRoot, 'dkg');
    await mkdir(workspace, { recursive: true });
    await mkdir(openclawHome, { recursive: true });
    // Seed a minimal openclaw.json so `discoverWorkspace` resolves via the
    // explicit --workspace path and the merge step has a config to work with.
    await writeFile(
      join(openclawHome, 'openclaw.json'),
      JSON.stringify({ plugins: {} }, null, 2) + '\n',
    );
  });

  afterAll(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('accepts --no-fund --dry-run without throwing and emits a deprecation warning', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, 'openclaw', 'setup', '--workspace', workspace, '--no-fund', '--dry-run', '--no-start', '--no-verify'],
      {
        env: {
          ...process.env,
          OPENCLAW_HOME: openclawHome,
          DKG_HOME: dkgHome,
        },
      },
    );

    const combined = `${stdout}\n${stderr}`;
    expect(combined).toContain('--no-fund/--fund is deprecated');
    // DRY RUN marker proves setup actually entered runSetup (not a commander
    // parse-error bail-out).
    expect(combined).toContain('DRY RUN');
  });

  it('accepts --fund --dry-run without throwing and emits a deprecation warning', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, 'openclaw', 'setup', '--workspace', workspace, '--fund', '--dry-run', '--no-start', '--no-verify'],
      {
        env: {
          ...process.env,
          OPENCLAW_HOME: openclawHome,
          DKG_HOME: dkgHome,
        },
      },
    );

    const combined = `${stdout}\n${stderr}`;
    expect(combined).toContain('--no-fund/--fund is deprecated');
    expect(combined).toContain('DRY RUN');
  });

  it('does NOT emit the deprecation warning when neither flag is passed', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, 'openclaw', 'setup', '--workspace', workspace, '--dry-run', '--no-start', '--no-verify'],
      {
        env: {
          ...process.env,
          OPENCLAW_HOME: openclawHome,
          DKG_HOME: dkgHome,
        },
      },
    );

    const combined = `${stdout}\n${stderr}`;
    expect(combined).not.toContain('deprecated');
    expect(combined).toContain('DRY RUN');
  });
});
