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

/**
 * The agent capability a route plugin may use, DERIVED from the canonical daemon context.
 *
 * Derived rather than restated. A hand-written copy of these signatures keeps only whatever someone
 * remembered to synchronize: argument order, content and option types and the result all drift
 * independently, and the plugin dispatcher's cast suppresses the mismatch — so a stale plugin fails
 * at runtime rather than at compile time.
 *
 * That is not hypothetical. The Kafka plugin's copy of `publishAsync` went stale, which is how its
 * jobs came to be owned by the node instead of the authenticated submitter (GH#2270, fixed in
 * #2304). This makes the same drift a build failure.
 *
 * `OmitThisParameter` is load-bearing, not cosmetic: these methods declare an explicit
 * `this: DKGAgent`, so a plain `Pick` yields a capability only a full agent could call. Dropping
 * just the receiver keeps the parameter and result types, which is the drift that matters.
 */
export type PluginAgentCapability = {
  [K in 'publishAsync' | 'query']: OmitThisParameter<DaemonRequestContext['agent'][K]>;
};

export interface RoutePlugin {
  name: string;
  handle(ctx: RequestContext): Promise<void> | void;
}
