/**
 * HermesAdapterPlugin — Connects Hermes AI agents to a DKG V10 node.
 *
 * Lightweight adapter following the OpenClaw adapter pattern but simpler:
 * - No channel bridge (Hermes has its own CLI/gateway system)
 * - No game plugin
 * - No write-capture (daemon's importMemories handles entity extraction)
 *
 * The Hermes Python plugin installed into $HERMES_HOME/plugins/dkg persists turns
 * through the daemon's /api/hermes-channel/persist-turn route. Node UI chat
 * health/send/stream dispatch is owned by the DKG daemon integration, not by this
 * package-level plugin.
 */

import type { DaemonPluginApi, HermesAdapterConfig } from './types.js';
import { registerHermesRoutes } from './hermes-routes.js';

export class HermesAdapterPlugin {
  private readonly config: HermesAdapterConfig;
  private initialized = false;

  constructor(config?: HermesAdapterConfig) {
    this.config = { ...config };
  }

  /**
   * Register the Hermes adapter with the daemon.
   *
   * Called by the daemon when loading adapters. Registers HTTP routes
   * and lifecycle hooks.
   */
  register(api: DaemonPluginApi): void {
    if (this.initialized) {
      // Multi-phase init: just log, routes are already registered
      api.logger.debug?.('[hermes] Re-registration skipped (already initialized)');
      return;
    }
    this.initialized = true;

    // Register Hermes provider persistence/status routes.
    registerHermesRoutes(api);
    api.logger.info?.('[hermes] Hermes adapter provider routes registered');

    // Register cleanup hook
    api.registerHook('session_end', async () => {
      api.logger.info?.('[hermes] Daemon shutting down — Hermes adapter cleanup');
    }, { name: 'hermes-adapter-stop' });

    api.logger.info?.('[hermes] Hermes Agent adapter initialized');
  }
}
