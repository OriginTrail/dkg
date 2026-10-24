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
  /** @deprecated Use `actor.authentication.acceptedToken`. */
  readonly requestToken: string | undefined;
  /** @deprecated Use publisherState.runtime. */
  publisherRuntime: PublisherRuntime | null;
  /** @deprecated Use publisherState.availability. */
  publisherAvailability: AsyncPublisherAvailability;
};

export interface RoutePlugin {
  name: string;
  handle(ctx: RequestContext): Promise<void> | void;
}
