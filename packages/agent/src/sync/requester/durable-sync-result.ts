import type { InitializedDurableSyncResult } from '../durable-progress.js';
import type { ExactAssetResponderCapability, ExactDurableFetchDisposition } from './exact-durable-fetch.js';

export interface DetailedDurableSyncResult {
  /** Assets whose normal atomic materialization completed, including a partial exact run. */
  readonly committedExactAssetUals?: readonly string[];
  readonly result: InitializedDurableSyncResult;
  /** Present only when this physical run used an exact-asset filter. */
  readonly exactFetchDisposition?: ExactDurableFetchDisposition;
  /** Present when a clean legacy response proved the exact filter was ignored. */
  readonly exactResponderCapability?: ExactAssetResponderCapability;
}


/** Do not expose owner policy or invocation-local authentication evidence to ordinary callers. */
export function physicalDurableSyncResult(detailed: DetailedDurableSyncResult): DetailedDurableSyncResult {
  return {
    result: detailed.result,
    ...(detailed.committedExactAssetUals === undefined ? {} : { committedExactAssetUals: detailed.committedExactAssetUals }),
    ...(detailed.exactFetchDisposition === undefined
      ? {}
      : { exactFetchDisposition: detailed.exactFetchDisposition }),
    ...(detailed.exactResponderCapability === undefined
      ? {}
      : { exactResponderCapability: detailed.exactResponderCapability }),
  };
}
