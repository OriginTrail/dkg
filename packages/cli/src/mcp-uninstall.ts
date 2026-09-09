import { detectClients, parseMcpClientSelector, selectMcpClientTargets, type ClientTarget } from './mcp-client-registry.js';
import { inspectRegistration, removeRegistration } from './mcp-client-config.js';

export interface McpUninstallCliOptions {
  yes?: boolean;
  client?: string;
  dryRun?: boolean;
}

export interface McpUninstallDeps {
  detectClients?: typeof detectClients;
  confirmTargets?: typeof confirmUninstallTargets;
  log?: (message: string) => void;
}

/** Uninstall owns its confirmation policy; setup continues to auto-confirm non-TTY runs. */
export async function confirmUninstallTargets(
  targets: readonly ClientTarget[],
  options: { yes: boolean },
): Promise<readonly ClientTarget[]> {
  if (options.yes || targets.length === 0) return targets;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Non-interactive MCP uninstall requires --yes; use --dry-run to preview.');
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const confirmed: ClientTarget[] = [];
  try {
    for (const target of targets) {
      const answer = (await rl.question(`Remove DKG MCP from ${target.name} (${target.displayPath})? [Y/n] `)).trim().toLowerCase();
      if (answer !== 'n' && answer !== 'no') confirmed.push(target);
    }
    return confirmed;
  } finally {
    rl.close();
  }
}

/** Client configuration teardown only; does not initialize or stop a DKG node. */
export async function mcpUninstallAction(
  opts: McpUninstallCliOptions,
  deps: McpUninstallDeps = {},
): Promise<void> {
  const log = deps.log ?? console.log;
  // Validate against the stable catalog before consulting machine state.
  const selector = opts.client !== undefined ? parseMcpClientSelector(opts.client) : undefined;
  const clients = (deps.detectClients ?? detectClients)();
  const selected = selectMcpClientTargets(clients, selector);

  const planned: ClientTarget[] = [];
  const failures: string[] = [];
  for (const target of selected) {
    try {
      if (inspectRegistration(target)) {
        planned.push(target);
        log(`${opts.dryRun ? 'Would remove' : 'Found'} DKG MCP: ${target.name} (${target.displayPath})`);
      }
    } catch (error) {
      failures.push(`${target.name}: ${error instanceof Error ? error.message : 'Unable to read config'}`);
    }
  }
  if (planned.length === 0 && failures.length === 0) {
    log('No DKG MCP registrations found.');
    return;
  }
  if (!opts.dryRun) {
    const confirmed = await (deps.confirmTargets ?? confirmUninstallTargets)(planned, { yes: opts.yes === true });
    for (const target of confirmed) {
      try {
        const removed = removeRegistration(target);
        log(`${removed ? 'Removed DKG MCP from' : 'Already unregistered:'} ${target.name}`);
      } catch (error) {
        failures.push(`${target.name}: ${error instanceof Error ? error.message : 'Unable to write config'}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not remove ${failures.length} client registration(s):\n${failures.join('\n')}`);
  }
}
