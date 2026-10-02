// The daemon's runtime settings. A change is written to the config file first,
// as the value the request set, and applied to the running node only once
// that write has succeeded. Applying it only assigns fields, so it cannot
// fail, and a failed write leaves the node and the file as they were. One
// setting's changes run one at a time, in the order they were requested, so
// the node and the file both end at the latest. Each write edits only the keys
// its setting owns, so a concurrent CLI edit to any other key survives.

import type { LlmSettingsCallbacks } from '@origintrail-official/dkg-node-ui';
import { configEdit, updateConfigFile, type DkgConfig, type LlmConfig } from '../config.js';
import { createTelemetryRuntime, type TelemetryRuntime } from './telemetry-runtime.js';

/**
 * The telemetry runtime, persisting only the master gate; other telemetry
 * settings stay as they are on disk. The runtime orders its own transitions
 * and rolls back an enable it could not persist.
 */
export function createDaemonTelemetryRuntime(
  opts: Omit<Parameters<typeof createTelemetryRuntime>[0], 'persist'>,
): TelemetryRuntime {
  return createTelemetryRuntime({
    ...opts,
    persist: async (config) => {
      const enabled = config.telemetry?.enabled ?? false;
      await updateConfigFile([configEdit(['telemetry', 'enabled'], () => enabled)]);
    },
  });
}

/** The settings API's LLM callbacks: persist `llm`, or remove it when cleared, then apply it to chat memory. */
export function createLlmSettings(opts: {
  config: DkgConfig;
  memoryManager: { updateConfig(llm: LlmConfig): void };
  log(message: string): void;
}): LlmSettingsCallbacks {
  const { config, memoryManager, log } = opts;
  const inOrder = serialQueue();
  return {
    getLlm: () => config.llm,
    setLlm: (requested) => {
      const llm = requested ? { ...requested } : undefined;
      return inOrder(async () => {
        await updateConfigFile([configEdit(['llm'], () => llm)]);
        if (llm) {
          config.llm = llm;
          memoryManager.updateConfig(llm);
          log('LLM config updated via settings');
        } else {
          delete config.llm;
          memoryManager.updateConfig({ apiKey: '' });
          log('LLM config cleared via settings');
        }
      });
    },
  };
}

/** The shared memory TTL setting: persist it under its current key and its legacy workspace alias, then apply it to the running agent. */
export function createSharedMemoryTtlSetting(node: {
  config: DkgConfig;
  agent: { setSharedMemoryTtlMs(ttlMs: number): void };
}): { set(ttlMs: number): Promise<void> } {
  const inOrder = serialQueue();
  return {
    set: (ttlMs) => inOrder(async () => {
      await updateConfigFile([
        configEdit(['sharedMemoryTtlMs'], () => ttlMs),
        configEdit(['workspaceTtlMs'], () => ttlMs),
      ]);
      node.config.sharedMemoryTtlMs = ttlMs;
      node.config.workspaceTtlMs = ttlMs;
      node.agent.setSharedMemoryTtlMs(ttlMs);
    }),
  };
}

/** Run each task once every task queued before it has settled, whether it succeeded or failed. */
function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}
