import { Command } from 'commander';

type PrimeAgentAdapterModule = Record<string, unknown>;
type PrimeAgentAdapterAction = (opts: Record<string, unknown>) => Promise<void>;

async function importPrimeAgentAdapterModule(): Promise<PrimeAgentAdapterModule> {
  // Keep adapter loading lazy so basic CLI commands remain usable even when an
  // optional integration package is unavailable in a partial development tree.
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<PrimeAgentAdapterModule>;
  return dynamicImport('@origintrail-official/dkg-adapter-prime-agent');
}

function resolvePrimeAgentAdapterAction(
  adapter: PrimeAgentAdapterModule,
  commandName: string,
  candidates: readonly string[],
): PrimeAgentAdapterAction {
  for (const candidate of candidates) {
    const value = adapter[candidate];
    if (typeof value === 'function') return value as PrimeAgentAdapterAction;
  }
  throw new Error(
    `@origintrail-official/dkg-adapter-prime-agent does not export a ${commandName} helper`,
  );
}

async function loadPrimeAgentAdapterAction(
  commandName: string,
  candidates: readonly string[],
): Promise<PrimeAgentAdapterAction> {
  try {
    const adapter = await importPrimeAgentAdapterModule();
    return resolvePrimeAgentAdapterAction(adapter, commandName, candidates);
  } catch (err) {
    throw new Error(
      `Prime Agent adapter is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function addProfileOptions(command: Command): Command {
  return command
    .option('--profile <name>', 'Prime Agent profile label')
    .option('--agent-dir <path>', 'Prime Agent config directory (default: ~/.prime/agent)')
    .option('--dry-run', 'Preview changes without writing anything');
}

function adapterOptions(commandName: string, opts: Record<string, unknown>): Record<string, unknown> {
  if (commandName === 'setup' || commandName === 'reconnect') return opts;
  const { profile, ...rest } = opts;
  return { ...rest, ...(typeof profile === 'string' ? { profileName: profile } : {}) };
}

/** Register `dkg prime-agent` lifecycle and recovery commands. */
export function registerPrimeAgentCommand(program: Command): void {
  const primeAgent = program.command('prime-agent').description('Prime Agent adapter management');

  addProfileOptions(
    primeAgent
      .command('setup')
      .description('Install and configure the Prime Agent DKG extension')
      .option('--daemon-url <url>', 'DKG daemon URL')
      .option('--dkg-home <path>', 'DKG node home used to source auth.token')
      .option('--memory-mode <mode>', 'Memory mode: hooks or tools-only')
      .option('--context-graph <id>', 'Default context graph')
      .option('--memory-assertion <name>', 'Default memory assertion')
      .option('--preserve-settings', 'Refuse to replace a stale DKG extension entry')
      .option('--no-verify', 'Skip post-setup verification'),
  ).action(async (opts) => {
    const action = await loadPrimeAgentAdapterAction('setup', ['runSetup', 'setup']);
    await action(adapterOptions('setup', opts));
  });

  for (const [commandName, candidates, description] of [
    ['status', ['runStatus', 'status'], 'Show Prime Agent adapter status'],
    ['verify', ['runVerify', 'verify'], 'Verify Prime Agent adapter configuration'],
    ['doctor', ['runDoctor', 'doctor'], 'Diagnose Prime Agent adapter issues'],
    ['disconnect', ['runDisconnect', 'disconnect'], 'Disconnect the Prime Agent adapter'],
    ['reconnect', ['runReconnect', 'reconnect'], 'Reconnect the Prime Agent adapter'],
    ['uninstall', ['runUninstall', 'uninstall'], 'Remove Prime Agent adapter wiring'],
  ] as const) {
    const command = addProfileOptions(primeAgent.command(commandName).description(description));
    if (commandName === 'reconnect') {
      command
        .option('--daemon-url <url>', 'DKG daemon URL')
        .option('--dkg-home <path>', 'DKG node home used to source auth.token')
        .option('--memory-mode <mode>', 'Memory mode: hooks or tools-only')
        .option('--no-verify', 'Skip post-reconnect verification');
    }
    command.action(async (opts) => {
      const action = await loadPrimeAgentAdapterAction(commandName, candidates);
      await action(adapterOptions(commandName, opts));
    });
  }
}
