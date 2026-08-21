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
 * The admission contract a plugin must satisfy when it enqueues an async publish.
 *
 * Re-exported here rather than restated by each plugin: a hand-copied union cannot be checked
 * against the real agent, so it goes stale silently the moment a variant is added or an address
 * shape is refined — which is exactly how the Kafka lane ended up assigning its submitters' jobs
 * to the node.
 */
export type { PublishAsyncAdmission } from '@origintrail-official/dkg-agent';

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
