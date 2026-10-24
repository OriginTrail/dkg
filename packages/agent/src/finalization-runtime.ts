import type {
  FinalizationLifecycleLogOptions,
  FinalizationLifecycleLogOptionsSource,
} from './finalization-lifecycle-logger.js';
import type {
  FinalizationRecoveryStore,
} from './finalization-recovery-store.js';
import type {
  FinalizationRecoveryStoreSource,
} from './finalization-recovery.js';

/**
 * Agent-owned lifecycle state shared with one stable finalization handler.
 * The agent explicitly attaches persistence and network identity as their
 * lifetimes open, then removes them before the corresponding close boundary.
 */
export class FinalizationRuntime implements
  FinalizationRecoveryStoreSource,
  FinalizationLifecycleLogOptionsSource {
  #recoveryStore: FinalizationRecoveryStore | undefined;
  #lifecycleLogOptions: FinalizationLifecycleLogOptions | undefined;

  attachRecoveryStore(store: FinalizationRecoveryStore): void {
    if (this.#recoveryStore && this.#recoveryStore !== store) {
      throw new Error('Finalization runtime recovery store is already attached');
    }
    this.#recoveryStore = store;
  }

  detachRecoveryStore(): FinalizationRecoveryStore | undefined {
    const store = this.#recoveryStore;
    this.#recoveryStore = undefined;
    return store;
  }

  markStarted(options: FinalizationLifecycleLogOptions): void {
    this.#lifecycleLogOptions = { ...options };
  }

  markStopped(): void {
    this.#lifecycleLogOptions = undefined;
  }

  getRecoveryStore(): FinalizationRecoveryStore | undefined {
    return this.#recoveryStore;
  }

  getLifecycleLogOptions(): FinalizationLifecycleLogOptions | undefined {
    return this.#lifecycleLogOptions;
  }
}
