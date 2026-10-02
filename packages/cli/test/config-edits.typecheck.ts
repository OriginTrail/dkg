import { configEdit, configValues, updateConfigFile } from '../src/config.js';

// An edit's path is a config key, or a key and one key under it, and its
// update sees and returns only the value there.
void updateConfigFile([
  configEdit(['telemetry', 'enabled'], () => true),
  configEdit(['localAgentIntegrations', 'hermes'], (entry) => ({ ...entry, enabled: false })),
  configEdit(['contextGraphs'], (graphs) => [...(graphs ?? []), 'cg']),
  configEdit(['publisher'], (publisher) => ({ ...publisher, enabled: true })),
  configEdit(['llm'], () => undefined),
  configEdit(['openclawAdapter'], () => undefined),
  ...configValues({ name: 'node', apiPort: 9200, relay: undefined }),
]);

// @ts-expect-error A misspelled nested key is not a config path.
configEdit(['telemetry', 'enabledd'], () => true);

// @ts-expect-error A misspelled key is not a config path.
configEdit(['publsher'], () => undefined);

// @ts-expect-error Paths stop one key below the top level.
configEdit(['telemetry', 'logs', 'enabled'], () => true);

// @ts-expect-error A key that holds a scalar has nothing under it.
configEdit(['name', 'length'], () => 1);

// @ts-expect-error The update returns the type at its path.
configEdit(['telemetry', 'enabled'], () => 'yes');

// @ts-expect-error The update sees only its value, not the keys beside it.
configEdit(['telemetry', 'enabled'], (enabled) => enabled?.logs);

// @ts-expect-error An update runs under the config lock, so it must be synchronous.
configEdit(['llm'], async () => undefined);

// @ts-expect-error configValues takes config keys only.
configValues({ nmae: 'node' });

// @ts-expect-error An edit is made by configEdit or configValues, never built by hand.
void updateConfigFile([{ path: ['telemetry', 'enabled'], update: () => 'yes' }]);
