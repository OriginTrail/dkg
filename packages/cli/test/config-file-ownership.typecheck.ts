import { updateConfigFile } from '../src/config.js';

// A patch sees only the top-level keys its update owns.
void updateConfigFile(['publisher'], (config) => {
  config.publisher = { ...config.publisher, enabled: true };
  // @ts-expect-error apiPort is not a key this update owns.
  config.apiPort = 9200;
});

void updateConfigFile([['telemetry', 'enabled'], 'llm'], (config) => {
  config.telemetry = { ...config.telemetry, enabled: false };
  delete config.llm;
  // @ts-expect-error contextGraphs is not a key this update owns.
  config.contextGraphs = [];
});

// @ts-expect-error An owned key must be a config key.
void updateConfigFile(['publsher'], () => undefined);

// @ts-expect-error A patch runs under the config lock, so it must be synchronous.
void updateConfigFile(['llm'], async (config) => { delete config.llm; });
