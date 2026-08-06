/**
 * Daemon plugin registration.
 *
 * Mirrors HermesAdapterPlugin deliberately: the adapter package registers a
 * package-local status route and a shutdown hook, and nothing else. The chat
 * channel routes (`/api/prime-agent-channel/*`) are DAEMON-owned — the adapter
 * does not serve them, exactly as adapter-hermes does not serve
 * `/api/hermes-channel/*`. Keeping that boundary means the adapter never has to
 * know about node config, auth tokens, or the chat memory manager.
 */

import { registerPrimeAgentRoutes } from './prime-agent-routes.js';
import type { DaemonPluginApi, PrimeAgentAdapterConfig } from './types.js';

export class PrimeAgentAdapterPlugin {
  readonly #config: PrimeAgentAdapterConfig;
  #registered = false;

  constructor(config: PrimeAgentAdapterConfig = {}) {
    this.#config = config;
  }

  get config(): PrimeAgentAdapterConfig {
    return this.#config;
  }

  /** Idempotent: the daemon may load the entry more than once per process. */
  register(api: DaemonPluginApi): void {
    if (this.#registered) {
      api.logger?.debug?.('[dkg-adapter-prime-agent] already registered; skipping');
      return;
    }
    this.#registered = true;

    registerPrimeAgentRoutes(api);

    api.registerHook(
      'session_end',
      () => {
        api.logger?.debug?.('[dkg-adapter-prime-agent] session_end');
      },
      { name: 'prime-agent-adapter-stop' },
    );

    api.logger?.info?.('[dkg-adapter-prime-agent] registered');
  }
}
