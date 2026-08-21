// Public surface for route plugins. The only module a plugin imports from; breaking changes are semver-major.

export {
  jsonResponse,
  readBody,
  readBodyBuffer,
  MAX_BODY_BYTES,
  SMALL_BODY_BYTES,
} from './http-utils.js';

import type {
  AsyncPublisherAvailability,
  PublisherRuntime,
} from '../publisher-runner.js';
import type { RequestContext as DaemonRequestContext } from './routes/context.js';

/**
 * The agent capability a route plugin may use, derived from the canonical daemon context.
 *
 * Derived rather than restated: a hand-written copy keeps only whatever someone remembered to
 * sync. Argument order, content and option types and the result all drift independently, and
 * the plugin dispatcher's cast suppresses the mismatch — so a stale plugin fails at runtime
 * instead of at compile time. That is how the Kafka lane came to assign its submitters' jobs to
 * the node while still type-checking.
 */
//
// `OmitThisParameter` is required, not cosmetic: these methods are declared with an explicit
// `this: DKGAgent`, so a plain `Pick` produces a capability nobody but a full agent can call.
// Dropping only the receiver keeps the parameter and result types — which is the drift that
// actually matters — while letting a plugin hold the narrow surface.
export type PluginAgentCapability = {
  [K in 'publishAsync' | 'query']: OmitThisParameter<DaemonRequestContext['agent'][K]>;
};

/**
 * Plugin-only view of the canonical daemon context. The deprecated aliases are
 * materialized by the plugin dispatcher, so built-in routes cannot accidentally
 * treat them as independent lifecycle state.
 */
export type RequestContext = DaemonRequestContext & {
  /** @deprecated Use publisherState.runtime. */
  publisherRuntime: PublisherRuntime | null;
  /** @deprecated Use publisherState.availability. */
  publisherAvailability: AsyncPublisherAvailability;
};

export interface RoutePlugin {
  name: string;
  handle(ctx: RequestContext): Promise<void> | void;
}
