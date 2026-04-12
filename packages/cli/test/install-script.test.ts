import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INSTALL_SCRIPT = join(__dirname, '..', '..', '..', 'install.sh');

describe('install.sh validation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dkg-inst-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('install script exists and is executable', async () => {
    expect(existsSync(INSTALL_SCRIPT)).toBe(true);
    const s = await stat(INSTALL_SCRIPT);
    if (process.platform !== 'win32') {
      expect(s.mode & 0o111).toBeGreaterThan(0);
    }
  });

  it('script contains required prerequisite checks', async () => {
    const content = await readFile(INSTALL_SCRIPT, 'utf-8');
    expect(content).toContain('command -v node');
    expect(content).toContain('command -v pnpm');
    expect(content).toContain('command -v git');
  });

  it('script creates correct directory structure markers', async () => {
    const content = await readFile(INSTALL_SCRIPT, 'utf-8');
    expect(content).toContain('SLOT_A');
    expect(content).toContain('SLOT_B');
    expect(content).toContain('$RELEASES_DIR/current');
    expect(content).toContain('"a"');
    expect(content).toContain('active');
  });

  it('script creates dkg wrapper in bin dir', async () => {
    const content = await readFile(INSTALL_SCRIPT, 'utf-8');
    expect(content).toContain('packages/cli/dist/cli.js');
    expect(content).toContain('chmod +x');
  });

  it('script supports DKG_HOME override', async () => {
    const content = await readFile(INSTALL_SCRIPT, 'utf-8');
    expect(content).toContain('DKG_HOME');
  });

  // -------------------------------------------------------------------
  // Regression tests for bugs found during PR review cycles
  // -------------------------------------------------------------------

  it('slot B clone uses --dissociate to prevent repo corruption', async () => {
    const content = await readFile(INSTALL_SCRIPT, 'utf-8');
    expect(content).toContain('--dissociate');
  });

  it('wrapper script resolves DKG_HOME at runtime (not install time)', async () => {
    const content = await readFile(INSTALL_SCRIPT, 'utf-8');
    // The heredoc must use <<'WRAPPER' (quoted) so variables expand at runtime
    expect(content).toContain("<<'WRAPPER'");
  });

  it('script has idempotency checks before git clone', async () => {
    const content = await readFile(INSTALL_SCRIPT, 'utf-8');
    // Should check if .git directory exists before cloning
    expect(content).toContain('.git');
  });

  it('script validates slot entrypoints before skipping initialization', async () => {
    const content = await readFile(INSTALL_SCRIPT, 'utf-8');
    expect(content).toContain('slot_ready');
    expect(content).toContain('packages/cli/dist/cli.js');
    expect(content).toContain('Detected incomplete slots');
  });

  it('stages the current-platform MarkItDown binary into each slot', async () => {
    const content = await readFile(INSTALL_SCRIPT, 'utf-8');
    expect(content).toContain('bundle-markitdown-binaries.mjs');
    expect(content).toContain('--build-current-platform');
  });
});
