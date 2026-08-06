#!/usr/bin/env node

import { Command } from 'commander';
import { getCliVersion } from './cli-helpers.js';
import { registerIntegrationCommands } from './integrations/commands.js';
import { registerInitCommand } from './commands/init.js';
import { registerAgentCommand } from './commands/agent.js';
import { registerAuthCommand } from './commands/auth.js';
import { registerLifecycleCommands } from './commands/lifecycle.js';
import { registerNetworkCommands } from './commands/network.js';
import { registerKnowledgeCommands } from './commands/knowledge.js';
import { registerKnowledgeAssetCommand } from './commands/knowledge-asset.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerContextGraphCommand } from './commands/context-graph.js';
import { registerAssertionCommand } from './commands/assertion.js';
import { registerOpenclawCommand } from './commands/openclaw.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerHermesCommand } from './commands/hermes.js';
import { registerPrimeAgentCommand } from './commands/prime-agent.js';
import { registerCclCommand } from './commands/ccl.js';
import { registerIndexCommand } from './commands/index-command.js';
import { registerSourceWorkerCommand } from './commands/source-worker.js';
import { registerPcaCommand } from './commands/pca.js';
import { registerPublisherCommand } from './commands/publisher.js';
import { registerEpcisCommand } from './commands/epcis.js';
import { registerNodeOpsCommands } from './commands/node-ops.js';
import { registerQueryCatalogCommand } from './commands/query-catalog.js';
import { registerMaintenanceCommands } from './commands/maintenance.js';
import { registerRandomSamplingCommand } from './commands/random-sampling.js';
import { registerOkfCommand } from './commands/okf.js';

const program = new Command();
program
  .name('dkg')
  .description('DKG V10 testnet node CLI')
  .version(getCliVersion());

registerInitCommand(program);
registerAgentCommand(program);
registerAuthCommand(program);
registerLifecycleCommands(program);
registerNetworkCommands(program);
registerKnowledgeCommands(program);
registerKnowledgeAssetCommand(program);
registerSyncCommand(program);
registerContextGraphCommand(program);
registerAssertionCommand(program);
registerOpenclawCommand(program);
registerMcpCommand(program);
registerHermesCommand(program);
registerPrimeAgentCommand(program);
registerCclCommand(program);
registerIndexCommand(program);
registerSourceWorkerCommand(program);
registerPcaCommand(program);
registerPublisherCommand(program);
registerEpcisCommand(program);
registerNodeOpsCommands(program);
registerQueryCatalogCommand(program);
registerMaintenanceCommands(program);
registerRandomSamplingCommand(program);
registerOkfCommand(program);

// ─── dkg integration ─────────────────────────────────────────────────

registerIntegrationCommands(program);

program.parse();
