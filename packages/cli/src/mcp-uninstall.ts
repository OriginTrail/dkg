import { confirmPlan, detectClients, removeRegistration, type PlannedItem } from './mcp-setup.js';

export interface McpUninstallCliOptions {
  yes?: boolean;
  client?: string;
  dryRun?: boolean;
}

export interface McpUninstallDeps {
  detectClients?: typeof detectClients;
  confirmPlan?: typeof confirmPlan;
  log?: (message: string) => void;
}

function clientKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Client configuration teardown only; does not initialize or stop a DKG node. */
export async function mcpUninstallAction(
  opts: McpUninstallCliOptions,
  deps: McpUninstallDeps = {},
): Promise<void> {
  const log = deps.log ?? console.log;
  const clients = [...new Map((deps.detectClients ?? detectClients)()
    .map((target) => [target.configPath, target])).values()];
  const selected = opts.client
    ? clients.filter((target) => clientKey(target.name) === clientKey(opts.client!))
    : clients;
  if (opts.client && clients.length > 0 && selected.length === 0) {
    throw new Error(`No detected client matches "${opts.client}". Available: ${clients.map((target) => clientKey(target.name)).join(', ')}`);
  }

  const planned: PlannedItem[] = [];
  const failures: string[] = [];
  for (const target of selected) {
    try {
      if (removeRegistration(target, true)) {
        planned.push({ s: { target, state: 'registered', current: null }, action: 'remove' });
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
    const confirmed = await (deps.confirmPlan ?? confirmPlan)(planned, {
      yes: opts.yes === true, requireYesInNonTty: true,
    });
    for (const item of confirmed) {
      if (item.action === 'skip') continue;
      try {
        const removed = removeRegistration(item.s.target);
        log(`${removed ? 'Removed DKG MCP from' : 'Already unregistered:'} ${item.s.target.name}`);
      } catch (error) {
        failures.push(`${item.s.target.name}: ${error instanceof Error ? error.message : 'Unable to write config'}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not remove ${failures.length} client registration(s):\n${failures.join('\n')}`);
  }
}
