import type { ChatMemoryManager } from '@origintrail-official/dkg-node-ui';
import { mutableConfigSnapshot, type DkgConfigStore } from '../daemon-config-store.js';

/** The daemon and HTTP integration tests use this same settings adapter. */
export function createDaemonLlmSettings(
  configStore: DkgConfigStore,
  memoryManager: Pick<ChatMemoryManager, 'updateConfig'>,
  log: (message: string) => void,
) {
  return {
    getLlm: () => configStore.current.llm,
    setLlm: async (llm: { apiKey: string; model?: string; baseURL?: string } | null): Promise<void> => {
      const requested = llm ? { ...llm } : null;
      await configStore.update(current => {
        const next = mutableConfigSnapshot(current);
        if (requested) next.llm = requested;
        else delete next.llm;
        return next;
      }, (next, previous) => ({
        apply: () => memoryManager.updateConfig(next.llm ? { ...next.llm } : { apiKey: '' }),
        rollback: () => memoryManager.updateConfig(previous.llm ? { ...previous.llm } : { apiKey: '' }),
      }));
      log(requested ? 'LLM config updated via settings' : 'LLM config cleared via settings');
    },
  };
}
