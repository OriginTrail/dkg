// Config-file writes behind the daemon's runtime settings. Each one patches
// only the keys its setting owns, so a concurrent CLI edit to any other key
// survives.

import { updateConfigFile, type DkgConfig } from '../config.js';

/** Persist the telemetry master gate; other telemetry settings stay as they are on disk. */
export async function persistTelemetryEnabled(config: DkgConfig): Promise<void> {
  await updateConfigFile((onDisk) => {
    onDisk.telemetry = { ...onDisk.telemetry, enabled: config.telemetry?.enabled ?? false };
  });
}

/** Persist the chat-memory LLM settings, or remove them when cleared. */
export async function persistLlmSettings(llm: DkgConfig['llm'] | null): Promise<void> {
  await updateConfigFile((onDisk) => {
    if (llm) onDisk.llm = llm;
    else delete onDisk.llm;
  });
}

/** Persist the shared memory TTL under its current key and its legacy workspace alias. */
export async function persistSharedMemoryTtl(ttlMs: number): Promise<void> {
  await updateConfigFile((onDisk) => {
    onDisk.sharedMemoryTtlMs = ttlMs;
    onDisk.workspaceTtlMs = ttlMs;
  });
}
