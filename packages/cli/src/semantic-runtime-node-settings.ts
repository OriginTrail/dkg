import type { SemanticRuntimeConfig } from '@origintrail-official/dkg-semantic-runtime';

export interface SemanticRuntimeNodeSettings {
  /**
   * Default-off Rust/Wasm semantic runtime. The daemon opt-in starts the
   * integrity/watchdog/recovery partition only; graph activation and protected
   * adapters still require explicit trusted host wiring.
   */
  semanticRuntime?: SemanticRuntimeConfig;
}
