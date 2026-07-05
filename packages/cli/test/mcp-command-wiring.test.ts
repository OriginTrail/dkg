import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

const mocks = vi.hoisted(() => {
  const state = { dkgHome: '' };
  return {
    state,
    loadNetworkConfig: vi.fn(),
    ensureDkgNodeConfig: vi.fn(),
    startDaemon: vi.fn(),
    fundWalletsBestEffort: vi.fn(),
    findDkgMonorepoRoot: vi.fn(() => null),
    resolveDkgConfigHome: vi.fn(() => state.dkgHome),
    mcpSetupAction: vi.fn(async (_opts: unknown, deps: {
      afterConfigBootstrap?: (dkgHome: string) => Promise<unknown>;
    }) => {
      if (!deps.afterConfigBootstrap) {
        throw new Error('missing afterConfigBootstrap');
      }
      await deps.afterConfigBootstrap(state.dkgHome);
    }),
  };
});

vi.mock('@origintrail-official/dkg-adapter-openclaw', () => ({
  loadNetworkConfig: mocks.loadNetworkConfig,
  startDaemon: mocks.startDaemon,
}));

vi.mock('@origintrail-official/dkg-core', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-core')>(
    '@origintrail-official/dkg-core',
  );
  return {
    ...actual,
    ensureDkgNodeConfig: mocks.ensureDkgNodeConfig,
    fundWalletsBestEffort: mocks.fundWalletsBestEffort,
    findDkgMonorepoRoot: mocks.findDkgMonorepoRoot,
    resolveDkgConfigHome: mocks.resolveDkgConfigHome,
  };
});

vi.mock('../src/mcp-setup.js', () => ({
  mcpSetupAction: mocks.mcpSetupAction,
}));

const [{ registerMcpCommand }, { dashboardCredentialsPath }] = await Promise.all([
  import('../src/commands/mcp.js'),
  import('../src/daemon/dashboard-credentials.js'),
]);

function captureConsole(key: 'error' | 'warn') {
  const calls: unknown[][] = [];
  const original = console[key];
  console[key] = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    text: () => calls.map((args) => args.join(' ')).join('\n'),
    restore: () => {
      console[key] = original;
    },
  };
}

function createMcpProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerMcpCommand(program);
  return program;
}

describe('dkg mcp command wiring', () => {
  let tempDir: string;
  let warnCapture: ReturnType<typeof captureConsole>;
  let errorCapture: ReturnType<typeof captureConsole>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-mcp-command-wiring-${randomBytes(4).toString('hex')}`);
    await mkdir(tempDir, { recursive: true });
    mocks.state.dkgHome = tempDir;
    warnCapture = captureConsole('warn');
    errorCapture = captureConsole('error');
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: string | number | null) => {
        throw new Error(`process.exit:${code}`);
      }) as never);
  });

  afterEach(async () => {
    warnCapture.restore();
    errorCapture.restore();
    exitSpy.mockRestore();
    vi.clearAllMocks();
    mocks.state.dkgHome = '';
    await rm(tempDir, { recursive: true, force: true });
  });

  it('#1451: wires dashboard credential bootstrap through the best-effort setup helper', async () => {
    await writeFile(
      dashboardCredentialsPath(tempDir),
      '{"version":1,"password":"plaintext"}\n',
    );

    await createMcpProgram().parseAsync(
      ['mcp', 'setup', '--no-start', '--no-fund', '--no-verify'],
      { from: 'user' },
    );

    expect(mocks.mcpSetupAction).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorCapture.text()).toBe('');
    const warnings = warnCapture.text();
    expect(warnings).toContain('[setup] Could not create dashboard login credentials');
    expect(warnings).toContain(`DKG_HOME=${tempDir}`);
    expect(warnings).toContain('dkg auth dashboard reset-password');
  });
});
