/** Compatibility exports; both paths share the same fetcher lifecycle state. */
export {
  createSwmMetaFetcher as createSelectedSwmMetaFetcher,
  SwmMetaTransferOwner as SelectedSwmMetaTransferOwner,
} from './swm-meta-fetcher.js';
export type {
  SwmMetaFetcher as SelectedSwmMetaFetcher,
  SwmMetaContinuation as SelectedSwmMetaContinuation,
} from './swm-meta-fetcher.js';
