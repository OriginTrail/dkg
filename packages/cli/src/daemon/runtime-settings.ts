// The daemon's runtime settings. Each one applies its change to the running
// node and persists only the config keys it owns, so a concurrent CLI edit to
// any other key survives.

import type { LlmSettingsCallbacks } from '@origintrail-official/dkg-node-ui';
import { updateConfigFile, type DkgConfig, type LlmConfig } from '../config.js';
import { createTelemetryRuntime, type TelemetryRuntime } from './telemetry-runtime.js';

/** The telemetry runtime, persisting only the master gate; other telemetry settings stay as they are on disk. */
export function createDaemonTelemetryRuntime(
  opts: Omit<Parameters<typeof createTelemetryRuntime>[0], 'persist'>,
): TelemetryRuntime {
  return createTelemetryRuntime({
    ...opts,
    persist: async (config) => {
      await updateConfigFile((onDisk) => {
        onDisk.telemetry = { ...onDisk.telemetry, enabled: config.telemetry?.enabled ?? false };
      });
    },
  });
}

/** The settings API's LLM callbacks: apply to chat memory, and persist `llm` or remove it when cleared. */
export function createLlmSettings(opts: {
  config: DkgConfig;
  memoryManager: { updateConfig(llm: LlmConfig): void };
  log(message: string): void;
}): LlmSettingsCallbacks {
  const { config, memoryManager, log } = opts;
  return {
    getLlm: () => config.llm,
    setLlm: async (llm) => {
      if (llm) {
        config.llm = llm;
        memoryManager.updateConfig(llm);
        log('LLM config updated via settings');
      } else {
        delete config.llm;
        memoryManager.updateConfig({ apiKey: '' });
        log('LLM config cleared via settings');
      }
      await updateConfigFile((onDisk) => {
        if (llm) onDisk.llm = llm;
        else delete onDisk.llm;
      });
    },
  };
}

/** Apply a shared memory TTL to the running agent, and persist it under its current key and its legacy workspace alias. */
export async function applySharedMemoryTtl(
  node: { config: DkgConfig; agent: { setSharedMemoryTtlMs(ttlMs: number): void } },
  ttlMs: number,
): Promise<void> {
  node.config.sharedMemoryTtlMs = ttlMs;
  node.config.workspaceTtlMs = ttlMs;
  node.agent.setSharedMemoryTtlMs(ttlMs);
  await updateConfigFile((onDisk) => {
    onDisk.sharedMemoryTtlMs = ttlMs;
    onDisk.workspaceTtlMs = ttlMs;
  });
}
